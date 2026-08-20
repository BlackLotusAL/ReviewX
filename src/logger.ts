import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentProgressSummary } from "./agent-progress.js";
import type { ExpertName, ReviewResult, Severity } from "./contracts.js";
import { redactText, ReviewXError } from "./errors.js";

export type LogLevel = "info" | "warn" | "error";
export type AgentName = ExpertName | "review-judge";

interface ReviewContext {
  run_id: string;
  repo_id: string;
  mr_iid: string;
}

interface AgentProgressContext extends ReviewContext {
  agent: AgentName;
  attempt?: number;
  step: number;
}

export type LogEvent =
  | { level: "info"; event: "scan_started" }
  | { level: "info"; event: "repository_scan_started"; repo_id: string }
  | {
      level: "info";
      event: "repository_scan_finished";
      repo_id: string;
      merge_request_count: number;
      pending_review_count: number;
      duration_ms: number;
    }
  | {
      level: "warn";
      event: "repository_scan_failed";
      repo_id: string;
      duration_ms: number;
      error: string;
    }
  | {
      level: "info";
      event: "scan_finished";
      repository_count: number;
      pending_review_count: number;
      completed_review_count: number;
      failure_count: number;
      duration_ms: number;
    }
  | ({ level: "info"; event: "review_run_started"; updated_at: string } & ReviewContext)
  | ({ level: "info"; event: "worktree_prepare_started" } & ReviewContext)
  | ({
      level: "info";
      event: "worktree_prepare_finished";
      cache: "existing" | "created";
      duration_ms: number;
    } & ReviewContext)
  | ({
      level: "error";
      event: "worktree_prepare_failed";
      duration_ms: number;
      error: string;
    } & ReviewContext)
  | ({ level: "info"; event: "commits_load_started" } & ReviewContext)
  | ({
      level: "info";
      event: "commits_load_finished";
      commit_count: number;
      duration_ms: number;
    } & ReviewContext)
  | ({
      level: "error";
      event: "commits_load_failed";
      duration_ms: number;
      error: string;
    } & ReviewContext)
  | ({ level: "info"; event: "agent_started"; agent: AgentName } & ReviewContext)
  | ({
      level: "info";
      event: "agent_process_ready";
      startup_ms: number;
    } & AgentProgressContext)
  | ({ level: "info"; event: "agent_step_started" } & AgentProgressContext)
  | ({
      level: "info";
      event: "agent_tool_started";
      tool: string;
      action?: string;
    } & AgentProgressContext)
  | ({
      level: "info" | "warn";
      event: "agent_tool_finished";
      tool: string;
      action?: string;
      status: "completed" | "failed";
      duration_ms?: number;
    } & AgentProgressContext)
  | ({
      level: "info";
      event: "agent_step_finished";
      reason?: string;
      duration_ms?: number;
      model_until_action_ms?: number;
      text_generation_ms?: number;
      input_tokens?: number;
      output_tokens?: number;
      reasoning_tokens?: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
    } & AgentProgressContext)
  | ({
      level: "info";
      event: "agent_waiting";
      last_event: string;
      idle_ms: number;
    } & AgentProgressContext)
  | ({
      level: "info";
      event: "agent_progress_summary";
      summary: AgentProgressSummary;
    } & AgentProgressContext)
  | ({
      level: "info";
      event: "agent_finished";
      agent: AgentName;
      verdict?: "PASS" | "DUPLICATE" | "NEW";
      report_chars?: number;
      severity?: Severity;
      duplicate_of_comment_id?: string | null;
      duration_ms: number;
    } & ReviewContext)
  | ({
      level: "error";
      event: "agent_failed";
      agent: AgentName;
      duration_ms: number;
      error: string;
    } & ReviewContext)
  | ({ level: "info"; event: "comment_publish_started"; severity: Severity } & ReviewContext)
  | ({
      level: "info";
      event: "comment_publish_finished";
      comment_id: string;
      duration_ms: number;
    } & ReviewContext)
  | ({
      level: "warn";
      event: "comment_publish_skipped";
      reason: "closed" | "updated";
      duration_ms: number;
    } & ReviewContext)
  | ({
      level: "warn";
      event: "comment_publish_unknown";
      duration_ms: number;
      error: string;
    } & ReviewContext)
  | ({
      level: "error";
      event: "comment_publish_failed";
      duration_ms: number;
      error: string;
    } & ReviewContext)
  | ({
      level: "info";
      event: "state_saved";
      operation: "cursor" | "finding_history";
      duration_ms: number;
      updated_at?: string;
      publication_status?: "confirmed" | "unknown";
      comment_id?: string | null;
    } & ReviewContext)
  | ({
      level: "error";
      event: "state_save_failed";
      operation: "cursor" | "finding_history";
      duration_ms: number;
      error: string;
    } & ReviewContext)
  | ({ level: "info"; event: "cleanup_started" } & ReviewContext)
  | ({ level: "info"; event: "cleanup_finished"; duration_ms: number } & ReviewContext)
  | ({
      level: "warn";
      event: "cleanup_failed";
      duration_ms: number;
      error: string;
    } & ReviewContext)
  | ({
      level: LogLevel;
      event: "review_run_finished";
      updated_at: string;
      result: ReviewResult;
      duration_ms: number;
      error?: string;
      duplicate_of_comment_id?: string | null;
      comment_id?: string | null;
    } & ReviewContext)
  | { level: "error"; event: "runtime_error"; error: string };

export type LogRecord = LogEvent & { time: string };
export type LogInput = LogEvent & { time?: string };

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function formatLocalIsoTimestamp(date: Date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / 60);
  const offsetRemainder = absoluteOffset % 60;
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offsetSign}${pad(offsetHours)}:${pad(offsetRemainder)}`;
}

function elapsed(duration: number): number {
  return Math.max(0, Math.round(duration));
}

function oneLine(value: unknown): string {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

export function shortRunId(runId: string): string {
  return runId.replaceAll("-", "").slice(0, 8).toLowerCase();
}

function reviewContext(record: ReviewContext): string {
  return `review run ${shortRunId(record.run_id)} on repository ${oneLine(record.repo_id)}, MR ${oneLine(record.mr_iid)}`;
}

function agentProgressContext(record: AgentProgressContext): string {
  const attempt = record.attempt === undefined ? "" : `, attempt ${record.attempt}`;
  return `Agent ${record.agent}${attempt}, step ${record.step} for ${reviewContext(record)}`;
}

function actionDetail(action: string | undefined): string {
  return action === undefined ? "" : ` (${oneLine(action)})`;
}

function timingDetail(label: string, value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${label} ${elapsed(value)}ms`;
}

function stepMetrics(
  record: Extract<LogEvent, { event: "agent_step_finished" }>,
): string {
  const timings = [
    timingDetail("total", record.duration_ms),
    timingDetail("model-to-action", record.model_until_action_ms),
    timingDetail("text-generation", record.text_generation_ms),
  ].filter((value): value is string => value !== undefined);
  const tokens = [
    record.input_tokens === undefined ? undefined : `input ${record.input_tokens}`,
    record.output_tokens === undefined ? undefined : `output ${record.output_tokens}`,
    record.reasoning_tokens === undefined ? undefined : `reasoning ${record.reasoning_tokens}`,
    record.cache_read_tokens === undefined
      ? undefined
      : `cache-read ${record.cache_read_tokens}`,
    record.cache_write_tokens === undefined
      ? undefined
      : `cache-write ${record.cache_write_tokens}`,
  ].filter((value): value is string => value !== undefined);
  const parts = [
    ...(record.reason === undefined ? [] : [`reason ${oneLine(record.reason)}`]),
    ...(timings.length === 0 ? [] : [timings.join(", ")]),
    ...(tokens.length === 0 ? [] : [`tokens ${tokens.join(", ")}`]),
  ];
  return parts.length === 0 ? "" : ` with ${parts.join("; ")}`;
}

function safeError(error: string, runId?: string): string {
  const redacted = redactText(error);
  const shortened = runId === undefined ? redacted : redacted.replaceAll(runId, shortRunId(runId));
  return oneLine(shortened);
}

function agentResult(record: Extract<LogEvent, { event: "agent_finished" }>): string {
  if (record.agent !== "review-judge") {
    return `a Markdown report with ${record.report_chars ?? 0} characters`;
  }
  if (record.verdict === "NEW" && record.severity !== undefined) {
    return `verdict NEW and selected severity ${record.severity}`;
  }
  if (record.verdict === "DUPLICATE") {
    return `verdict DUPLICATE and duplicate comment ${oneLine(record.duplicate_of_comment_id ?? "unknown")}`;
  }
  return `verdict ${record.verdict}`;
}

function stateSavedDetail(record: Extract<LogEvent, { event: "state_saved" }>): string {
  const context = reviewContext(record);
  if (record.operation === "cursor") {
    return `Saved the review cursor at ${oneLine(record.updated_at ?? "unknown")} in ${elapsed(record.duration_ms)}ms for ${context}.`;
  }
  const status = record.publication_status ?? "unknown";
  const comment = record.comment_id === undefined ? "" : ` with comment ${oneLine(record.comment_id ?? "unknown")}`;
  const cursor = record.updated_at === undefined
    ? ""
    : ` and saved the review cursor at ${oneLine(record.updated_at)}`;
  return `Appended ${status} finding history${comment}${cursor} in ${elapsed(record.duration_ms)}ms for ${context}.`;
}

function reviewFinishedDetail(record: Extract<LogEvent, { event: "review_run_finished" }>): string {
  let detail = `Review run ${shortRunId(record.run_id)} finished with result ${record.result} in ${elapsed(record.duration_ms)}ms on repository ${oneLine(record.repo_id)}, MR ${oneLine(record.mr_iid)}`;
  if (record.result === "new" && record.comment_id !== undefined) {
    detail += ` with comment ${oneLine(record.comment_id ?? "unknown")}`;
  } else if (record.result === "duplicate_of") {
    detail += ` with duplicate comment ${oneLine(record.duplicate_of_comment_id ?? "unknown")}`;
  } else if (record.result === "failed" && record.error !== undefined) {
    detail += `: ${safeError(record.error, record.run_id)}`;
  }
  return `${detail}.`;
}

function logDetail(record: LogRecord): string {
  switch (record.event) {
    case "scan_started":
      return "Scan started.";
    case "repository_scan_started":
      return `Scanning repository ${oneLine(record.repo_id)}.`;
    case "repository_scan_finished":
      return `Repository ${oneLine(record.repo_id)} scan finished with ${record.merge_request_count} merge requests and ${record.pending_review_count} pending reviews in ${elapsed(record.duration_ms)}ms.`;
    case "repository_scan_failed":
      return `Repository ${oneLine(record.repo_id)} scan failed after ${elapsed(record.duration_ms)}ms: ${safeError(record.error)}`;
    case "scan_finished":
      return `Scan finished after checking ${record.repository_count} repositories: ${record.pending_review_count} reviews pending, ${record.completed_review_count} completed, and ${record.failure_count} failed in ${elapsed(record.duration_ms)}ms.`;
    case "review_run_started":
      return `Review run ${shortRunId(record.run_id)} started for repository ${oneLine(record.repo_id)}, MR ${oneLine(record.mr_iid)}, updated at ${oneLine(record.updated_at)}.`;
    case "worktree_prepare_started":
      return `Preparing the worktree for ${reviewContext(record)}.`;
    case "worktree_prepare_finished": {
      const cache = record.cache === "existing" ? "the existing repository cache" : "a newly created repository cache";
      return `Worktree preparation finished using ${cache} in ${elapsed(record.duration_ms)}ms for ${reviewContext(record)}.`;
    }
    case "worktree_prepare_failed":
      return `Worktree preparation failed after ${elapsed(record.duration_ms)}ms for ${reviewContext(record)}: ${safeError(record.error, record.run_id)}`;
    case "commits_load_started":
      return `Loading commits for ${reviewContext(record)}.`;
    case "commits_load_finished":
      return `Loaded ${record.commit_count} commits in ${elapsed(record.duration_ms)}ms for ${reviewContext(record)}.`;
    case "commits_load_failed":
      return `Commit loading failed after ${elapsed(record.duration_ms)}ms for ${reviewContext(record)}: ${safeError(record.error, record.run_id)}`;
    case "agent_started":
      return `Agent ${record.agent} started for ${reviewContext(record)}.`;
    case "agent_process_ready":
      return `${agentProgressContext(record)} produced its first OpenCode event after ${elapsed(record.startup_ms)}ms.`;
    case "agent_step_started":
      return `${agentProgressContext(record)} started.`;
    case "agent_tool_started":
      return `${agentProgressContext(record)} started tool ${oneLine(record.tool)}${actionDetail(record.action)}.`;
    case "agent_tool_finished":
      return `${agentProgressContext(record)} finished tool ${oneLine(record.tool)}${actionDetail(record.action)} with status ${record.status}${record.duration_ms === undefined ? "" : ` in ${elapsed(record.duration_ms)}ms`}.`;
    case "agent_step_finished":
      return `${agentProgressContext(record)} finished${stepMetrics(record)}.`;
    case "agent_waiting":
      return `${agentProgressContext(record)} produced no OpenCode event for ${elapsed(record.idle_ms)}ms after ${oneLine(record.last_event)}.`;
    case "agent_progress_summary": {
      const summary = record.summary;
      const startup = summary.startup_ms === undefined
        ? "startup unknown"
        : `startup ${elapsed(summary.startup_ms)}ms`;
      return `${agentProgressContext(record)} completed progress tracking with ${summary.steps} steps and ${summary.tool_calls} tool calls; ${startup}, step total ${elapsed(summary.step_duration_ms)}ms, tool total ${elapsed(summary.tool_duration_ms)}ms; tokens input ${summary.input_tokens}, output ${summary.output_tokens}, reasoning ${summary.reasoning_tokens}, cache-read ${summary.cache_read_tokens}, cache-write ${summary.cache_write_tokens}.`;
    }
    case "agent_finished":
      return `Agent ${record.agent} finished with ${agentResult(record)} in ${elapsed(record.duration_ms)}ms for ${reviewContext(record)}.`;
    case "agent_failed":
      return `Agent ${record.agent} failed after ${elapsed(record.duration_ms)}ms for ${reviewContext(record)}: ${safeError(record.error, record.run_id)}`;
    case "comment_publish_started":
      return `Publishing a ${record.severity} review comment for ${reviewContext(record)}.`;
    case "comment_publish_finished":
      return `Published comment ${oneLine(record.comment_id)} in ${elapsed(record.duration_ms)}ms for ${reviewContext(record)}.`;
    case "comment_publish_skipped":
      return `Comment publication was skipped because the merge request was ${record.reason} after ${elapsed(record.duration_ms)}ms for ${reviewContext(record)}.`;
    case "comment_publish_unknown":
      return `Comment publication result was unknown after ${elapsed(record.duration_ms)}ms for ${reviewContext(record)}: ${safeError(record.error, record.run_id)}`;
    case "comment_publish_failed":
      return `Comment publication failed after ${elapsed(record.duration_ms)}ms for ${reviewContext(record)}: ${safeError(record.error, record.run_id)}`;
    case "state_saved":
      return stateSavedDetail(record);
    case "state_save_failed":
      return `Saving ${record.operation === "cursor" ? "the review cursor" : "finding history"} failed after ${elapsed(record.duration_ms)}ms for ${reviewContext(record)}: ${safeError(record.error, record.run_id)}`;
    case "cleanup_started":
      return `Cleanup started for ${reviewContext(record)}.`;
    case "cleanup_finished":
      return `Cleanup finished in ${elapsed(record.duration_ms)}ms for ${reviewContext(record)}.`;
    case "cleanup_failed":
      return `Cleanup finished with warnings after ${elapsed(record.duration_ms)}ms for ${reviewContext(record)}: ${safeError(record.error, record.run_id)}`;
    case "review_run_finished":
      return reviewFinishedDetail(record);
    case "runtime_error":
      return `Runtime failed: ${safeError(record.error)}`;
  }
}

export function formatLogLine(record: LogRecord): string {
  return `[${oneLine(record.time)}] [${record.level.toUpperCase()}] [${record.event}] ${logDetail(record)}\n`;
}

export class TextLogger {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly logPath: string,
    private readonly writeStdout: (line: string) => void = (line) => {
      process.stdout.write(line);
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(input: LogInput): Promise<void> {
    const record = {
      ...input,
      time: input.time ?? formatLocalIsoTimestamp(this.now()),
    } as LogRecord;
    const line = formatLogLine(record);
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(path.dirname(this.logPath), { recursive: true });
        await appendFile(this.logPath, line, "utf8");
        this.writeStdout(line);
      } catch (error) {
        throw new ReviewXError("LOG_ERROR", `Unable to write log file: ${this.logPath}`, {
          cause: error,
        });
      }
    });
    return this.queue;
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}
