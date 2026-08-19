import path from "node:path";
import { performance } from "node:perf_hooks";
import { redactText } from "./errors.js";

const defaultHeartbeatMs = 60_000;
const maxActionCharacters = 300;

export interface AgentProgressSummary {
  startup_ms?: number;
  steps: number;
  tool_calls: number;
  step_duration_ms: number;
  tool_duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export type AgentProgressEvent =
  | { type: "process_ready"; step: 0; startup_ms: number }
  | { type: "step_started"; step: number }
  | {
      type: "tool_started";
      step: number;
      tool: string;
      action?: string;
    }
  | {
      type: "tool_finished";
      step: number;
      tool: string;
      action?: string;
      status: "completed" | "failed";
      duration_ms?: number;
    }
  | {
      type: "step_finished";
      step: number;
      reason?: string;
      duration_ms?: number;
      model_until_action_ms?: number;
      text_generation_ms?: number;
      input_tokens?: number;
      output_tokens?: number;
      reasoning_tokens?: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
    }
  | {
      type: "waiting";
      step: number;
      last_event: string;
      idle_ms: number;
    }
  | { type: "summary"; step: number; summary: AgentProgressSummary };

export interface AgentProgressTrackerOptions {
  heartbeatMs?: number;
  monotonicNow?: () => number;
}

interface StepState {
  index: number;
  startedAt?: number;
  firstActionAt?: number;
  textGenerationMs: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function elapsed(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined || end < start) return undefined;
  return Math.round(end - start);
}

function compact(value: string): string {
  return redactText(value).replace(/[\r\n\t ]+/gu, " ").trim().slice(0, maxActionCharacters);
}

function withinWorktree(worktreePath: string, target: string): string {
  const resolved = path.resolve(worktreePath, target);
  const relative = path.relative(path.resolve(worktreePath), resolved);
  if (relative === "") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "[external]";
  return relative.replaceAll("\\", "/");
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.trim() !== "" ? field : undefined;
}

function summarizeBashCommand(worktreePath: string, command: string): string {
  const worktree = path.resolve(worktreePath);
  const relativeCommand = command
    .replaceAll(worktree, ".")
    .replaceAll(worktree.replaceAll("\\", "/"), ".");
  const gitCommands = relativeCommand
    .split(/\s*(?:;|&&?|\|\|?|\r?\n)\s*/u)
    .map((part) => part.trim())
    .filter((part) => /^git\s+(status|log|show|diff)(?:\s|$)/u.test(part));
  if (gitCommands.length === 0) return "command=[redacted]";
  const safeCommand = gitCommands.join("; ");
  const containsExternalAbsolutePath =
    /[A-Za-z]:[\\/]/u.test(safeCommand) ||
    /(^|[\s"'=])\/(?!\/)/u.test(safeCommand);
  if (!containsExternalAbsolutePath) return compact(`command=${safeCommand}`);
  const gitFamilies = [...safeCommand.matchAll(/\bgit\s+(status|log|show|diff)\b/gu)]
    .map((match) => `git ${match[1]}`);
  return compact(
    `command=${gitFamilies.length === 0 ? "[redacted]" : gitFamilies.join("; ")} [external]`,
  );
}

export function summarizeToolAction(
  worktreePath: string,
  tool: string,
  rawInput: unknown,
): string | undefined {
  const input = record(rawInput);
  if (!input) return undefined;
  if (tool === "read" || tool === "list") {
    const target = stringField(input, "filePath") ?? stringField(input, "path");
    if (target === undefined) return undefined;
    const offset = nonNegativeNumber(input.offset);
    const limit = nonNegativeNumber(input.limit);
    const range = offset === undefined && limit === undefined
      ? ""
      : ` offset=${offset ?? 0}${limit === undefined ? "" : ` limit=${limit}`}`;
    return compact(`path=${withinWorktree(worktreePath, target)}${range}`);
  }
  if (tool === "grep" || tool === "glob") {
    const pattern = stringField(input, "pattern");
    const target = stringField(input, "path");
    const include = stringField(input, "include");
    const pieces = [
      ...(pattern === undefined ? [] : [`pattern=${pattern}`]),
      ...(target === undefined ? [] : [`path=${withinWorktree(worktreePath, target)}`]),
      ...(include === undefined ? [] : [`include=${include}`]),
    ];
    return pieces.length === 0 ? undefined : compact(pieces.join(" "));
  }
  if (tool === "bash") {
    const command = stringField(input, "command");
    if (command === undefined) return undefined;
    return summarizeBashCommand(worktreePath, command);
  }
  return undefined;
}

export class AgentProgressTracker {
  private readonly heartbeatMs: number;
  private readonly monotonicNow: () => number;
  private readonly invokedAt: number;
  private readonly stepsByMessage = new Map<string, StepState>();
  private readonly startedTools = new Set<string>();
  private readonly finishedTools = new Set<string>();
  private readonly summaryValue: AgentProgressSummary = {
    steps: 0,
    tool_calls: 0,
    step_duration_ms: 0,
    tool_duration_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
  private currentStep: StepState | undefined;
  private lastActivityAt: number;
  private lastEvent = "process_started";
  private heartbeatCount = 0;
  private ready = false;
  private closed = false;
  private backgroundError: unknown;
  private queue: Promise<void> = Promise.resolve();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly worktreePath: string,
    private readonly emit: (event: AgentProgressEvent) => void | Promise<void>,
    options: AgentProgressTrackerOptions = {},
  ) {
    this.heartbeatMs = options.heartbeatMs ?? defaultHeartbeatMs;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.invokedAt = this.monotonicNow();
    this.lastActivityAt = this.invokedAt;
    this.heartbeat = setInterval(() => this.emitHeartbeat(), this.heartbeatMs);
    this.heartbeat.unref();
  }

  private enqueue(event: AgentProgressEvent): Promise<void> {
    const task = this.queue.then(async () => await this.emit(event));
    this.queue = task.catch((error: unknown) => {
      this.backgroundError ??= error;
    });
    return task;
  }

  private emitHeartbeat(): void {
    if (this.closed || this.backgroundError !== undefined) return;
    const idleMs = Math.max(0, Math.round(this.monotonicNow() - this.lastActivityAt));
    const heartbeatCount = Math.floor(idleMs / this.heartbeatMs);
    if (heartbeatCount <= this.heartbeatCount) return;
    this.heartbeatCount = heartbeatCount;
    void this.enqueue({
      type: "waiting",
      step: this.currentStep?.index ?? 0,
      last_event: this.lastEvent,
      idle_ms: idleMs,
    }).catch(() => {});
  }

  private async markReady(): Promise<void> {
    if (this.ready) return;
    this.ready = true;
    const startupMs = Math.max(0, Math.round(this.monotonicNow() - this.invokedAt));
    this.summaryValue.startup_ms = startupMs;
    await this.enqueue({ type: "process_ready", step: 0, startup_ms: startupMs });
  }

  private async ensureStep(messageId: string | undefined, timestamp?: number): Promise<StepState> {
    const existing = messageId === undefined ? undefined : this.stepsByMessage.get(messageId);
    if (existing !== undefined) {
      this.currentStep = existing;
      return existing;
    }
    const step: StepState = {
      index: this.summaryValue.steps + 1,
      ...(timestamp === undefined ? {} : { startedAt: timestamp }),
      textGenerationMs: 0,
    };
    this.summaryValue.steps = step.index;
    if (messageId !== undefined) this.stepsByMessage.set(messageId, step);
    this.currentStep = step;
    await this.enqueue({ type: "step_started", step: step.index });
    return step;
  }

  private toolKey(part: Record<string, unknown>, tool: string, timestamp?: number): string {
    return stringField(part, "callID") ?? `${stringField(part, "messageID") ?? "unknown"}:${tool}:${timestamp ?? "unknown"}`;
  }

  private async handleTool(part: Record<string, unknown>, timestamp?: number): Promise<void> {
    const tool = stringField(part, "tool") ?? "unknown";
    const state = record(part.state);
    const status = stringField(state, "status") ?? "unknown";
    const messageId = stringField(part, "messageID");
    const time = record(state?.time);
    const startedAt = nonNegativeNumber(time?.start) ?? timestamp;
    const endedAt = nonNegativeNumber(time?.end);
    const step = await this.ensureStep(messageId, timestamp);
    if (startedAt !== undefined && (step.firstActionAt === undefined || startedAt < step.firstActionAt)) {
      step.firstActionAt = startedAt;
    }
    const key = this.toolKey(part, tool, timestamp);
    const action = summarizeToolAction(this.worktreePath, tool, state?.input);
    if ((status === "pending" || status === "running") && !this.startedTools.has(key)) {
      this.startedTools.add(key);
      await this.enqueue({
        type: "tool_started",
        step: step.index,
        tool: compact(tool),
        ...(action === undefined ? {} : { action }),
      });
      return;
    }
    if (!["completed", "error", "failed"].includes(status) || this.finishedTools.has(key)) return;
    this.finishedTools.add(key);
    const durationMs = elapsed(startedAt, endedAt);
    this.summaryValue.tool_calls += 1;
    if (durationMs !== undefined) this.summaryValue.tool_duration_ms += durationMs;
    await this.enqueue({
      type: "tool_finished",
      step: step.index,
      tool: compact(tool),
      ...(action === undefined ? {} : { action }),
      status: status === "completed" ? "completed" : "failed",
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    });
  }

  private async handleText(part: Record<string, unknown>, timestamp?: number): Promise<void> {
    const step = await this.ensureStep(stringField(part, "messageID"), timestamp);
    const time = record(part.time);
    const startedAt = nonNegativeNumber(time?.start) ?? timestamp;
    const endedAt = nonNegativeNumber(time?.end);
    if (startedAt !== undefined && (step.firstActionAt === undefined || startedAt < step.firstActionAt)) {
      step.firstActionAt = startedAt;
    }
    const generationMs = elapsed(startedAt, endedAt);
    if (generationMs !== undefined) step.textGenerationMs += generationMs;
  }

  private token(part: Record<string, unknown>, name: string): number | undefined {
    return nonNegativeNumber(record(part.tokens)?.[name]);
  }

  private async handleStepFinish(part: Record<string, unknown>, timestamp?: number): Promise<void> {
    const step = await this.ensureStep(stringField(part, "messageID"), timestamp);
    const inputTokens = this.token(part, "input");
    const outputTokens = this.token(part, "output");
    const reasoningTokens = this.token(part, "reasoning");
    const cache = record(record(part.tokens)?.cache);
    const cacheReadTokens = nonNegativeNumber(cache?.read);
    const cacheWriteTokens = nonNegativeNumber(cache?.write);
    const durationMs = elapsed(step.startedAt, timestamp);
    const modelUntilActionMs = elapsed(step.startedAt, step.firstActionAt);
    if (durationMs !== undefined) this.summaryValue.step_duration_ms += durationMs;
    this.summaryValue.input_tokens += inputTokens ?? 0;
    this.summaryValue.output_tokens += outputTokens ?? 0;
    this.summaryValue.reasoning_tokens += reasoningTokens ?? 0;
    this.summaryValue.cache_read_tokens += cacheReadTokens ?? 0;
    this.summaryValue.cache_write_tokens += cacheWriteTokens ?? 0;
    await this.enqueue({
      type: "step_finished",
      step: step.index,
      ...(stringField(part, "reason") === undefined
        ? {}
        : { reason: compact(stringField(part, "reason")!) }),
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
      ...(modelUntilActionMs === undefined
        ? {}
        : { model_until_action_ms: modelUntilActionMs }),
      ...(step.textGenerationMs === 0
        ? {}
        : { text_generation_ms: step.textGenerationMs }),
      ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
      ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
      ...(reasoningTokens === undefined ? {} : { reasoning_tokens: reasoningTokens }),
      ...(cacheReadTokens === undefined ? {} : { cache_read_tokens: cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cache_write_tokens: cacheWriteTokens }),
    });
  }

  async handleLine(line: string): Promise<void> {
    if (this.closed) return;
    if (this.backgroundError !== undefined) throw this.backgroundError;
    if (line.trim() === "") return;
    this.lastActivityAt = this.monotonicNow();
    this.heartbeatCount = 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.lastEvent = "invalid_json";
      return;
    }
    const event = record(parsed);
    if (!event) {
      this.lastEvent = "invalid_event";
      return;
    }
    const type = stringField(event, "type") ?? "unknown";
    this.lastEvent = compact(type);
    await this.markReady();
    const part = record(event.part);
    const timestamp = nonNegativeNumber(event.timestamp);
    if (type === "step_start") {
      await this.ensureStep(stringField(part, "messageID"), timestamp);
    } else if (type === "tool_use" && part !== undefined) {
      await this.handleTool(part, timestamp);
    } else if (type === "text" && part !== undefined) {
      await this.handleText(part, timestamp);
    } else if (type === "step_finish" && part !== undefined) {
      await this.handleStepFinish(part, timestamp);
    }
  }

  summary(): AgentProgressSummary {
    return { ...this.summaryValue };
  }

  async finish(): Promise<AgentProgressSummary> {
    if (this.closed) {
      await this.queue;
      if (this.backgroundError !== undefined) throw this.backgroundError;
      return this.summary();
    }
    this.closed = true;
    clearInterval(this.heartbeat);
    if (this.backgroundError !== undefined) throw this.backgroundError;
    await this.enqueue({
      type: "summary",
      step: this.summaryValue.steps,
      summary: this.summary(),
    });
    await this.queue;
    if (this.backgroundError !== undefined) throw this.backgroundError;
    return this.summary();
  }
}
