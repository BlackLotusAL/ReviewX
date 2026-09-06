import { describe, expect, test } from "vitest";
import { OpenCodeEvents } from "@/src/server/opencode-events";
import type { ReviewTelemetry } from "@/src/server/opencode-client";

describe("OpenCode event stream", () => {
  test("handles split CRLF/Unicode frames, filters other sessions and deduplicates usage", async () => {
    const events: ReviewTelemetry[] = [];
    const collector = new OpenCodeEvents("ses_test", event => events.push(event));
    collector.register("msg_request", 1, 20);
    const info = { id: "msg_assistant", parentID: "msg_request", sessionID: "ses_test", role: "assistant", time: { created: 1, completed: 2 },
      providerID: "provider", modelID: "model", cost: 0.2, tokens: { input: 10, output: 5, cache: { read: 2 } } };
    const frame = (info: unknown) => `data: ${JSON.stringify({ type: "message.updated", properties: { info } })}\r\n\r\n`;
    const bytes = Buffer.from(frame({ ...info, sessionID: "ses_other" }) + frame(info) + frame(info));
    const controller = new AbortController();
    await collector.consume(new ReadableStream({ start(stream) {
      for (const byte of bytes) stream.enqueue(Uint8Array.of(byte));
      controller.abort(); stream.close();
    } }), controller.signal);
    expect(events).toEqual([expect.objectContaining({ event: "model_usage", round: 1, reportedCost: 0.2, inputTokens: 10, outputTokens: 5 })]);
  });
  test("refuses silent event disconnection and provider retries", async () => {
    const collector = new OpenCodeEvents("ses_test", () => undefined);
    await expect(collector.consume(new ReadableStream({ start(stream) { stream.close(); } }), new AbortController().signal)).rejects.toMatchObject({ code: "OPENCODE_CONNECTION_FAILED" });
    const data = { type: "message.part.updated", properties: { part: { type: "retry", sessionID: "ses_test" } } };
    await expect(collector.consume(new ReadableStream({ start(stream) { stream.enqueue(Buffer.from(`data: ${JSON.stringify(data)}\n\n`)); stream.close(); } }), new AbortController().signal)).rejects.toMatchObject({ code: "OPENCODE_ERROR" });
  });
  test("stops when step 20 still requires tool follow-up", () => {
    const collector = new OpenCodeEvents("ses_test", () => undefined);
    collector.register("msg_request", 1, 20);
    const add = (step: number) => collector.message({ info: { id: `msg_${step}`, parentID: "msg_request", sessionID: "ses_test", role: "assistant",
      finish: "tool-calls", time: { created: 1, completed: 2 } }, parts: [] });
    for (let step = 1; step < 20; step++) add(step);
    expect(() => add(20)).toThrow(/检视未完成/u);
  });
});
