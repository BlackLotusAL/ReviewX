import { describe, expect, test } from "vitest";
import { OpenCodeEvents } from "@/src/server/opencode-events";
import type { ReviewTelemetry } from "@/src/server/opencode-client";

describe("OpenCode event stream", () => {
  test("waits for delayed SSE proof with a deadline and respects cancellation", async () => {
    const collector = new OpenCodeEvents("ses_test", () => undefined);
    collector.register("msg_root", 1, 3);
    const user = (id: string, parts: Array<Record<string, unknown>> = []) => collector.message({
      info: { id, sessionID: "ses_test", role: "user", time: { created: 1 } },
      parts: parts.map(part => ({ ...part, sessionID: "ses_test", messageID: id })) });
    const wait = collector.waitForResponseParent("msg_root", "msg_continue", new AbortController().signal);
    user("msg_root");
    user("msg_compact", [{ id: "prt_compact", type: "compaction", auto: true }]);
    user("msg_continue", [{ id: "prt_continue", type: "text", synthetic: true, metadata: { compaction_continue: true } }]);
    await expect(wait).resolves.toBe(true);
    await expect(collector.waitForResponseParent("msg_root", "msg_unknown", new AbortController().signal, 5)).resolves.toBe(false);
    const controller = new AbortController();
    const cancelled = collector.waitForResponseParent("msg_root", "msg_unknown", controller.signal);
    controller.abort();
    await expect(cancelled).resolves.toBe(false);
  });
  test("links exact compaction replays without authorizing summaries, changed replay formats or old-round events", () => {
    const events: ReviewTelemetry[] = [];
    const collector = new OpenCodeEvents("ses_test", event => events.push(event));
    const model = { providerID: "provider", modelID: "model" };
    const format = { type: "json_schema", schema: { type: "object" } };
    const user = (id: string, parts: Array<Record<string, unknown>> = [], override = format) => collector.message({
      info: { id, sessionID: "ses_test", role: "user", time: { created: 1 }, agent: "reviewx", model, format: override },
      parts: parts.map(part => ({ ...part, sessionID: "ses_test", messageID: id })) });
    collector.register("msg_root", 1, 3, "exact prompt");
    user("msg_root");
    user("msg_compact", [{ id: "prt_compact", type: "compaction", auto: true }]);
    expect(collector.hasResponseParent("msg_root", "msg_compact")).toBe(false);
    user("msg_bad", [{ id: "prt_bad", type: "text", text: "exact prompt" }], { type: "json_schema", schema: { type: "array" } });
    expect(collector.hasResponseParent("msg_root", "msg_bad")).toBe(false);
    user("msg_replay", [{ id: "prt_replay", type: "text", text: "exact prompt" }]);
    expect(collector.hasResponseParent("msg_root", "msg_replay")).toBe(true);
    collector.register("msg_next", 2, 3, "exact prompt");
    user("msg_late", [{ id: "prt_late", type: "text", synthetic: true, metadata: { compaction_continue: true }, text: "PRIVATE_CONTENT" }]);
    expect(collector.hasResponseParent("msg_next", "msg_late")).toBe(false);
    expect(collector.hasResponseParent("msg_root", "msg_late")).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ event: "response_parent_linked", kind: "compaction_replay", parentID: "msg_replay" }));
    expect(JSON.stringify(events)).not.toContain("PRIVATE_CONTENT");
    expect(JSON.stringify(events)).not.toContain("exact prompt");
  });

  test("keeps the original model step budget across compaction and continuation parents", () => {
    const collector = new OpenCodeEvents("ses_test", () => undefined);
    collector.register("msg_root", 1, 3);
    const user = (id: string, parts: Array<Record<string, unknown>> = []) => collector.message({
      info: { id, sessionID: "ses_test", role: "user", time: { created: 1 } },
      parts: parts.map(part => ({ ...part, sessionID: "ses_test", messageID: id })) });
    const assistant = (id: string, parentID: string) => collector.message({
      info: { id, parentID, role: "assistant", sessionID: "ses_test", time: { created: 1, completed: 2 } }, parts: [] });
    user("msg_root");
    assistant("msg_first", "msg_root");
    user("msg_compact", [{ id: "prt_compact", type: "compaction", auto: true }]);
    assistant("msg_summary", "msg_compact");
    user("msg_continue", [{ id: "prt_continue", type: "text", synthetic: true, metadata: { compaction_continue: true } }]);
    assistant("msg_final", "msg_continue");
    expect(() => assistant("msg_excess", "msg_continue")).toThrow(expect.objectContaining({ code: "OPENCODE_STEP_LIMIT" }));
  });
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
