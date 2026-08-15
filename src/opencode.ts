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

interface OpenMarkdownFence {
  delimiter: "`" | "~";
  length: number;
  language: string;
  content: string[];
}

function extractSingleJsonFence(value: string): string | undefined {
  const blocks: Array<{ language: string; content: string }> = [];
  let open: OpenMarkdownFence | undefined;

  for (const line of value.split(/\r?\n/u)) {
    if (open) {
      const closing = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line);
      const closingRun = closing?.[1];
      if (
        closingRun &&
        closingRun[0] === open.delimiter &&
        closingRun.length >= open.length
      ) {
        blocks.push({ language: open.language, content: open.content.join("\n").trim() });
        open = undefined;
      } else {
        open.content.push(line);
      }
      continue;
    }

    const opening = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    const openingRun = opening?.[1];
    if (!openingRun) continue;
    open = {
      delimiter: openingRun[0] as "`" | "~",
      length: openingRun.length,
      language: (opening[2] ?? "").trim().toLowerCase(),
      content: [],
    };
  }

  if (open) {
    throw new ReviewXError("AGENT_ERROR", "Agent output has an unterminated Markdown fence.");
  }
  if (blocks.length === 0) return undefined;
  if (blocks.length !== 1) {
    throw new ReviewXError(
      "AGENT_ERROR",
      "Agent output must contain exactly one Markdown fenced block.",
    );
  }
  const [block] = blocks;
  if (block!.language !== "" && block!.language !== "json") {
    throw new ReviewXError(
      "AGENT_ERROR",
      "Agent output Markdown fence language must be empty or json.",
    );
  }
  return block!.content;
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

function parseAgentJsonText(combined: string): unknown {
  try {
    return JSON.parse(combined);
  } catch {
    // OpenCode's JSON format applies to its event stream, not the assistant's text format.
  }

  const fenced = extractSingleJsonFence(combined);
  if (fenced === undefined) {
    throw new ReviewXError("AGENT_ERROR", "Agent final text is not one valid JSON object.");
  }
  try {
    return JSON.parse(fenced);
  } catch (error) {
    throw new ReviewXError("AGENT_ERROR", "Agent final text is not one valid JSON object.", {
      cause: error,
    });
  }
}

export function parseOpenCodeText(stdout: string): unknown {
  return parseAgentJsonText(collectOpenCodeText(stdout));
}

type AgentName = ExpertName | "review-judge";

interface AgentInvocation {
  value: unknown;
  outputText: string;
}

function agentOutputDetails(agent: AgentName, output: string, source: AgentOutputSource) {
  const preview = diagnosticTextPreview(output);
  return {
    agent,
    agent_output: preview.text,
    agent_output_source: source,
    agent_output_chars: preview.originalCharacters,
    agent_output_truncated: preview.truncated,
  } as const;
}

function invalidAgentOutput(
  agent: AgentName,
  message: string,
  output: string,
  source: AgentOutputSource,
  cause?: unknown,
): ReviewXError {
  return new ReviewXError("AGENT_ERROR", message, {
    ...(cause === undefined ? {} : { cause }),
    details: agentOutputDetails(agent, output, source),
  });
}

export class OpenCodeClient {
  private readonly configDir: string;

  constructor(
    private readonly runner: CommandRunner = new DefaultCommandRunner(),
    private readonly executable = process.env.REVIEWX_OPENCODE_BIN ?? "opencode",
    configDir =
      process.env.REVIEWX_OPENCODE_CONFIG_DIR ??
      fileURLToPath(new URL("../opencode/", import.meta.url)),
  ) {
    this.configDir = path.resolve(configDir);
  }

  private async invoke(
    agent: ExpertName | "review-judge",
    worktreePath: string,
    inputPath: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<AgentInvocation> {
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
        "检视当前 MR 的最终整体净变化，只输出约定 JSON。",
      ],
      {
        cwd: worktreePath,
        env: sanitizedAgentEnv(this.configDir),
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
        maxOutputBytes: 20 * 1024 * 1024,
      },
    );
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
      const detail = redactText(error instanceof Error ? error.message : String(error));
      throw invalidAgentOutput(
        agent,
        `OpenCode agent ${agent} returned invalid output${detail ? `: ${detail}` : "."}`,
        result.stdout,
        "opencode_stdout",
        error,
      );
    }
    try {
      return { value: parseAgentJsonText(outputText), outputText };
    } catch (error) {
      const detail = redactText(error instanceof Error ? error.message : String(error));
      throw invalidAgentOutput(
        agent,
        `OpenCode agent ${agent} returned invalid output${detail ? `: ${detail}` : "."}`,
        outputText,
        "assistant_text",
        error,
      );
    }
  }

  async runExpert(
    expert: ExpertName,
    worktreePath: string,
    inputPath: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExpertResult> {
    const invocation = await this.invoke(expert, worktreePath, inputPath, timeoutMs, signal);
    let result: ExpertResult;
    try {
      result = expertResultSchema.parse(invocation.value);
    } catch (error) {
      if (error instanceof ReviewXError) throw error;
      throw invalidAgentOutput(
        expert,
        `Agent ${expert} returned an invalid result.`,
        invocation.outputText,
        "assistant_text",
        error,
      );
    }
    if (result.expert !== expert) {
      throw invalidAgentOutput(
        expert,
        `Agent ${expert} returned result for ${result.expert}.`,
        invocation.outputText,
        "assistant_text",
      );
    }
    return result;
  }

  async runJudge(
    worktreePath: string,
    inputPath: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JudgeResult> {
    const invocation = await this.invoke(
      "review-judge",
      worktreePath,
      inputPath,
      timeoutMs,
      signal,
    );
    try {
      return judgeResultSchema.parse(invocation.value);
    } catch (error) {
      if (error instanceof ReviewXError) throw error;
      throw invalidAgentOutput(
        "review-judge",
        "Judge returned an invalid result.",
        invocation.outputText,
        "assistant_text",
        error,
      );
    }
  }
}

export { inlineConfig as openCodeInlineConfig };
