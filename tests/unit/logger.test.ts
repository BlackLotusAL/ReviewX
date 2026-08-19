import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatLocalIsoTimestamp,
  formatLogLine,
  shortRunId,
  TextLogger,
} from "../../src/logger.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

function localDate(timezoneOffset: number): Date {
  return {
    getFullYear: () => 2026,
    getMonth: () => 7,
    getDate: () => 15,
    getHours: () => 18,
    getMinutes: () => 20,
    getSeconds: () => 30,
    getMilliseconds: () => 123,
    getTimezoneOffset: () => timezoneOffset,
  } as Date;
}

describe("text logger", () => {
  it.each([
    [-480, "2026-08-15T18:20:30.123+08:00"],
    [330, "2026-08-15T18:20:30.123-05:30"],
    [0, "2026-08-15T18:20:30.123+00:00"],
  ])("formats the current system offset %i as local ISO-8601", (offset, expected) => {
    expect(formatLocalIsoTimestamp(localDate(offset))).toBe(expected);
  });

  it("reads the system offset again for every generated log line", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-log-"));
    roots.push(root);
    const output: string[] = [];
    let timezoneOffset = -480;
    const logger = new TextLogger(
      path.join(root, "events.log"),
      (line) => output.push(line),
      () => localDate(timezoneOffset),
    );
    await logger.write({ level: "info", event: "scan_started" });
    timezoneOffset = 420;
    await logger.write({ level: "info", event: "scan_started" });
    expect(output[0]!).toMatch(/^\[2026-08-15T18:20:30\.123\+08:00\]/u);
    expect(output[1]!).toMatch(/^\[2026-08-15T18:20:30\.123-07:00\]/u);
  });

  it("writes byte-identical ordered text lines to file and stdout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-log-"));
    roots.push(root);
    const output: string[] = [];
    const target = path.join(root, "nested", "events.log");
    const logger = new TextLogger(target, (line) => output.push(line));
    await Promise.all([
      logger.write({
        time: "2026-08-15T10:20:30.123Z",
        level: "info",
        event: "scan_started",
      }),
      logger.write({
        time: "2026-08-15T10:20:31.123Z",
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
      "[2026-08-15T10:20:30.123Z] [INFO] [scan_started] Scan started.\n",
      "[2026-08-15T10:20:31.123Z] [INFO] [scan_finished] Scan finished after checking 2 repositories: 1 reviews pending, 1 completed, and 0 failed in 1000ms.\n",
    ]);
  });

  it("formats warnings as one line and redacts credentials", () => {
    expect(
      formatLogLine({
        time: "2026-08-15T10:20:30.123Z",
        level: "warn",
        event: "repository_scan_failed",
        repo_id: "12",
        duration_ms: 25,
        error: "failure\r\npassword=secret",
      }),
    ).toBe(
      "[2026-08-15T10:20:30.123Z] [WARN] [repository_scan_failed] Repository 12 scan failed after 25ms: failure\\r\\npassword=***\n",
    );
  });

  it("uses an eight-character run reference without exposing the full UUID", () => {
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    expect(shortRunId(runId)).toBe("550e8400");
    const line = formatLogLine({
      time: "2026-08-15T10:20:30.123Z",
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
      time: "2026-08-15T10:20:30.123+08:00",
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
