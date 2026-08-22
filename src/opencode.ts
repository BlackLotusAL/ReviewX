import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AgentOutputSource, ExpertName, ExpertReport, JudgeReport } from "./contracts.js";
import {
  AgentProgressTracker,
  type AgentProgressEvent,
  type AgentProgressSummary,
} from "./agent-progress.js";
import { diagnosticTextPreview, redactText, ReviewXError } from "./errors.js";
import { JudgeDocumentError, parseJudgeDocument } from "./judge-report.js";
import { DefaultCommandRunner, type CommandRunner } from "./process.js";

const readonlyPermissions = {
  "*": "deny",
  read: {
    "*": "allow",
    "*.env": "deny",
    "*.env.*": "deny",
    "*.env.example": "allow",
  },
  glob: "allow",
  grep: "allow",
  list: "allow",
  edit: "deny",
  task: "deny",
  lsp: "deny",
  skill: "deny",
  question: "deny",
  webfetch: "deny",
  websearch: "deny",
  external_directory: "deny",
  bash: {
    "*": "deny",
    "git status": "allow",
    "git status *": "allow",
    "git log": "allow",
    "git log *": "allow",
    "git show": "allow",
    "git show *": "allow",
    "git diff": "allow",
    "git diff *": "allow",
  },
} as const;

const inlineConfig = {
  permission: readonlyPermissions,
  agent: {
    "design-reviewer": { permission: readonlyPermissions },
    "business-reviewer": { permission: readonlyPermissions },
    "code-reviewer": { permission: readonlyPermissions },
    "review-judge": { permission: readonlyPermissions },
  },
};

function sanitizedAgentEnv(configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CODEHUB|DEVUC)_/iu.test(key) || key.toUpperCase() === "PRIVATE_TOKEN") continue;
    env[key] = value;
  }
  env.OPENCODE_CONFIG_DIR = configDir;
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(inlineConfig);
  env.OPENCODE_DISABLE_AUTOUPDATE = "true";
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true";
  env.OPENCODE_DISABLE_LSP_DOWNLOAD = "true";
  return env;
}

function collectOpenCodeText(stdout: string): string {
  const textByMessage = new Map<string, string[]>();
  let lastTextMessage = "legacy";
  let finalMessage: string | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new ReviewXError("AGENT_ERROR", "OpenCode emitted a non-JSON event.", {
        cause: error,
      });
    }
    if (!event || typeof event !== "object") {
      throw new ReviewXError("AGENT_ERROR", "OpenCode emitted an invalid event.");
    }
    const value = event as {
      type?: unknown;
      part?: { text?: unknown; messageID?: unknown; reason?: unknown };
    };
    if (value.type === "error") {
      throw new ReviewXError("AGENT_ERROR", "OpenCode emitted an error event.");
    }
    if (value.type === "text") {
      if (!value.part || typeof value.part.text !== "string") {
        throw new ReviewXError("AGENT_ERROR", "OpenCode text event is missing part.text.");
      }
      const messageId =
        typeof value.part.messageID === "string" ? value.part.messageID : "legacy";
      const parts = textByMessage.get(messageId) ?? [];
      parts.push(value.part.text);
      textByMessage.set(messageId, parts);
      lastTextMessage = messageId;
    }
    if (
      value.type === "step_finish" &&
      value.part?.reason === "stop" &&
      typeof value.part.messageID === "string"
    ) {
      finalMessage = value.part.messageID;
    }
  }
  const textParts = textByMessage.get(finalMessage ?? lastTextMessage);
  if (!textParts || textParts.length === 0) {
    throw new ReviewXError("AGENT_ERROR", "OpenCode returned no final assistant text.");
  }
  const text = textParts.join("");
  if (text.trim() === "") {
    throw new ReviewXError("AGENT_ERROR", "OpenCode returned an empty final assistant text.");
  }
  return text;
}

export function parseOpenCodeText(stdout: string): string {
  return collectOpenCodeText(stdout);
}

type AgentName = ExpertName | "review-judge";

export interface AgentRunOptions {
  artifactDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (event: AgentRunProgress) => void | Promise<void>;
}

export type AgentRunProgress = AgentProgressEvent & { attempt?: number };

interface AgentArtifactMetadata {
  agent: AgentName;
  status: "started" | "succeeded" | "failed";
  started_at: string;
  finished_at?: string;
  model?: string;
  exit_code?: number | null;
  signal?: NodeJS.Signals | null;
  stdout_chars?: number;
  stderr_chars?: number;
  assistant_chars?: number;
  event_status: "not_attempted" | "succeeded" | "failed";
  progress?: AgentProgressSummary;
  error?: string;
}

interface JudgeArtifactMetadata {
  agent: "review-judge";
  status: "started" | "succeeded" | "failed";
  started_at: string;
  finished_at?: string;
  attempts: number;
  decision_status: "not_attempted" | "succeeded" | "failed";
  verdict?: JudgeReport["decision"]["verdict"];
  error?: string;
}

function agentOutputDetails(
  agent: AgentName,
  artifactDir: string,
  output?: string,
  source?: AgentOutputSource,
) {
  const preview = output === undefined ? undefined : diagnosticTextPreview(output);
  return {
    agent,
    agent_output_artifact: artifactDir,
    ...(preview === undefined || source === undefined
      ? {}
      : {
          agent_output: preview.text,
          agent_output_source: source,
          agent_output_chars: preview.originalCharacters,
          agent_output_truncated: preview.truncated,
        }),
  } as const;
}

function attachAgentContext(
  error: unknown,
  agent: AgentName,
  artifactDir: string,
  output?: string,
  source?: AgentOutputSource,
): ReviewXError {
  const base =
    error instanceof ReviewXError
      ? error
      : new ReviewXError("AGENT_ERROR", error instanceof Error ? error.message : String(error), {
          cause: error,
        });
  return new ReviewXError(base.code, base.message, {
    exitCode: base.exitCode,
    cause: error,
    details: {
      ...base.details,
      ...agentOutputDetails(agent, artifactDir, output, source),
    },
  });
}

async function writeArtifact(directory: string, name: string, value: string): Promise<void> {
  await writeFile(path.join(directory, name), value, { encoding: "utf8", mode: 0o600 });
}

async function snapshotInputs(artifactDir: string, inputPaths: readonly string[]): Promise<void> {
  const inputDir = path.join(artifactDir, "inputs");
  await mkdir(inputDir, { recursive: true, mode: 0o700 });
  const manifest: Array<{ source_path: string; artifact_file: string }> = [];
  for (const [index, inputPath] of inputPaths.entries()) {
    const name = `${String(index + 1).padStart(2, "0")}-${path.basename(inputPath)}`;
    const raw = await readFile(inputPath, "utf8");
    await writeArtifact(inputDir, name, raw);
    manifest.push({ source_path: path.resolve(inputPath), artifact_file: `inputs/${name}` });
  }
  await writeArtifact(
    artifactDir,
    "input-manifest.json",
    `${JSON.stringify({ files: manifest }, null, 2)}\n`,
  );
}

const judgeHeaders = [
  '<!-- reviewx-decision: {"verdict":"PASS"} -->',
  '<!-- reviewx-decision: {"verdict":"DUPLICATE","duplicate_comment_id":"comment-id"} -->',
  '<!-- reviewx-decision: {"verdict":"DUPLICATE","duplicate_comment_id":null} -->',
  '<!-- reviewx-decision: {"verdict":"NEW","severity":"minor"} -->',
].join("\n");

export class OpenCodeClient {
  private readonly configDir: string;

  constructor(
    private readonly runner: CommandRunner = new DefaultCommandRunner(),
    private readonly executable = process.env.REVIEWX_OPENCODE_BIN ?? "opencode",
    configDir =
      process.env.REVIEWX_OPENCODE_CONFIG_DIR ??
      fileURLToPath(new URL("../opencode/", import.meta.url)),
    private readonly model = process.env.REVIEWX_OPENCODE_MODEL,
  ) {
    this.configDir = path.resolve(configDir);
  }

  private async invokeText(
    agent: AgentName,
    worktreePath: string,
    inputPaths: readonly string[],
    options: AgentRunOptions,
    message: string,
    attempt?: number,
  ): Promise<string> {
    const artifactDir = path.resolve(options.artifactDir);
    const metadata: AgentArtifactMetadata = {
      agent,
      status: "started",
      started_at: new Date().toISOString(),
      ...(this.model === undefined ? {} : { model: this.model }),
      event_status: "not_attempted",
    };
    let diagnosticOutput: string | undefined;
    let diagnosticSource: AgentOutputSource | undefined;
    let progress: AgentProgressTracker | undefined;
    try {
      await mkdir(artifactDir, { recursive: true, mode: 0o700 });
      progress = new AgentProgressTracker(worktreePath, async (event) => {
        await options.onProgress?.({
          ...event,
          ...(attempt === undefined ? {} : { attempt }),
        });
      });
      const result = await this.runner.run(
        this.executable,
        [
          "run",
          "--pure",
          "--agent",
          agent,
          "--dir",
          worktreePath,
          ...inputPaths.flatMap((inputPath) => ["--file", inputPath]),
          "--format",
          "json",
          ...(this.model === undefined ? [] : ["--model", this.model]),
          message,
        ],
        {
          cwd: worktreePath,
          env: sanitizedAgentEnv(this.configDir),
          timeoutMs: options.timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          maxOutputBytes: 20 * 1024 * 1024,
          onStdoutLine: async (line) => await progress!.handleLine(line),
        },
      );
      metadata.progress = await progress.finish();
      metadata.exit_code = result.exitCode;
      metadata.signal = result.signal;
      metadata.stdout_chars = result.stdout.length;
      metadata.stderr_chars = result.stderr.length;
      await Promise.all([
        writeArtifact(artifactDir, "stdout.jsonl", result.stdout),
        writeArtifact(artifactDir, "stderr.txt", result.stderr),
      ]);
      diagnosticOutput = result.stdout;
      diagnosticSource = "opencode_stdout";

      if (result.exitCode !== 0) {
        const detail = redactText(result.stderr.trim().split(/\r?\n/u)[0] ?? "");
        throw new ReviewXError(
          "AGENT_ERROR",
          `OpenCode agent ${agent} failed with exit code ${result.exitCode ?? "unknown"}${detail ? `: ${detail}` : "."}`,
        );
      }

      let outputText: string;
      try {
        outputText = collectOpenCodeText(result.stdout);
      } catch (error) {
        metadata.event_status = "failed";
        const detail = redactText(error instanceof Error ? error.message : String(error));
        throw new ReviewXError(
          "AGENT_ERROR",
          `OpenCode agent ${agent} returned invalid event output${detail ? `: ${detail}` : "."}`,
          { cause: error },
        );
      }
      diagnosticOutput = outputText;
      diagnosticSource = "assistant_text";
      metadata.assistant_chars = outputText.length;
      metadata.event_status = "succeeded";
      await writeArtifact(artifactDir, "assistant.txt", outputText);
      metadata.status = "succeeded";
      metadata.finished_at = new Date().toISOString();
      await writeArtifact(artifactDir, "metadata.json", `${JSON.stringify(metadata, null, 2)}\n`);
      return outputText;
    } catch (error) {
      let finalError = error;
      if (progress !== undefined) {
        metadata.progress = progress.summary();
        try {
          metadata.progress = await progress.finish();
        } catch (progressError) {
          finalError = progressError;
        }
      }
      metadata.status = "failed";
      metadata.finished_at = new Date().toISOString();
      metadata.error = redactText(
        finalError instanceof Error ? finalError.message : String(finalError),
      );
      await mkdir(artifactDir, { recursive: true, mode: 0o700 });
      await writeArtifact(artifactDir, "metadata.json", `${JSON.stringify(metadata, null, 2)}\n`);
      throw attachAgentContext(
        finalError,
        agent,
        artifactDir,
        diagnosticOutput,
        diagnosticSource,
      );
    }
  }

  async runExpert(
    expert: ExpertName,
    worktreePath: string,
    inputPath: string,
    options: AgentRunOptions,
  ): Promise<ExpertReport> {
    const artifactDir = path.resolve(options.artifactDir);
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    await snapshotInputs(artifactDir, [inputPath]);
    const markdown = await this.invokeText(
      expert,
      worktreePath,
      [inputPath],
      options,
      "检视当前 MR 的最终整体净变化，输出一份完整 Markdown 评审报告；严重等级仅使用 CodeHub 的小写 fatal、major、minor、suggestion。",
    );
    await writeArtifact(artifactDir, "report.md", markdown);
    return { expert, markdown };
  }

  async runJudge(
    worktreePath: string,
    inputPaths: readonly string[],
    options: AgentRunOptions,
  ): Promise<JudgeReport> {
    const artifactDir = path.resolve(options.artifactDir);
    const metadata: JudgeArtifactMetadata = {
      agent: "review-judge",
      status: "started",
      started_at: new Date().toISOString(),
      attempts: 0,
      decision_status: "not_attempted",
    };
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    await snapshotInputs(artifactDir, inputPaths);

    let lastDocument: string | undefined;
    let lastError: unknown;
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        metadata.attempts = attempt;
        const attemptDir = path.join(artifactDir, `attempt-${attempt}`);
        const message =
          attempt === 1
            ? "综合检视附加的 MR 上下文和三份专家 Markdown 报告。首行输出约定的 reviewx-decision 隐藏控制头；仅 NEW 裁决在其后输出 Markdown 问题卡片。"
            : `上一次输出不符合 reviewx-decision 或 NEW 评论模板：${redactText(lastError instanceof Error ? lastError.message : String(lastError))}\n请重新完成裁决，并严格使用以下四种首行之一：\n${judgeHeaders}\n首行不要使用 Markdown 代码围栏。NEW 正文必须严格使用：标题、严重等级、问题类型、位置、问题描述、影响、修复建议；不得加入置信度、适用规则、触发条件、证据或其他章节。`;
        lastDocument = await this.invokeText(
          "review-judge",
          worktreePath,
          inputPaths,
          { ...options, artifactDir: attemptDir },
          message,
          attempt,
        );
        await writeArtifact(attemptDir, "report.md", lastDocument);

        try {
          const report = parseJudgeDocument(lastDocument);
          metadata.decision_status = "succeeded";
          metadata.status = "succeeded";
          metadata.verdict = report.decision.verdict;
          metadata.finished_at = new Date().toISOString();
          await Promise.all([
            writeArtifact(artifactDir, "report.md", report.document),
            writeArtifact(
              artifactDir,
              "decision.json",
              `${JSON.stringify(report.decision, null, 2)}\n`,
            ),
            ...(report.decision.verdict === "NEW"
              ? [writeArtifact(artifactDir, "comment.md", report.markdown)]
              : []),
            writeArtifact(artifactDir, "metadata.json", `${JSON.stringify(metadata, null, 2)}\n`),
          ]);
          return report;
        } catch (error) {
          if (!(error instanceof JudgeDocumentError)) throw error;
          lastError = error;
          metadata.decision_status = "failed";
          await writeArtifact(attemptDir, "decision-error.txt", `${redactText(error.message)}\n`);
        }
      }

      throw new ReviewXError(
        "AGENT_ERROR",
        "Judge returned an invalid reviewx-decision header after one retry.",
        { cause: lastError },
      );
    } catch (error) {
      metadata.status = "failed";
      metadata.finished_at = new Date().toISOString();
      metadata.error = redactText(error instanceof Error ? error.message : String(error));
      await writeArtifact(artifactDir, "metadata.json", `${JSON.stringify(metadata, null, 2)}\n`);
      if (error instanceof ReviewXError && error.details?.agent === "review-judge") throw error;
      throw attachAgentContext(
        error,
        "review-judge",
        artifactDir,
        lastDocument,
        lastDocument === undefined ? undefined : "assistant_text",
      );
    }
  }
}

export { inlineConfig as openCodeInlineConfig };
