import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  expertResultSchema,
  judgeResultSchema,
  type ExpertName,
  type ExpertResult,
  type JudgeResult,
} from "./contracts.js";
import { redactText, ReviewXError } from "./errors.js";
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

export function parseOpenCodeText(stdout: string): unknown {
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
  const combined = textParts.join("").trim();
  if (combined.startsWith("```") || combined.endsWith("```")) {
    throw new ReviewXError("AGENT_ERROR", "Agent output must be raw JSON without Markdown fences.");
  }
  try {
    return JSON.parse(combined);
  } catch (error) {
    throw new ReviewXError("AGENT_ERROR", "Agent final text is not one valid JSON object.", {
      cause: error,
    });
  }
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
  ): Promise<unknown> {
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
    return parseOpenCodeText(result.stdout);
  }

  async runExpert(
    expert: ExpertName,
    worktreePath: string,
    inputPath: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExpertResult> {
    try {
      const result = expertResultSchema.parse(
        await this.invoke(expert, worktreePath, inputPath, timeoutMs, signal),
      );
      if (result.expert !== expert) {
        throw new ReviewXError(
          "AGENT_ERROR",
          `Agent ${expert} returned result for ${result.expert}.`,
        );
      }
      return result;
    } catch (error) {
      if (error instanceof ReviewXError) throw error;
      throw new ReviewXError("AGENT_ERROR", `Agent ${expert} returned an invalid result.`, {
        cause: error,
      });
    }
  }

  async runJudge(
    worktreePath: string,
    inputPath: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JudgeResult> {
    try {
      return judgeResultSchema.parse(
        await this.invoke("review-judge", worktreePath, inputPath, timeoutMs, signal),
      );
    } catch (error) {
      if (error instanceof ReviewXError) throw error;
      throw new ReviewXError("AGENT_ERROR", "Judge returned an invalid result.", { cause: error });
    }
  }
}

export { inlineConfig as openCodeInlineConfig };
