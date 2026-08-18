import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatLogLine, shortRunId, TextLogger } from "../../src/logger.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("text logger", () => {
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
