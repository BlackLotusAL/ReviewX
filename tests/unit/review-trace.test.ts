import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ReviewTrace } from "@/src/server/review/trace";

test("SSE and reconciliation deduplicate steps; tokens and HTTP are independent", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-test-"));
  try {
    const file = join(root, "trace.jsonl"), trace = new ReviewTrace("attempt", file);
    trace.generation("s", "reviewx-discover"); trace.http("/session/s/message", "POST");
    const part = { id: "p", sessionID: "s", messageID: "m", type: "step-finish", tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 5, write: 0 } } };
    trace.event({ type: "message.part.updated", properties: { part } });
    trace.message({ info: { id: "m", sessionID: "s", role: "assistant", time: { created: 1, completed: 2 } }, parts: [part] });
    for (const id of ["t1", "t2"]) trace.event({ type: "message.part.updated", properties: { part: {
      id, messageID: "m", sessionID: "s", type: "tool", tool: "read", callID: id,
      state: { status: "completed", input: { filePath: "source/x.ts", offset: 2, limit: 4 }, output: "PRIVATE SOURCE", time: { start: 1, end: 3 } },
    } } });
    trace.streamInterrupted(); await trace.flush();
    const summary = trace.summary();
    expect(summary.observedModelSteps).toBe(1); expect(summary.generationRequests).toBe(1);
    expect(summary.tokens).toEqual({ input: 10, output: 2, reasoning: 3, cacheRead: 5, cacheWrite: 0 });
    expect(summary.providerAttempts).toBeNull(); expect(summary.repeatedReads).toBe(1);
    const raw = await readFile(file, "utf8"); expect(raw).not.toContain("PRIVATE SOURCE");
    expect(raw.split("\n").filter(l => l.includes('"type":"model.step"'))).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("unknown tokens remain null and write failures do not fail the review", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-test-"));
  try {
    const file = join(root, "not-a-directory"); await writeFile(file, "x");
    const trace = new ReviewTrace("attempt", join(file, "trace.jsonl"));
    trace.emit("review.failed"); await expect(trace.flush()).resolves.toBeUndefined();
    expect(trace.summary().traceWriteFailed).toBe(true); expect(trace.summary().tokens.input).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});
