import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { MergeRequest, Repository } from "./contracts.js";
import { errorMessage, redactText, ReviewXError } from "./errors.js";
import { DefaultCommandRunner, type CommandRunner, type CommandResult } from "./process.js";
import { assertPathWithin, type RuntimePaths } from "./runtime.js";

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export interface CloneCandidate {
  protocol: "SSH" | "HTTPS";
  url: string;
}

export function selectCloneCandidates(repository: Repository): CloneCandidate[] {
  const candidates: CloneCandidate[] = [];
  const ssh = repository.clone_urls.ssh;
  if (typeof ssh === "string" && ssh.trim() !== "") {
    candidates.push({ protocol: "SSH", url: ssh });
  }
  const https = repository.clone_urls.https;
  if (typeof https === "string" && https.trim() !== "") {
    candidates.push({ protocol: "HTTPS", url: https });
  }
  if (candidates.length > 0) return candidates;
  throw new ReviewXError("GIT_ERROR", `Repository ${repository.repo_id} has no usable clone URL.`);
}

export class GitManager {
  constructor(
    private readonly paths: RuntimePaths,
    private readonly runner: CommandRunner = new DefaultCommandRunner(),
    private readonly executable = process.env.REVIEWX_GIT_BIN ?? "git",
    private readonly timeoutMs = 5 * 60_000,
  ) {}

  repoPath(repoId: string): string {
    const result = path.join(this.paths.repos, repoId);
    assertPathWithin(this.paths.repos, result);
    return result;
  }

  worktreePath(repoId: string, mrIid: string): string {
    const result = path.join(this.paths.worktrees, repoId, mrIid);
    assertPathWithin(this.paths.worktrees, result);
    return result;
  }

  async hasCache(repoId: string): Promise<boolean> {
    return await exists(path.join(this.repoPath(repoId), ".git"));
  }

  private async raw(
    args: readonly string[],
    signal?: AbortSignal,
    ignoreFailure = false,
  ): Promise<CommandResult> {
    const result = await this.runner.run(this.executable, args, {
      timeoutMs: this.timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!ignoreFailure && result.exitCode !== 0) {
      const stderrLines = result.stderr.trim().split(/\r?\n/u).filter((line) => line.trim() !== "");
      const detail = redactText(
        stderrLines.findLast((line) => /^fatal:/iu.test(line.trim())) ?? stderrLines.at(-1) ?? "",
      );
      throw new ReviewXError(
        "GIT_ERROR",
        `Git command failed with exit code ${result.exitCode ?? "unknown"}${detail ? `: ${detail}` : "."}`,
      );
    }
    return result;
  }

  private async safeRemove(parent: string, target: string): Promise<void> {
    assertPathWithin(parent, target);
    await rm(target, { recursive: true, force: true });
  }

  async prepare(
    repoId: string,
    mr: MergeRequest,
    repository: Repository | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const repoPath = this.repoPath(repoId);
    const worktreePath = this.worktreePath(repoId, mr.iid);
    await mkdir(this.paths.repos, { recursive: true });
    await mkdir(path.dirname(worktreePath), { recursive: true });

    if (!(await this.hasCache(repoId))) {
      if (!repository) {
        throw new ReviewXError("GIT_ERROR", `Repository metadata is required to clone ${repoId}.`);
      }
      await this.safeRemove(this.paths.repos, repoPath);
      const failures: string[] = [];
      const candidates = selectCloneCandidates(repository);
      for (const [index, candidate] of candidates.entries()) {
        try {
          await this.raw(["clone", candidate.url, repoPath], signal);
          break;
        } catch (error) {
          await this.safeRemove(this.paths.repos, repoPath);
          if (!(error instanceof ReviewXError) || error.code !== "GIT_ERROR") throw error;
          failures.push(`${candidate.protocol}: ${errorMessage(error)}`);
          if (index === candidates.length - 1) {
            throw new ReviewXError(
              "GIT_ERROR",
              `All Git clone attempts failed (${failures.join("; ")}).`,
              { cause: error },
            );
          }
        }
      }
    }

    const branches = [...new Set([mr.source_branch, mr.target_branch])];
    const refspecs = branches.map(
      (branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    );
    await this.raw(["-C", repoPath, "fetch", "--prune", "origin", ...refspecs], signal);

    await this.raw(["-C", repoPath, "worktree", "remove", "--force", worktreePath], signal, true);
    await this.safeRemove(this.paths.worktrees, worktreePath);
    await this.raw(["-C", repoPath, "worktree", "prune"], signal);
    await this.raw(
      [
        "-C",
        repoPath,
        "worktree",
        "add",
        "--detach",
        worktreePath,
        `refs/remotes/origin/${mr.source_branch}`,
      ],
      signal,
    );
    return worktreePath;
  }

  async cleanup(repoId: string, mrIid: string): Promise<void> {
    const repoPath = this.repoPath(repoId);
    const worktreePath = this.worktreePath(repoId, mrIid);
    if (await exists(path.join(repoPath, ".git"))) {
      await this.raw(["-C", repoPath, "worktree", "remove", "--force", worktreePath], undefined, true);
      await this.raw(["-C", repoPath, "worktree", "prune"], undefined, true);
    }
    await this.safeRemove(this.paths.worktrees, worktreePath);
  }
}
