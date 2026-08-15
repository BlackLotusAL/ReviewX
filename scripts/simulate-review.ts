import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodeHubClient } from "../src/codehub.js";
import type { Commit, MergeRequest, Repository } from "../src/contracts.js";
import { GitManager } from "../src/git.js";
import { JsonlLogger } from "../src/logger.js";
import { OpenCodeClient } from "../src/opencode.js";
import {
  DefaultCommandRunner,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from "../src/process.js";
import { createRuntimePaths } from "../src/runtime.js";
import { StateStore } from "../src/state.js";
import { ReviewWorkflow } from "../src/workflow.js";

const runner = new DefaultCommandRunner();
const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
const simulationRoot = path.resolve(
  process.env.REVIEWX_SIMULATION_DIR ??
    path.join("runtime", "simulations", `${timestamp}-${randomUUID().slice(0, 8)}`),
);

function commandOutput(value: unknown): CommandResult {
  return { exitCode: 0, signal: null, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const result = await runner.run("git", args, {
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Git simulation setup failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function createSimulationRemote(): Promise<{ remote: string; commit: Commit }> {
  const setupRoot = path.join(simulationRoot, "setup");
  const remote = path.join(setupRoot, "remote.git");
  const source = path.join(setupRoot, "source");
  await mkdir(setupRoot, { recursive: true });
  await git(["init", "--bare", remote]);
  await mkdir(source, { recursive: true });
  await git(["init", "-b", "main"], source);
  await git(["config", "user.name", "ReviewX Simulation"], source);
  await git(["config", "user.email", "reviewx-simulation@example.test"], source);
  await writeFile(
    path.join(source, "service.ts"),
    'export const greeting = "hello";\n',
    "utf8",
  );
  await git(["add", "service.ts"], source);
  await git(["commit", "-m", "base greeting"], source);
  const baseSha = await git(["rev-parse", "HEAD"], source);
  await git(["checkout", "-b", "feature/simulated-review"], source);
  await writeFile(
    path.join(source, "service.ts"),
    'export const greeting = "hello world";\n',
    "utf8",
  );
  await git(["add", "service.ts"], source);
  await git(["commit", "-m", "update greeting text"], source);
  const sha = await git(["rev-parse", "HEAD"], source);
  await git(["remote", "add", "origin", remote], source);
  await git(["push", "origin", "main", "feature/simulated-review"], source);
  return {
    remote,
    commit: {
      sha,
      title: "update greeting text",
      message: "update greeting text",
      author: { name: "ReviewX Simulation" },
      committer: { name: "ReviewX Simulation" },
      authored_at: null,
      committed_at: null,
      parent_shas: [baseSha],
    },
  };
}

class SimulationCodeHubRunner implements CommandRunner {
  constructor(
    private readonly repository: Repository,
    private readonly mergeRequest: MergeRequest,
    private readonly commits: Commit[],
  ) {}

  async run(
    _command: string,
    args: readonly string[],
    _options: CommandOptions = {},
  ): Promise<CommandResult> {
    await appendFile(
      path.join(simulationRoot, "codehub-calls.jsonl"),
      `${JSON.stringify(args)}\n`,
      "utf8",
    );
    if (args[0] === "repo" && args[1] === "view") return commandOutput(this.repository);
    if (args[0] === "mr" && args[1] === "list") return commandOutput([this.mergeRequest]);
    if (args[0] === "mr" && args[1] === "commits") return commandOutput(this.commits);
    if (args[0] === "mr" && args[1] === "view") return commandOutput(this.mergeRequest);
    if (args[0] === "mr" && args[1] === "comment" && args[2] === "create") {
      const bodyIndex = args.indexOf("--body");
      const severityIndex = args.indexOf("--severity");
      const published = {
        body: args[bodyIndex + 1],
        severity: args[severityIndex + 1],
      };
      await writeFile(
        path.join(simulationRoot, "published-comment.json"),
        `${JSON.stringify(published, null, 2)}\n`,
        "utf8",
      );
      return commandOutput({
        comment_id: "simulation-comment",
        repo_id: this.repository.repo_id,
        mr_iid: this.mergeRequest.iid,
        severity: published.severity,
        resolved: false,
        web_url: null,
      });
    }
    return {
      exitCode: 2,
      signal: null,
      stdout: "",
      stderr: `${JSON.stringify({ code: "UNEXPECTED_SIMULATION_COMMAND", message: args.join(" ") })}\n`,
    };
  }
}

async function main(): Promise<void> {
  await mkdir(simulationRoot, { recursive: true });
  const { remote, commit } = await createSimulationRemote();
  const paths = createRuntimePaths(path.join(simulationRoot, "state.json"));
  const repository: Repository = {
    repo_id: "1",
    full_name: "simulation/reviewx",
    clone_urls: { ssh: null, https: remote },
    archived: false,
    updated_at: new Date().toISOString(),
    default_branch: "main",
    web_url: null,
  };
  const mergeRequest: MergeRequest = {
    repo_id: "1",
    mr_id: "1",
    iid: "1",
    title: "Update greeting text",
    state: "opened",
    is_draft: false,
    author: { name: "ReviewX Simulation" },
    source_branch: "feature/simulated-review",
    target_branch: "main",
    updated_at: new Date().toISOString(),
    web_url: null,
  };
  const state = new StateStore(paths.state, paths.stateLock);
  await state.addRepository(repository.repo_id);
  const logger = new JsonlLogger(paths.log);
  const codeHub = new CodeHubClient(
    new SimulationCodeHubRunner(repository, mergeRequest, [commit]),
    "simulation-codehub",
    60_000,
  );
  const gitManager = new GitManager(paths);
  const model = process.env.REVIEWX_SIMULATION_MODEL ?? "deepseek/deepseek-chat";
  const openCode = new OpenCodeClient(
    new DefaultCommandRunner(),
    process.env.REVIEWX_OPENCODE_BIN ?? "opencode",
    path.resolve("opencode"),
    model,
  );
  const rawTimeout = process.env.REVIEWX_SIMULATION_AGENT_TIMEOUT_MS ?? "1200000";
  const agentTimeoutMs = Number(rawTimeout);
  if (!Number.isSafeInteger(agentTimeoutMs) || agentTimeoutMs <= 0) {
    throw new Error("REVIEWX_SIMULATION_AGENT_TIMEOUT_MS must be a positive integer.");
  }
  const workflow = new ReviewWorkflow(
    paths,
    state,
    logger,
    codeHub,
    gitManager,
    openCode,
    agentTimeoutMs,
  );

  await workflow.scanOnce();
  await logger.flush();
  const records = (await readFile(paths.log, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const started = records.find((record) => record.event === "review_run_started");
  const finished = records.find((record) => record.event === "review_run_finished");
  if (!started || typeof started.run_id !== "string" || !finished) {
    throw new Error("Simulation did not produce a complete review run.");
  }
  if (finished.result === "failed") {
    throw new Error(`Simulation review failed: ${String(finished.error ?? "unknown error")}`);
  }
  const artifactRoot = path.join(paths.agentOutputs, started.run_id);
  const artifactDirectories = await readdir(artifactRoot);
  if (artifactDirectories.length !== 4) {
    throw new Error(`Expected four Agent artifact directories, found ${artifactDirectories.length}.`);
  }
  for (const directory of artifactDirectories) {
    await access(path.join(artifactRoot, directory, "metadata.json"));
    await access(path.join(artifactRoot, directory, "result.json"));
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        simulation_dir: simulationRoot,
        model,
        run_id: started.run_id,
        result: finished.result,
        agent_output_dir: artifactRoot,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Real OpenCode simulation failed; artifacts preserved at ${simulationRoot}: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
