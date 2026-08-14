import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MergeRequest, Repository } from "../../src/contracts.js";
import { GitManager, selectCloneUrl } from "../../src/git.js";
import type { CommandResult, CommandRunner } from "../../src/process.js";
import { createRuntimePaths } from "../../src/runtime.js";

const roots: string[] = [];

async function temporaryPaths() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-git-"));
  roots.push(root);
  return createRuntimePaths(path.join(root, "runtime", "state.json"));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const mergeRequest: MergeRequest = {
  repo_id: "1",
  mr_id: "2",
  iid: "3",
  title: "Test",
  state: "opened",
  is_draft: false,
  author: {},
  source_branch: "feature",
  target_branch: "main",
  updated_at: "2026-08-12T00:00:00Z",
  web_url: null,
};

function repository(cloneUrls: Repository["clone_urls"]): Repository {
  return { repo_id: "1", clone_urls: cloneUrls };
}

class FailedRunner implements CommandRunner {
  readonly calls: string[][] = [];

  constructor(private readonly result: CommandResult) {}

  async run(_command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push([...args]);
    return this.result;
  }
}

describe("Git boundaries", () => {
  it("chooses SSH first and only falls back when it is absent", () => {
    expect(selectCloneUrl(repository({ ssh: "ssh://repo", https: "https://repo" }))).toBe(
      "ssh://repo",
    );
    expect(selectCloneUrl(repository({ ssh: null, https: "https://repo" }))).toBe(
      "https://repo",
    );
    expect(selectCloneUrl(repository({ ssh: null, https: null, http: "http://repo" }))).toBe(
      "http://repo",
    );
    expect(() => selectCloneUrl(repository({ ssh: null, https: null, http: null }))).toThrowError(
      /no usable clone URL/u,
    );
  });

  it("requires repository metadata for a missing cache", async () => {
    const paths = await temporaryPaths();
    const manager = new GitManager(paths, new FailedRunner({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
    }));
    await expect(manager.prepare("1", mergeRequest, undefined)).rejects.toMatchObject({
      code: "GIT_ERROR",
    });
  });

  it.each([
    [{ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "token=secret\n" }, "unknown"],
    [{ exitCode: 9, signal: null, stdout: "", stderr: "" }, "9"],
  ] as const)("removes a partial clone after a Git failure", async (result, exitText) => {
    const paths = await temporaryPaths();
    const runner = new FailedRunner(result);
    const manager = new GitManager(paths, runner);
    await expect(
      manager.prepare("1", mergeRequest, repository({ ssh: "ssh://repo" })),
    ).rejects.toThrowError(new RegExp(`exit code ${exitText}`, "u"));
    expect(runner.calls[0]).toEqual(["clone", "ssh://repo", manager.repoPath("1")]);
    await expect(access(manager.repoPath("1"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans a missing worktree without requiring a repository cache", async () => {
    const paths = await temporaryPaths();
    const runner = new FailedRunner({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
    });
    const manager = new GitManager(paths, runner);
    await manager.cleanup("1", "3");
    expect(runner.calls).toEqual([]);
  });
});
