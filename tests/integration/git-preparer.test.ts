import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { GitPreparer } from "@/src/server/integrations/git";
import { ensureDataPaths, resolveDataPaths } from "@/src/server/platform/paths";
import type { MergeRequestSnapshot, ProjectRecord } from "@/src/shared/types";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout;
}

async function repositoryFixture(options: { secret?: boolean; sourceBranch?: string; environmentSecret?: string; supported?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-real-git-"));
  roots.push(root);
  const repository = path.join(root, "origin");
  await git(root, "init", "--initial-branch=main", repository);
  await git(repository, "config", "user.email", "reviewx@example.test");
  await git(repository, "config", "user.name", "ReviewX Test");
  await writeFile(path.join(repository, "base.txt"), "base\n", "utf8");
  await writeFile(path.join(repository, "deleted.txt"), "delete me\n");
  await writeFile(path.join(repository, "old.txt"), "rename me\n");
  await writeFile(path.join(repository, "caller.txt"), "unchanged caller\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "base");
  const sourceBranch = options.sourceBranch ?? "feature";
  await git(repository, "switch", "-c", sourceBranch);
  await writeFile(path.join(repository, "base.txt"), "base\nfeature line\n", "utf8");
  await writeFile(path.join(repository, "a.txt"), options.secret ? `${"ghp_"}${"abcdefghijklmnopqrstuvwxyz123456"}\n` : "alpha\n", "utf8");
  await writeFile(path.join(repository, "z.txt"), "zulu\n", "utf8");
  await writeFile(path.join(repository, "large.txt"), options.supported ? "line\n".repeat(1000) : "L".repeat(70 * 1024), "utf8");
  if (!options.supported) await writeFile(path.join(repository, "invalid.bin"), Buffer.from([0xff, 0xfe, 0xfd, 0x00]));
  await git(repository, "rm", "deleted.txt");
  await git(repository, "mv", "old.txt", "renamed.txt");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "feature");

  await git(repository, "switch", "main");
  await writeFile(path.join(repository, "target.txt"), "target advances\n");
  await git(repository, "add", "."); await git(repository, "commit", "-m", "target advanced");

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
    webUrl: "https://codehub.example/project/home",
    id: "101", name: "team/repo", cloneUrl, addedAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
  };
  const details: MergeRequestSnapshot = {
    projectId: "101", iid: "7", title: "Feature", state: "open", updatedAt: "2026-09-02T00:00:00Z",
    sourceBranch, targetBranch: "main",
  };
  return { paths, environment, project, details, repository };
}

describe("Git review preparation", () => {
  test("fixed B differs from T, stable re-review, rename/deletion and large paged blobs", async () => {
    const f = await repositoryFixture({ supported: true }); const signal = new AbortController().signal;
    const first = await new GitPreparer(f.paths, f.environment).prepare(f.project, f.details, signal);
    const second = await new GitPreparer(f.paths, f.environment).prepare(f.project, f.details, signal);
    try {
      expect(first.baseSha).not.toBe(first.targetSha);
      expect(first.context.scope.scopeHash).toBe(second.context.scope.scopeHash);
      const changes = first.context.scope.changes;
      expect(changes.find(c => c.type === "D")?.oldPath).toBe("deleted.txt");
      expect(changes.find(c => c.type === "R")).toMatchObject({ oldPath: "old.txt", newPath: "renamed.txt" });
      expect(changes.some(c => c.newPath === "target.txt")).toBe(false);
      expect((await first.context.read("source", "large.txt", signal))).toHaveLength(5);
      expect(first.context.diff(changes.find(c => c.newPath === "large.txt")!.changeId).length).toBeGreaterThan(1);
      expect((await first.context.read("source", "caller.txt", signal))[0].content).toContain("unchanged");
      expect((await first.context.search("source", "unchanged", 0, signal)).matches).toEqual([{ path: "caller.txt", line: 1 }]);
      await expect(first.context.read("source", "deleted.txt", signal)).rejects.toThrow();
      expect((await first.context.read("base", "deleted.txt", signal))[0].content).toBe("delete me\n");
    } finally { await first.cleanup(); await second.cleanup(); }
  }, 30_000);

  test("pins revisions and marks unreviewable binary and oversized lines", async () => {
    const fixture = await repositoryFixture();
    const prepared = await new GitPreparer(fixture.paths, fixture.environment).prepare(
      fixture.project,
      fixture.details,
      new AbortController().signal,
    );
    expect(prepared.sourceSha).toMatch(/^[0-9a-f]{40,64}$/u);
    const scope = prepared.context.scope;
    expect(scope.changes.find(c => c.newPath === "large.txt")?.unsupported).toBeTruthy();
    expect(scope.changes.find(c => c.newPath === "invalid.bin")?.unsupported).toBeTruthy();
    const change = scope.changes.find(c => c.newPath === "base.txt")!;
    expect(prepared.context.diff(change.changeId)[0].content).toContain("feature line");
    expect((await prepared.context.read("base", "base.txt", new AbortController().signal))[0].content).toBe("base\n");
    await expect(prepared.context.read("source", "../base.txt", new AbortController().signal)).rejects.toThrow();

    const temporaryRoot = prepared.rootDirectory;
    await prepared.cleanup();
    await prepared.cleanup();
    await expect(stat(temporaryRoot)).rejects.toThrow();
  }, 30_000);

  test("symlink and submodule changes are explicitly unreviewable", async () => {
    const f = await repositoryFixture({ supported: true });
    await git(f.repository, "switch", "feature");
    const commit = (await git(f.repository, "rev-parse", "HEAD")).trim();
    const blob = (await git(f.repository, "rev-parse", "HEAD:base.txt")).trim();
    await git(f.repository, "update-index", "--add", "--cacheinfo", "120000," + blob + ",link");
    await git(f.repository, "update-index", "--add", "--cacheinfo", "160000," + commit + ",submodule");
    await git(f.repository, "commit", "-m", "special object modes");
    const prepared = await new GitPreparer(f.paths, f.environment).prepare(f.project, f.details, new AbortController().signal);
    try {
      for (const path of ["link", "submodule"]) expect(prepared.context.scope.changes.find(c => c.newPath === path)?.unsupported).toBeTruthy();
    } finally { await prepared.cleanup(); }
  }, 30_000);

  test("nonunique merge-base is rejected", async () => {
    const f = await repositoryFixture({ supported: true });
    const a = (await git(f.repository, "rev-parse", "feature")).trim();
    const b = (await git(f.repository, "rev-parse", "main")).trim();
    const tree = (await git(f.repository, "rev-parse", "feature^{tree}")).trim();
    const x = (await git(f.repository, "commit-tree", tree, "-p", a, "-p", b, "-m", "merge one")).trim();
    const y = (await git(f.repository, "commit-tree", tree, "-p", b, "-p", a, "-m", "merge two")).trim();
    await git(f.repository, "update-ref", "refs/heads/feature", x);
    await git(f.repository, "update-ref", "refs/heads/main", y);
    await expect(new GitPreparer(f.paths, f.environment).prepare(f.project, f.details, new AbortController().signal)).rejects.toMatchObject({ code: "REVIEW_INCOMPLETE" });
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
