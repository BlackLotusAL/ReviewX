import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentProgressTracker,
  summarizeToolAction,
  type AgentProgressEvent,
} from "../../src/agent-progress.js";

afterEach(() => {
  vi.useRealTimers();
});

function line(value: unknown): string {
  return JSON.stringify(value);
}

describe("OpenCode agent progress tracking", () => {
  it("tracks model steps, tool actions, timings, tokens, and a final summary", async () => {
    const worktree = path.resolve("progress-fixture");
    const events: AgentProgressEvent[] = [];
    let now = 25;
    const tracker = new AgentProgressTracker(
      worktree,
      (event) => {
        events.push(event);
      },
      { heartbeatMs: 600_000, monotonicNow: () => now },
    );

    await tracker.handleLine(line({
      type: "step_start",
      timestamp: 1_000,
      part: { messageID: "message-1" },
    }));
    await tracker.handleLine(line({
      type: "tool_use",
      timestamp: 1_130,
      part: {
        messageID: "message-1",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "running",
          input: { command: `git diff -- ${path.join(worktree, "src", "service.ts")} token=secret` },
          time: { start: 1_100 },
        },
      },
    }));
    await tracker.handleLine(line({
      type: "tool_use",
      timestamp: 1_140,
      part: {
        messageID: "message-1",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: `git diff -- ${path.join(worktree, "src", "service.ts")} token=secret` },
          output: "SOURCE_MUST_NOT_REACH_PROGRESS",
          time: { start: 1_100, end: 1_125 },
        },
      },
    }));
    await tracker.handleLine(line({
      type: "step_finish",
      timestamp: 1_200,
      part: {
        messageID: "message-1",
        reason: "tool-calls",
        tokens: {
          input: 100,
          output: 20,
          reasoning: 3,
          cache: { read: 40, write: 5 },
        },
      },
    }));

    now = 50;
    await tracker.handleLine(line({
      type: "step_start",
      timestamp: 2_000,
      part: { messageID: "message-2" },
    }));
    await tracker.handleLine(line({
      type: "text",
      timestamp: 2_050,
      part: {
        messageID: "message-2",
        text: "ASSISTANT_TEXT_MUST_NOT_REACH_PROGRESS",
        time: { start: 2_050, end: 2_100 },
      },
    }));
    await tracker.handleLine(line({
      type: "step_finish",
      timestamp: 2_125,
      part: {
        messageID: "message-2",
        reason: "stop",
        tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 10, write: 0 } },
      },
    }));
    const summary = await tracker.finish();

    expect(events[0]).toEqual({ type: "process_ready", step: 0, startup_ms: 0 });
    expect(events).toContainEqual({ type: "step_started", step: 1 });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_started",
      step: 1,
      tool: "bash",
      action: expect.stringContaining("command=git diff -- ."),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_finished",
      step: 1,
      tool: "bash",
      status: "completed",
      duration_ms: 25,
      action: expect.stringContaining("token=***"),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "step_finished",
      step: 1,
      duration_ms: 200,
      model_until_action_ms: 100,
      input_tokens: 100,
      cache_read_tokens: 40,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "step_finished",
      step: 2,
      duration_ms: 125,
      model_until_action_ms: 50,
      text_generation_ms: 50,
    }));
    expect(JSON.stringify(events)).not.toContain("SOURCE_MUST_NOT_REACH_PROGRESS");
    expect(JSON.stringify(events)).not.toContain("ASSISTANT_TEXT_MUST_NOT_REACH_PROGRESS");
    expect(summary).toEqual({
      startup_ms: 0,
      steps: 2,
      tool_calls: 1,
      step_duration_ms: 325,
      tool_duration_ms: 25,
      input_tokens: 150,
      output_tokens: 30,
      reasoning_tokens: 3,
      cache_read_tokens: 50,
      cache_write_tokens: 5,
    });
    expect(events.at(-1)).toEqual({ type: "summary", step: 2, summary });
  });

  it("sanitizes paths and details without exposing external targets", () => {
    const worktree = path.resolve("progress-fixture");
    expect(summarizeToolAction(worktree, "read", {
      filePath: path.join(worktree, "src", "service.ts"),
      offset: 10,
      limit: 20,
    })).toBe("path=src/service.ts offset=10 limit=20");
    expect(summarizeToolAction(worktree, "read", {
      filePath: path.resolve(worktree, "..", "secret.env"),
    })).toBe("path=[external]");
    expect(summarizeToolAction(worktree, "unknown-tool", {
      value: "must-not-log",
    })).toBeUndefined();
    expect(summarizeToolAction(worktree, "bash", {
      command: `git show -- C:\\outside\\private.ts token=secret`,
    })).toBe("command=git show [external]");
    expect(summarizeToolAction(worktree, "bash", {
      command: "git status; echo SOURCE_MUST_NOT_LOG; git log --oneline -5",
    })).toBe("command=git status; git log --oneline -5");
    expect(summarizeToolAction(worktree, "grep", {
      pattern: `password=secret ${"x".repeat(500)}`,
      path: worktree,
    })).toMatch(/^pattern=password=\*\*\*/u);
    expect(summarizeToolAction(worktree, "grep", {
      pattern: "x".repeat(500),
    })!.length).toBe(300);
  });

  it("emits 60-second heartbeats, resets on activity, and stops after finish", async () => {
    vi.useFakeTimers();
    const events: AgentProgressEvent[] = [];
    let now = 0;
    const tracker = new AgentProgressTracker(
      path.resolve("progress-fixture"),
      (event) => {
        events.push(event);
      },
      { heartbeatMs: 60_000, monotonicNow: () => now },
    );

    now = 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toContainEqual({
      type: "waiting",
      step: 0,
      last_event: "process_started",
      idle_ms: 60_000,
    });

    now = 75_000;
    await tracker.handleLine(line({
      type: "step_start",
      timestamp: 1_000,
      part: { messageID: "message-1" },
    }));
    now = 135_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toContainEqual({
      type: "waiting",
      step: 1,
      last_event: "step_start",
      idle_ms: 60_000,
    });

    await tracker.finish();
    const count = events.length;
    now = 255_000;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(events).toHaveLength(count);
  });

  it("ignores malformed and unknown progress lines without failing", async () => {
    const events: AgentProgressEvent[] = [];
    const tracker = new AgentProgressTracker(
      path.resolve("progress-fixture"),
      (event) => {
        events.push(event);
      },
      { heartbeatMs: 600_000 },
    );
    await expect(tracker.handleLine("not-json")).resolves.toBeUndefined();
    await expect(tracker.handleLine(line({ type: "future_event", timestamp: 1 })))
      .resolves.toBeUndefined();
    await tracker.finish();
    expect(events.map((event) => event.type)).toEqual(["process_ready", "summary"]);
  });
});
