import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { GitPreparer } from "@/src/server/git";
import { ensureDataPaths, resolveDataPaths } from "@/src/server/paths";
import type { MergeRequestSnapshot, ProjectRecord } from "@/src/shared/types";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout;
}

async function repositoryFixture(options: { secret?: boolean; sourceBranch?: string; environmentSecret?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-real-git-"));
  roots.push(root);
  const repository = path.join(root, "origin");
  await git(root, "init", "--initial-branch=main", repository);
  await git(repository, "config", "user.email", "reviewx@example.test");
  await git(repository, "config", "user.name", "ReviewX Test");
  await writeFile(path.join(repository, "base.txt"), "base\n", "utf8");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "base");
  const sourceBranch = options.sourceBranch ?? "feature";
  await git(repository, "switch", "-c", sourceBranch);
  await writeFile(path.join(repository, "base.txt"), "base\nfeature line\n", "utf8");
  await writeFile(path.join(repository, "a.txt"), options.secret ? `${"ghp_"}${"abcdefghijklmnopqrstuvwxyz123456"}\n` : "alpha\n", "utf8");
  await writeFile(path.join(repository, "z.txt"), "zulu\n", "utf8");
  await writeFile(path.join(repository, "large.txt"), "L".repeat(70 * 1024), "utf8");
  await writeFile(path.join(repository, "invalid.bin"), Buffer.from([0xff, 0xfe, 0xfd, 0x00]));
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "feature");

  const dataRoot = path.join(root, "local-app-data");
  const paths = resolveDataPaths({ LOCALAPPDATA: dataRoot });
  ensureDataPaths(paths);
  const cloneUrl = "https://reviewx.invalid/repo.git";
  const fileUrl = pathToFileURL(repository).href;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${fileUrl}.insteadOf`,
    GIT_CONFIG_VALUE_0: cloneUrl,
    ...(options.environmentSecret ? { CODEHUB_TOKEN: options.environmentSecret } : {}),
  };
  const project: ProjectRecord = {
    id: "101", name: "team/repo", cloneUrl, addedAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
  };
  const details: MergeRequestSnapshot = {
    projectId: "101", iid: "7", title: "Feature", state: "open", updatedAt: "2026-09-02T00:00:00Z",
    sourceBranch, targetBranch: "main",
  };
  return { paths, environment, project, details };
}

describe("Git review preparation", () => {
  test("pins both revisions, writes an untruncated three-dot diff, and includes only bounded sorted UTF-8 snapshots", async () => {
    const fixture = await repositoryFixture();
    const prepared = await new GitPreparer(fixture.paths, fixture.environment).prepare(
      fixture.project,
      fixture.details,
      new AbortController().signal,
    );
    const patch = await readFile(prepared.patchPath, "utf8");
    const bundle = await readFile(prepared.bundlePath, "utf8");
    expect(prepared.sourceSha).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(prepared.targetSha).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(prepared.sourceSha).not.toBe(prepared.targetSha);
    expect(patch).toContain("feature line");
    expect(patch).toContain("diff --git");
    expect(bundle).toContain(patch);
    expect(bundle.indexOf('--- SOURCE FILE "a.txt" ---')).toBeLessThan(bundle.indexOf('--- SOURCE FILE "z.txt" ---'));
    expect(bundle).toContain('--- OMITTED "large.txt": source context size limit ---');
    expect(bundle).toContain('--- OMITTED "invalid.bin": binary content ---');
    expect(bundle).not.toContain(".git/config");

    const temporaryRoot = prepared.rootDirectory;
    await prepared.cleanup();
    await prepared.cleanup();
    await expect(stat(temporaryRoot)).rejects.toThrow();
  }, 30_000);

  test("rejects credentials before OpenCode input exists and cleans the temporary workspace", async () => {
    const fixture = await repositoryFixture({ secret: true });
    await expect(new GitPreparer(fixture.paths, fixture.environment).prepare(
      fixture.project,
      fixture.details,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "SENSITIVE_REVIEW_INPUT" });
    expect(await readdir(fixture.paths.workspaces)).toEqual([]);
  }, 30_000);

  test("scans review metadata as part of the final bundle credential boundary", async () => {
    const secretBranch = "feature-secret-branch";
    const fixture = await repositoryFixture({ sourceBranch: secretBranch, environmentSecret: secretBranch });
    await expect(new GitPreparer(fixture.paths, fixture.environment).prepare(
      fixture.project,
      fixture.details,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "SENSITIVE_REVIEW_INPUT" });
    expect(await readdir(fixture.paths.workspaces)).toEqual([]);
  }, 30_000);

  test("rejects credential-bearing or non-HTTPS remotes before invoking Git", async () => {
    const fixture = await repositoryFixture();
    const preparer = new GitPreparer(fixture.paths, fixture.environment);
    for (const cloneUrl of ["http://reviewx.invalid/repo.git", "https://user:password@reviewx.invalid/repo.git", "https://reviewx.invalid/repo.git?token=secret"]) {
      await expect(preparer.prepare({ ...fixture.project, cloneUrl }, fixture.details, new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_GIT_REMOTE" });
    }
    expect(await readdir(fixture.paths.workspaces)).toEqual([]);
  }, 30_000);
});
