import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "../../src/process.js";
import { DefaultCommandRunner } from "../../src/process.js";
import { CodeHubClient } from "../../src/codehub.js";
import type {
  Commit,
  JudgeDecision,
  MergeRequest,
  Repository,
} from "../../src/contracts.js";
import { GitManager } from "../../src/git.js";
import { TextLogger } from "../../src/logger.js";
import { OpenCodeClient } from "../../src/opencode.js";
import { formatJudgeDecisionHeader } from "../../src/judge-report.js";
import { createRuntimePaths } from "../../src/runtime.js";
import { StateStore } from "../../src/state.js";
import { ReviewWorkflow } from "../../src/workflow.js";

export function finalComment(): string {
  return `### 【Critical】事务提交前发送成功事件

**严重等级**：🟠 Critical<br>
**问题类型**：\`correctness\`, \`transaction\`<br>
**位置**：\`service.ts\` L1<br>
**置信度**：94<br>
**适用规则**：\`TX-001\`

**问题描述**

> 事务提交前已经发送成功事件。

**触发条件**

> 事务随后回滚。

**影响**

> 下游状态与数据库不一致。

**证据**

> 最终代码在事务提交前直接发送事件。

**修复建议**

> 将事件发送移动到提交后的回调。

\`\`\`ts
afterCommit(() => publish());
\`\`\``;
}

function ok(value: unknown): CommandResult {
  return { exitCode: 0, signal: null, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

function failed(code: string, message = "failed"): CommandResult {
  return {
    exitCode: 8,
    signal: null,
    stdout: "",
    stderr: `${JSON.stringify({ code, message })}\n`,
  };
}

export class ScriptedCodeHubRunner implements CommandRunner {
  readonly calls: string[][] = [];
  readonly comments: Array<{ body: string; severity: string }> = [];
  listUpdatedAt = "2026-08-12T00:00:00Z";
  prePublishUpdatedAt = "2026-08-12T00:00:00Z";
  refreshUpdatedAt = "2026-08-12T00:01:00Z";
  prePublishState = "opened";
  publication: "success" | "unknown" | "missing_id" | "failure" = "success";
  listState = "opened";
  listFailure = false;
  refreshFailure = false;
  viewCalls = 0;

  constructor(
    readonly repository: Repository,
    readonly mergeRequest: MergeRequest,
    readonly commits: Commit[],
  ) {}

  async run(_command: string, args: readonly string[]): Promise<CommandResult> {
    const call = [...args];
    this.calls.push(call);
    if (call[0] === "repo" && call[1] === "view") return ok(this.repository);
    if (call[0] === "mr" && call[1] === "list") {
      if (this.listFailure) return failed("HTTP_ERROR", "list failed");
      return ok([{ ...this.mergeRequest, updated_at: this.listUpdatedAt, state: this.listState }]);
    }
    if (call[0] === "mr" && call[1] === "commits") return ok(this.commits);
    if (call[0] === "mr" && call[1] === "view") {
      const first = this.viewCalls++ === 0;
      if (!first && this.refreshFailure) return failed("HTTP_ERROR", "refresh failed");
      return ok({
        ...this.mergeRequest,
        state: first ? this.prePublishState : "opened",
        updated_at: first ? this.prePublishUpdatedAt : this.refreshUpdatedAt,
      });
    }
    if (call[0] === "mr" && call[1] === "comment" && call[2] === "create") {
      const bodyIndex = call.indexOf("--body");
      const severityIndex = call.indexOf("--severity");
      this.comments.push({ body: call[bodyIndex + 1]!, severity: call[severityIndex + 1]! });
      if (this.publication === "unknown") return failed("WRITE_RESULT_UNKNOWN", "unknown result");
      if (this.publication === "failure") return failed("HTTP_ERROR", "forbidden");
      return ok({
        comment_id: this.publication === "missing_id" ? null : "comment-1",
        repo_id: this.repository.repo_id,
        mr_iid: this.mergeRequest.iid,
        severity: call[severityIndex + 1],
        resolved: this.publication === "missing_id" ? null : false,
        web_url: null,
      });
    }
    return failed("UNEXPECTED_COMMAND", call.join(" "));
  }
}

export class ScriptedAgentRunner implements CommandRunner {
  readonly agents: string[] = [];
  readonly inputs: unknown[] = [];
  readonly judgeInputFiles: string[][] = [];
  readonly judgeInputContents: string[][] = [];
  readonly environments: NodeJS.ProcessEnv[] = [];
  invalidExpert: string | undefined;
  invalidJudgeAttempts = 0;
  failedToolAgent: string | undefined;
  expertMarkdown = "# PASS\n\nNo actionable issue remains in the final aggregate change.";

  constructor(
    public judgeDecision: JudgeDecision,
    public judgeMarkdown = finalComment(),
  ) {}

  async run(
    _command: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    const agent = args[args.indexOf("--agent") + 1]!;
    const inputPaths = args
      .map((value, index) => (value === "--file" ? args[index + 1] : undefined))
      .filter((value): value is string => value !== undefined);
    const input = JSON.parse(await readFile(inputPaths[0]!, "utf8"));
    this.agents.push(agent);
    this.inputs.push(input);
    this.environments.push(options.env ?? {});
    if (agent === "review-judge") {
      this.judgeInputFiles.push([...inputPaths]);
      this.judgeInputContents.push(
        await Promise.all(inputPaths.map(async (inputPath) => await readFile(inputPath, "utf8"))),
      );
    }
    if (options.cwd) {
      const finalSource = await readFile(path.join(options.cwd, "service.ts"), "utf8");
      if (finalSource.includes("BUG_FROM_EARLY_COMMIT")) {
        throw new Error("Agent saw a stale intermediate commit instead of the final worktree.");
      }
    }
    if (agent === this.invalidExpert) {
      await options.onStdoutLine?.("not-json");
      return { exitCode: 0, signal: null, stdout: "not-json\n", stderr: "" };
    }
    let output: string;
    if (agent === "review-judge") {
      if (this.invalidJudgeAttempts > 0) {
        this.invalidJudgeAttempts -= 1;
        output = "# Missing control header";
      } else {
        const body = this.judgeDecision.verdict === "NEW" ? `\n${this.judgeMarkdown}` : "";
        output = `${formatJudgeDecisionHeader(this.judgeDecision)}${body}`;
      }
    } else {
      output = this.expertMarkdown;
    }
    const split = Math.floor(output.length / 2);
    const invocation = this.agents.length;
    const toolMessage = `${agent}-${invocation}-tool`;
    const finalMessage = `${agent}-${invocation}-final`;
    const stdout = [
      {
        type: "step_start",
        timestamp: 1_000,
        part: { messageID: toolMessage },
      },
      {
        type: "tool_use",
        timestamp: 1_050,
        part: {
          messageID: toolMessage,
          callID: `${toolMessage}-call`,
          tool: "read",
          state: {
            status: agent === this.failedToolAgent ? "error" : "completed",
            input: { filePath: path.join(options.cwd ?? ".", "service.ts") },
            output: "TOOL_OUTPUT_MUST_NOT_REACH_LOGS token=tool-secret",
            time: { start: 1_025, end: 1_040 },
          },
        },
      },
      {
        type: "step_finish",
        timestamp: 1_075,
        part: {
          messageID: toolMessage,
          reason: "tool-calls",
          tokens: {
            input: 100,
            output: 10,
            reasoning: 0,
            cache: { read: 50, write: 0 },
          },
        },
      },
      {
        type: "step_start",
        timestamp: 2_000,
        part: { messageID: finalMessage },
      },
      {
        type: "text",
        timestamp: 2_050,
        part: {
          messageID: finalMessage,
          text: output.slice(0, split),
          time: { start: 2_025, end: 2_035 },
        },
      },
      {
        type: "text",
        timestamp: 2_060,
        part: {
          messageID: finalMessage,
          text: output.slice(split),
          time: { start: 2_035, end: 2_045 },
        },
      },
      {
        type: "step_finish",
        timestamp: 2_075,
        part: {
          messageID: finalMessage,
          reason: "stop",
          tokens: {
            input: 50,
            output: 20,
            reasoning: 0,
            cache: { read: 25, write: 0 },
          },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n");
    for (const eventLine of stdout.split("\n")) {
      await options.onStdoutLine?.(eventLine);
    }
    return { exitCode: 0, signal: null, stdout: `${stdout}\n`, stderr: "" };
  }
}

export class RecordingGitRunner implements CommandRunner {
  readonly calls: string[][] = [];
  cleanupFailure = false;
  private worktreePruneCount = 0;
  private readonly delegate = new DefaultCommandRunner();

  async run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    this.calls.push([...args]);
    if (args.includes("worktree") && args.includes("prune")) {
      this.worktreePruneCount += 1;
      if (this.cleanupFailure && this.worktreePruneCount > 1) {
        throw new Error("cleanup failed");
      }
    }
    return await this.delegate.run(command, args, options);
  }
}

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await new DefaultCommandRunner().run("git", args, {
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function createRemote(root: string): Promise<{ remote: string; shas: string[] }> {
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");
  await git(["init", "--bare", remote]);
  await mkdir(source, { recursive: true });
  await git(["init", "-b", "main"], source);
  await git(["config", "user.name", "ReviewX Test"], source);
  await git(["config", "user.email", "reviewx@example.test"], source);
  await writeFile(path.join(source, "service.ts"), "export const value = 1;\n", "utf8");
  await git(["add", "service.ts"], source);
  await git(["commit", "-m", "base"], source);
  await git(["checkout", "-b", "feature"], source);
  await writeFile(
    path.join(source, "service.ts"),
    "export const BUG_FROM_EARLY_COMMIT = true;\n",
    "utf8",
  );
  await git(["add", "service.ts"], source);
  await git(["commit", "-m", "introduce intermediate issue"], source);
  const first = await git(["rev-parse", "HEAD"], source);
  await writeFile(path.join(source, "service.ts"), "export const value = 2;\n", "utf8");
  await git(["add", "service.ts"], source);
  await git(["commit", "-m", "fix intermediate issue"], source);
  const second = await git(["rev-parse", "HEAD"], source);
  await git(["remote", "add", "origin", remote], source);
  await git(["push", "origin", "main", "feature"], source);
  return { remote, shas: [first, second] };
}

export interface WorkflowHarness {
  root: string;
  paths: ReturnType<typeof createRuntimePaths>;
  state: StateStore;
  workflow: ReviewWorkflow;
  codeHub: ScriptedCodeHubRunner;
  agents: ScriptedAgentRunner;
  git: RecordingGitRunner;
  logs: string[];
  cleanup(): Promise<void>;
}

export async function createWorkflowHarness(
  judgeDecision: JudgeDecision,
  judgeMarkdown = finalComment(),
): Promise<WorkflowHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-flow-"));
  const { remote, shas } = await createRemote(root);
  const paths = createRuntimePaths(path.join(root, "runtime", "state.json"));
  const state = new StateStore(paths.state, paths.stateLock);
  await state.addRepository("1");
  const repository: Repository = {
    repo_id: "1",
    full_name: "group/project",
    clone_urls: { ssh: null, https: remote },
    archived: false,
    updated_at: "2026-08-12T00:00:00Z",
    default_branch: "main",
    web_url: null,
  };
  const mergeRequest: MergeRequest = {
    repo_id: "1",
    mr_id: "99",
    iid: "7",
    title: "Change value",
    state: "opened",
    is_draft: false,
    author: { name: "Tester" },
    source_branch: "feature",
    target_branch: "main",
    updated_at: "2026-08-12T00:00:00Z",
    web_url: null,
  };
  const commits: Commit[] = shas.map((sha, index) => ({
    sha,
    title: index === 0 ? "introduce intermediate issue" : "fix intermediate issue",
    message: index === 0 ? "introduce intermediate issue" : "fix intermediate issue",
    author: { name: "Tester" },
    committer: { name: "Tester" },
    authored_at: null,
    committed_at: null,
    parent_shas: [],
  }));
  const codeHubRunner = new ScriptedCodeHubRunner(repository, mergeRequest, commits);
  const agentRunner = new ScriptedAgentRunner(judgeDecision, judgeMarkdown);
  const gitRunner = new RecordingGitRunner();
  const codeHub = new CodeHubClient(codeHubRunner, "codehub", 10_000);
  const gitManager = new GitManager(paths, gitRunner, "git", 30_000);
  const openCode = new OpenCodeClient(agentRunner, "opencode", path.resolve("opencode"));
  const logs: string[] = [];
  const logger = new TextLogger(paths.log, (line) => logs.push(line));
  const workflow = new ReviewWorkflow(
    paths,
    state,
    logger,
    codeHub,
    gitManager,
    openCode,
    5_000,
  );
  return {
    root,
    paths,
    state,
    workflow,
    codeHub: codeHubRunner,
    agents: agentRunner,
    git: gitRunner,
    logs,
    cleanup: async () => await rm(root, { recursive: true, force: true }),
  };
}
