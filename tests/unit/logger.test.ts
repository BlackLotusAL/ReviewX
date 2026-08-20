import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatLocalTimestamp,
  formatLogLine,
  shortRunId,
  TextLogger,
} from "../../src/logger.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

function localDate(hour = 18): Date {
  return {
    getFullYear: () => 2026,
    getMonth: () => 7,
    getDate: () => 15,
    getHours: () => hour,
    getMinutes: () => 20,
    getSeconds: () => 30,
    getMilliseconds: () => 123,
  } as Date;
}

describe("text logger", () => {
  it("formats local time as YYYY-MM-DD HH:mm:ss.SSS", () => {
    expect(formatLocalTimestamp(localDate())).toBe("2026-08-15 18:20:30.123");
  });

  it("reads the local clock again for every generated log line", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-log-"));
    roots.push(root);
    const output: string[] = [];
    let hour = 18;
    const logger = new TextLogger(
      path.join(root, "events.log"),
      (line) => output.push(line),
      () => localDate(hour),
    );
    await logger.write({ level: "info", event: "scan_started" });
    hour = 19;
    await logger.write({ level: "info", event: "scan_started" });
    expect(output[0]!).toMatch(/^\[2026-08-15 18:20:30\.123\]/u);
    expect(output[1]!).toMatch(/^\[2026-08-15 19:20:30\.123\]/u);
  });

  it("writes byte-identical ordered text lines to file and stdout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-log-"));
    roots.push(root);
    const output: string[] = [];
    const target = path.join(root, "nested", "events.log");
    const logger = new TextLogger(target, (line) => output.push(line));
    await Promise.all([
      logger.write({
        time: "2026-08-15 10:20:30.123",
        level: "info",
        event: "scan_started",
      }),
      logger.write({
        time: "2026-08-15 10:20:31.123",
        level: "info",
        event: "scan_finished",
        repository_count: 2,
        pending_review_count: 1,
        completed_review_count: 1,
        failure_count: 0,
        duration_ms: 1_000,
      }),
    ]);
    await logger.flush();
    expect(output.join("")).toBe(await readFile(target, "utf8"));
    expect(output).toEqual([
      "[2026-08-15 10:20:30.123] [INFO] [scan_started] Scan started.\n",
      "[2026-08-15 10:20:31.123] [INFO] [scan_finished] Scan finished after checking 2 repositories: 1 reviews pending, 1 completed, and 0 failed in 1000ms.\n",
    ]);
  });

  it("formats warnings as one line and redacts credentials", () => {
    expect(
      formatLogLine({
        time: "2026-08-15 10:20:30.123",
        level: "warn",
        event: "repository_scan_failed",
        repo_id: "12",
        duration_ms: 25,
        error: "failure\r\npassword=secret",
      }),
    ).toBe(
      "[2026-08-15 10:20:30.123] [WARN] [repository_scan_failed] Repository 12 scan failed after 25ms: failure\\r\\npassword=***\n",
    );
  });

  it("uses an eight-character run reference without exposing the full UUID", () => {
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    expect(shortRunId(runId)).toBe("550e8400");
    const line = formatLogLine({
      time: "2026-08-15 10:20:30.123",
      level: "error",
      event: "agent_failed",
      run_id: runId,
      repo_id: "123",
      mr_iid: "45",
      agent: "business-reviewer",
      duration_ms: 544,
      error: `Artifact ${runId} failed.`,
    });
    expect(line).toContain("review run 550e8400");
    expect(line).not.toContain(runId);
  });

  it("formats safe Agent progress actions, timings, attempts, and tokens", () => {
    const context = {
      time: "2026-08-15 10:20:30.123",
      run_id: "550e8400-e29b-41d4-a716-446655440000",
      repo_id: "123",
      mr_iid: "45",
      agent: "review-judge" as const,
      attempt: 2,
      step: 3,
    };
    expect(formatLogLine({
      ...context,
      level: "info",
      event: "agent_tool_finished",
      tool: "grep",
      action: "pattern=Controller path=src",
      status: "completed",
      duration_ms: 42,
    })).toContain(
      "Agent review-judge, attempt 2, step 3 for review run 550e8400 on repository 123, MR 45 finished tool grep (pattern=Controller path=src) with status completed in 42ms",
    );
    expect(formatLogLine({
      ...context,
      level: "info",
      event: "agent_step_finished",
      reason: "tool-calls",
      duration_ms: 2_500,
      model_until_action_ms: 2_400,
      input_tokens: 1_000,
      output_tokens: 100,
      cache_read_tokens: 800,
    })).toContain(
      "reason tool-calls; total 2500ms, model-to-action 2400ms; tokens input 1000, output 100, cache-read 800",
    );
  });

  it("formats omitted progress fields and all progress-adjacent failure events", () => {
    const context = {
      time: "2026-08-15 10:20:30.123",
      run_id: "550e8400-e29b-41d4-a716-446655440000",
      repo_id: "123",
      mr_iid: "45",
    };
    const lines = [
      formatLogLine({
        ...context,
        level: "error",
        event: "worktree_prepare_failed",
        duration_ms: -10,
        error: "password=secret",
      }),
      formatLogLine({
        ...context,
        level: "error",
        event: "commits_load_failed",
        duration_ms: 10,
        error: "load failed",
      }),
      formatLogLine({
        ...context,
        level: "info",
        event: "agent_tool_started",
        agent: "design-reviewer",
        step: 1,
        tool: "read",
      }),
      formatLogLine({
        ...context,
        level: "warn",
        event: "agent_tool_finished",
        agent: "design-reviewer",
        step: 1,
        tool: "read",
        status: "failed",
      }),
      formatLogLine({
        ...context,
        level: "info",
        event: "agent_step_finished",
        agent: "design-reviewer",
        step: 1,
      }),
      formatLogLine({
        ...context,
        level: "info",
        event: "agent_waiting",
        agent: "design-reviewer",
        step: 1,
        last_event: "tool_use",
        idle_ms: 60_000,
      }),
      formatLogLine({
        ...context,
        level: "info",
        event: "agent_progress_summary",
        agent: "design-reviewer",
        step: 1,
        summary: {
          steps: 1,
          tool_calls: 0,
          step_duration_ms: 0,
          tool_duration_ms: 0,
          input_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      }),
      formatLogLine({
        ...context,
        level: "info",
        event: "agent_finished",
        agent: "design-reviewer",
        duration_ms: 1,
      }),
      formatLogLine({
        ...context,
        level: "info",
        event: "agent_finished",
        agent: "review-judge",
        verdict: "DUPLICATE",
        duplicate_of_comment_id: null,
        duration_ms: 1,
      }),
      formatLogLine({
        ...context,
        level: "error",
        event: "comment_publish_failed",
        duration_ms: 1,
        error: "publish failed",
      }),
      formatLogLine({
        ...context,
        level: "info",
        event: "state_saved",
        operation: "cursor",
        duration_ms: 1,
      }),
      formatLogLine({
        ...context,
        level: "info",
        event: "state_saved",
        operation: "finding_history",
        duration_ms: 1,
      }),
      formatLogLine({
        ...context,
        level: "error",
        event: "state_save_failed",
        operation: "cursor",
        duration_ms: 1,
        error: "cursor failed",
      }),
      formatLogLine({
        ...context,
        level: "error",
        event: "state_save_failed",
        operation: "finding_history",
        duration_ms: 1,
        error: "history failed",
      }),
      formatLogLine({
        ...context,
        level: "info",
        event: "review_run_finished",
        updated_at: "2026-08-15T10:00:00Z",
        result: "new",
        comment_id: null,
        duration_ms: 1,
      }),
      formatLogLine({
        ...context,
        level: "info",
        event: "review_run_finished",
        updated_at: "2026-08-15T10:00:00Z",
        result: "duplicate_of",
        duplicate_of_comment_id: null,
        duration_ms: 1,
      }),
    ];
    const output = lines.join("");

    expect(output).toContain("Worktree preparation failed after 0ms");
    expect(output).toContain("Agent design-reviewer, step 1");
    expect(output).toContain("finished tool read with status failed.");
    expect(output).toContain("completed progress tracking with 1 steps and 0 tool calls; startup unknown");
    expect(output).toContain("a Markdown report with 0 characters");
    expect(output).toContain("duplicate comment unknown");
    expect(output).toContain("Appended unknown finding history");
    expect(output).toContain("Saving finding history failed");
    expect(output).not.toContain("password=secret");
  });

  it("turns append failures into LOG_ERROR", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-log-"));
    roots.push(root);
    const directory = path.join(root, "is-a-directory");
    await mkdir(directory);
    const logger = new TextLogger(directory, () => {});
    await expect(
      logger.write({ level: "error", event: "runtime_error", error: "failed" }),
    ).rejects.toMatchObject({ code: "LOG_ERROR" });
  });
});
