import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("native Git review preparation", () => {
  test("materializes fixed source and base plus diff without page ledgers", async () => {
    const f = await repositoryFixture({ supported: true });
    const prepared = await new GitPreparer(f.paths, f.environment).prepare(f.project, f.details, new AbortController().signal);
    try {
      expect(await readFile(path.join(prepared.rootDirectory, "source", "base.txt"), "utf8")).toBe("base\nfeature line\n");
      expect(await readFile(path.join(prepared.rootDirectory, "base", "deleted.txt"), "utf8")).toBe("delete me\n");
      expect(await readFile(path.join(prepared.rootDirectory, "changes.diff"), "utf8")).toContain("+feature line");
      expect(prepared.scope.changedPaths).toContain("renamed.txt");
      expect(prepared.sourceSha).not.toBe(prepared.baseSha);
      expect(prepared).not.toHaveProperty("context");
    } finally { await prepared.cleanup(); }
    await expect(readFile(path.join(prepared.rootDirectory, "scope.json"))).rejects.toThrow();
  });
  test("collects scoped repository rules from fixed revisions", async () => {
    const f = await repositoryFixture({ supported: true });
    await git(f.repository, "switch", "feature");
    await writeFile(path.join(f.repository, "AGENTS.md"), "Project root rule");
    await git(f.repository, "add", "."); await git(f.repository, "commit", "-m", "rules");
    const prepared = await new GitPreparer(f.paths, f.environment).prepare(f.project, f.details, new AbortController().signal);
    try { expect(prepared.repositoryRules).toEqual([expect.objectContaining({ id: "source/AGENTS.md", body: "Project root rule" })]); }
    finally { await prepared.cleanup(); }
  });
  test("credentialed remotes are rejected before execution", async () => {
    const f = await repositoryFixture();
    await expect(new GitPreparer(f.paths, f.environment).prepare({ ...f.project, cloneUrl: "https://user:pass@example.com/repo" }, f.details, new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_GIT_REMOTE" });
  });
});
