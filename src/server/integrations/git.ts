import { mkdir, mkdtemp, rm, writeFile, readFile, lstat } from "node:fs/promises";
import { join, relative, resolve, isAbsolute, sep, posix } from "node:path";
import type { MergeRequestSnapshot, ProjectRecord } from "@/src/shared/types";
import type { ReviewScope, RuleResource } from "@/src/shared/review-contract";
import { resolveCommand } from "../platform/resolve-command";
import type { DataPaths } from "../platform/paths";
import { runProcess } from "../platform/process";
import { digest, reviewError, safeRepositoryPath } from "../review/materials";

export interface PreparedReview {
  rootDirectory: string;
  sourceSha: string;
  targetSha: string;
  baseSha: string;
  scope: ReviewScope;
  repositoryRules: RuleResource[];
  limitations: string[];
  gitCommands: string[];
  metrics?: Record<string, number>;
  cleanup(): Promise<void>;
}
export interface GitPreparerPort { prepare(project: ProjectRecord, details: MergeRequestSnapshot, signal: AbortSignal): Promise<PreparedReview> }
const quote = (s: string) => "'" + s.replace(/'/gu, "'\\''") + "'";

export class GitPreparer implements GitPreparerPort {
  constructor(private readonly paths: DataPaths, private readonly environment: NodeJS.ProcessEnv = process.env) {}
  async prepare(project: ProjectRecord, details: MergeRequestSnapshot, signal: AbortSignal): Promise<PreparedReview> {
    const url = new URL(project.cloneUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw reviewError("INVALID_GIT_REMOTE", "仓库 URL 必须为无凭据 HTTPS。");
    const command = await resolveCommand("git", this.environment);
    const root = await mkdtemp(join(this.paths.workspaces, "review-"));
    const repository = join(root, "objects"), task = join(root, "task"), hooks = join(root, "hooks");
    await mkdir(task); await mkdir(hooks);
    const env = { ...this.environment, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_NO_REPLACE_OBJECTS: "1" };
    const options = ["--literal-pathspecs", "-c", "core.hooksPath=" + hooks, "-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "core.quotePath=false"];
    const metrics = { gitProcesses: 0, gitMs: 0 };
    const run = async (args: string[]) => {
      signal.throwIfAborted(); metrics.gitProcesses++;
      const started = Date.now();
      const result = await runProcess(command, [...options, ...args], { env, signal, timeoutMs: 10 * 60_000, maxOutputBytes: 64 * 1024 * 1024 });
      metrics.gitMs += Date.now() - started;
      if (result.exitCode !== 0 || result.aborted || result.timedOut || result.outputLimitExceeded) throw reviewError(signal.aborted ? "GIT_CANCELLED" : "GIT_ERROR", "Git 准备失败。", { stderr: result.stderr });
      return result.stdout;
    };
    const git = (args: string[]) => run(["-C", repository, ...args]);
    const cleanup = async () => {
      const rel = relative(resolve(this.paths.workspaces), resolve(root));
      if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("Unsafe cleanup path");
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    };
    try {
      await run(["check-ref-format", "--branch", details.sourceBranch]);
      await run(["check-ref-format", "--branch", details.targetBranch]);
      await run(["init", "--bare", "--template=", repository]);
      await git(["remote", "add", "origin", project.cloneUrl]);
      await git(["fetch", "--no-tags", "--no-recurse-submodules", "origin", "--", "+refs/heads/" + details.sourceBranch + ":refs/reviewx/source", "+refs/heads/" + details.targetBranch + ":refs/reviewx/target"]);
      const sourceSha = (await git(["rev-parse", "refs/reviewx/source"])).trim();
      const targetSha = (await git(["rev-parse", "refs/reviewx/target"])).trim();
      const bases = (await git(["merge-base", "--all", targetSha, sourceSha])).trim().split(/\s+/u);
      if (bases.length !== 1) throw reviewError("GIT_SCOPE_UNSUPPORTED", "无法确定唯一 merge-base。");
      const baseSha = bases[0];
      const paths = (await git(["diff", "--name-only", "-z", baseSha, sourceSha, "--"])).split("\0").filter(Boolean);
      // Git checkout is performed by the host; the agent receives only read permissions.
      for (const [side, sha] of [["source", sourceSha], ["base", baseSha]]) {
        await git(["worktree", "add", "--detach", join(task, side), sha]);
      }
      const patch = await git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", baseSha, sourceSha, "--"]);
      await writeFile(join(task, "changes.diff"), patch);
      const scope = { sourceSha, targetSha, baseSha, changedPaths: paths };
      await writeFile(join(task, "scope.json"), JSON.stringify(scope, null, 2));
      const names = new Set<string>();
      for (const file of paths) {
        if (!safeRepositoryPath(file)) continue;
        for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) {
          for (const name of ["AGENTS.md", "CLAUDE.md"]) names.add(dir === "." ? name : dir + "/" + name);
          if (dir === ".") break;
        }
      }
      const repositoryRules: RuleResource[] = [];
      const limitations: string[] = [];
      for (const name of [...names].sort()) {
        for (const side of ["source", "base"]) {
          try {
            let linked = false;
            for (let current = join(task, side), i = 0; i < name.split("/").length; i++) {
              current = join(current, name.split("/")[i]);
              if ((await lstat(current)).isSymbolicLink()) { linked = true; break; }
            }
            if (linked) { limitations.push("跳过链接规则：" + side + "/" + name); break; }
            const body = await readFile(join(task, side, name), "utf8");
            repositoryRules.push({ id: side + "/" + name, body, resourceHash: digest(body) }); break;
          } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        }
      }
      const fixed = "git -C source ";
      const gitCommands = [
        fixed + "diff --no-ext-diff --no-textconv " + baseSha + " " + sourceSha + " --",
        fixed + "log -20 --oneline " + sourceSha,
        ...paths.filter(safeRepositoryPath).map(p => fixed + "log -10 --oneline " + sourceSha + " -- " + quote(p)),
      ];
      return { rootDirectory: task, ...scope, scope, repositoryRules, limitations, gitCommands, metrics, cleanup };
    } catch (error) {
      await cleanup().catch(() => undefined);
      throw error;
    }
  }
}
