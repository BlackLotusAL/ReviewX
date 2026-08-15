import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  expertResultSchema,
  judgeResultSchema,
  type AgentOutputSource,
  type ExpertName,
  type ExpertResult,
  type JudgeResult,
} from "./contracts.js";
import { processAgentOutputText, type AgentOutputStrategy } from "./agent-output.js";
import { diagnosticTextPreview, redactText, ReviewXError } from "./errors.js";
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
  const textParts: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new ReviewXError("AGENT_ERROR", "OpenCode emitted a non-JSON event.", { cause: error });
    }
    if (!event || typeof event !== "object") {
      throw new ReviewXError("AGENT_ERROR", "OpenCode emitted an invalid event.");
    }
    const value = event as { type?: unknown; part?: { text?: unknown }; error?: unknown };
    if (value.type === "error") {
      throw new ReviewXError("AGENT_ERROR", "OpenCode emitted an error event.");
    }
    if (value.type === "text") {
      if (!value.part || typeof value.part.text !== "string") {
        throw new ReviewXError("AGENT_ERROR", "OpenCode text event is missing part.text.");
      }
      textParts.push(value.part.text);
    }
  }
  if (textParts.length === 0) {
    throw new ReviewXError("AGENT_ERROR", "OpenCode returned no final assistant text.");
  }
  return textParts.join("").trim();
}

export function parseOpenCodeText(stdout: string): unknown {
  const processed = processAgentOutputText(collectOpenCodeText(stdout));
  if (!processed.success) {
    throw new ReviewXError("AGENT_ERROR", processed.error);
  }
  return processed.value;
}

type AgentName = ExpertName | "review-judge";

export interface AgentRunOptions {
  artifactDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

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
  strategy?: AgentOutputStrategy;
  candidate_chars?: number;
  processed_chars?: number;
  appended_closers?: string;
  parse_status: "not_attempted" | "succeeded" | "failed";
  schema_status: "not_attempted" | "succeeded" | "failed";
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

  private async invoke<T>(
    agent: AgentName,
    worktreePath: string,
    inputPath: string,
    options: AgentRunOptions,
    validate: (value: unknown) => T,
  ): Promise<T> {
    const artifactDir = path.resolve(options.artifactDir);
    const metadata: AgentArtifactMetadata = {
      agent,
      status: "started",
      started_at: new Date().toISOString(),
      ...(this.model === undefined ? {} : { model: this.model }),
      parse_status: "not_attempted",
      schema_status: "not_attempted",
    };
    let diagnosticOutput: string | undefined;
    let diagnosticSource: AgentOutputSource | undefined;
    try {
      await mkdir(artifactDir, { recursive: true, mode: 0o700 });
      const result = await this.runner.run(
        this.executable,
        [
          "run",
          "--pure",
          "--agent",
          agent,
          "--dir",
          worktreePath,
          "--file",
          inputPath,
          "--format",
          "json",
          ...(this.model === undefined ? [] : ["--model", this.model]),
          "检视当前 MR 的最终整体净变化，只输出约定 JSON。",
        ],
        {
          cwd: worktreePath,
          env: sanitizedAgentEnv(this.configDir),
          timeoutMs: options.timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          maxOutputBytes: 20 * 1024 * 1024,
        },
      );
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
        metadata.parse_status = "failed";
        const detail = redactText(error instanceof Error ? error.message : String(error));
        throw new ReviewXError(
          "AGENT_ERROR",
          `OpenCode agent ${agent} returned invalid output${detail ? `: ${detail}` : "."}`,
          { cause: error },
        );
      }
      diagnosticOutput = outputText;
      diagnosticSource = "assistant_text";
      metadata.assistant_chars = outputText.length;
      await writeArtifact(artifactDir, "assistant.txt", outputText);

      const processed = processAgentOutputText(outputText);
      const attempt = processed.success ? processed : processed.attempt;
      if (attempt) {
        metadata.strategy = attempt.strategy;
        metadata.candidate_chars = attempt.candidateText.length;
        metadata.appended_closers = attempt.appendedClosers;
        await writeArtifact(artifactDir, "candidate.txt", attempt.candidateText);
        if (attempt.processedText !== undefined) {
          metadata.processed_chars = attempt.processedText.length;
          await writeArtifact(artifactDir, "processed.txt", attempt.processedText);
        }
      }
      if (!processed.success) {
        metadata.parse_status = "failed";
        throw new ReviewXError(
          "AGENT_ERROR",
          `OpenCode agent ${agent} returned invalid output: ${processed.error}`,
        );
      }
      metadata.parse_status = "succeeded";

      let validated: T;
      try {
        validated = validate(processed.value);
      } catch (error) {
        metadata.schema_status = "failed";
        throw error;
      }
      metadata.schema_status = "succeeded";
      await writeArtifact(artifactDir, "result.json", `${JSON.stringify(validated, null, 2)}\n`);
      metadata.status = "succeeded";
      metadata.finished_at = new Date().toISOString();
      await writeArtifact(artifactDir, "metadata.json", `${JSON.stringify(metadata, null, 2)}\n`);
      return validated;
    } catch (error) {
      metadata.status = "failed";
      metadata.finished_at = new Date().toISOString();
      metadata.error = redactText(error instanceof Error ? error.message : String(error));
      await mkdir(artifactDir, { recursive: true, mode: 0o700 });
      await writeArtifact(artifactDir, "metadata.json", `${JSON.stringify(metadata, null, 2)}\n`);
      throw attachAgentContext(
        error,
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
  ): Promise<ExpertResult> {
    return await this.invoke(expert, worktreePath, inputPath, options, (value) => {
      let result: ExpertResult;
      try {
        result = expertResultSchema.parse(value);
      } catch (error) {
        throw new ReviewXError("AGENT_ERROR", `Agent ${expert} returned an invalid result.`, {
          cause: error,
        });
      }
      if (result.expert !== expert) {
        throw new ReviewXError(
          "AGENT_ERROR",
          `Agent ${expert} returned result for ${result.expert}.`,
        );
      }
      return result;
    });
  }

  async runJudge(
    worktreePath: string,
    inputPath: string,
    options: AgentRunOptions,
  ): Promise<JudgeResult> {
    return await this.invoke(
      "review-judge",
      worktreePath,
      inputPath,
      options,
      (value) => {
        try {
          return judgeResultSchema.parse(value);
        } catch (error) {
          throw new ReviewXError("AGENT_ERROR", "Judge returned an invalid result.", {
            cause: error,
          });
        }
      },
    );
  }
}

export { inlineConfig as openCodeInlineConfig };
