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
  JudgeResult,
  MergeRequest,
  Repository,
  SelectedFinding,
} from "../../src/contracts.js";
import { GitManager } from "../../src/git.js";
import { JsonlLogger } from "../../src/logger.js";
import { OpenCodeClient } from "../../src/opencode.js";
import { createRuntimePaths } from "../../src/runtime.js";
import { StateStore } from "../../src/state.js";
import { ReviewWorkflow } from "../../src/workflow.js";

export const finding: SelectedFinding = {
  title: "事务提交前发送成功事件",
  file: "service.ts",
  start_line: 1,
  end_line: 1,
  severity: "Critical",
  tags: ["correctness", "transaction"],
  rule_ids: ["TX-001"],
  problem: "事务提交前已经发送成功事件。",
  trigger: "事务随后回滚。",
  impact: "下游状态与数据库不一致。",
  evidence: [{ file: "service.ts", line: 1, description: "提交前调用 publish。" }],
  recommendation: "移动到提交后的回调。",
  confidence: 94,
  example_code: "afterCommit(() => publish());",
};

export function finalComment(): string {
  return `### [Critical][correctness][transaction] 事务提交前发送成功事件

**位置**：\`service.ts:1\`

**问题**：事务提交前已经发送成功事件。

**触发条件**：事务随后回滚。

**影响**：下游状态与数据库不一致。

**修改建议**：移动到提交后的回调。

\`\`\`ts
afterCommit(() => publish());
\`\`\`

**置信度**：94%

**规则**：\`TX-001\``;
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
  readonly environments: NodeJS.ProcessEnv[] = [];
  invalidExpert: string | undefined;
  fencedOutput = false;

  constructor(public judgeResult: JudgeResult) {}

  async run(
    _command: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    const agent = args[args.indexOf("--agent") + 1]!;
    const inputPath = args[args.indexOf("--file") + 1]!;
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    this.agents.push(agent);
    this.inputs.push(input);
    this.environments.push(options.env ?? {});
    if (options.cwd) {
      const finalSource = await readFile(path.join(options.cwd, "service.ts"), "utf8");
      if (finalSource.includes("BUG_FROM_EARLY_COMMIT")) {
        throw new Error("Agent saw a stale intermediate commit instead of the final worktree.");
      }
    }
    if (agent === this.invalidExpert) {
      return { exitCode: 0, signal: null, stdout: "not-json\n", stderr: "" };
    }
    const output =
      agent === "review-judge"
        ? this.judgeResult
        : { expert: agent, verdict: "pass", findings: [] };
    const rawJson = JSON.stringify(output);
    const json = this.fencedOutput ? `\`\`\`json\n${rawJson}\n\`\`\`` : rawJson;
    const split = Math.floor(json.length / 2);
    const stdout = [json.slice(0, split), json.slice(split)]
      .map((text) => JSON.stringify({ type: "text", part: { text } }))
      .join("\n");
    return { exitCode: 0, signal: null, stdout: `${stdout}\n`, stderr: "" };
  }
}

export class RecordingGitRunner implements CommandRunner {
  readonly calls: string[][] = [];
  private readonly delegate = new DefaultCommandRunner();

  async run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    this.calls.push([...args]);
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

export async function createWorkflowHarness(judgeResult: JudgeResult): Promise<WorkflowHarness> {
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
  const agentRunner = new ScriptedAgentRunner(judgeResult);
  const gitRunner = new RecordingGitRunner();
  const codeHub = new CodeHubClient(codeHubRunner, "codehub", 10_000);
  const gitManager = new GitManager(paths, gitRunner, "git", 30_000);
  const openCode = new OpenCodeClient(agentRunner, "opencode", path.resolve("opencode"));
  const logs: string[] = [];
  const logger = new JsonlLogger(paths.log, (line) => logs.push(line));
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
