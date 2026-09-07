import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { connectOpenCode, type ReviewTelemetry } from "@/src/server/opencode-client";
import { reviewEnvironment } from "@/src/server/opencode";
import { reviewCheckpointJsonSchema } from "@/src/server/schemas";
import { preparedFixture } from "../helpers/reviewer";
import { Logger } from "@/src/server/logger";
import { OPENCODE_DIAGNOSTIC_BYTES } from "@/src/server/opencode-diagnostics";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function harness(mode = "normal", signal = new AbortController().signal, events: ReviewTelemetry[] = []) {
  const fixture = await preparedFixture(); cleanups.push(fixture.prepared.cleanup);
  const capture = path.join(fixture.root, "capture.jsonl");
  const logPath = path.join(fixture.root, "reviewx-test.log");
  const logger = new Logger(logPath, {});
  const connection = await connectOpenCode(fixture.prepared, reviewEnvironment({ ...process.env,
    FAKE_CAPTURE: capture, FAKE_MODE: mode, CODEHUB_TOKEN: "repository-private", DEEPSEEK_API_KEY: "fixture-provider-secret" }), signal, event => {
    events.push(event);
    logger.info({ projectId: "101", mrIid: "7", attemptId: "attempt_test" }, `OpenCode ${JSON.stringify(event)}`);
  },
  { name: "opencode", executable: process.execPath, prefixArgs: [path.resolve("tests/helpers/opencode-service.mjs")] });
  cleanups.push(connection.close);
  const calls = async () => (await readFile(capture, "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  return { ...fixture, connection, events, calls, log: () => readFile(logPath, "utf8") };
}
describe("managed OpenCode HTTP service", () => {
  test("uses private loopback auth, independent requests, native structured output, and deduplicated diagnostics", async () => {
    const h = await harness();
    const model = { providerID: "deepseek", modelID: "deepseek-v4-flash" };
    const first = await h.connection.prompt("核实上下文", "reviewx", model);
    const second = await h.connection.prompt("整理已核实意见", "reviewx_output_deepseek", model, reviewCheckpointJsonSchema);
    expect(second.info.structured).toEqual({ status: "complete", nextChecks: [], findings: [], limitations: [] });
    expect(second.info.parentID).not.toBe(first.info.parentID);
    expect(h.events.filter(event => event.event === "model_usage")).toHaveLength(2);
    expect(h.events.filter(event => event.event === "tool_call")).toHaveLength(2);
    const calls = await h.calls();
    expect(calls[0]).toMatchObject({ authLength: 64, args: ["serve", "--hostname", "127.0.0.1", "--port", "0"] });
    expect(calls[0].db.startsWith(h.prepared.runtimeDirectory)).toBe(true);
    expect(calls[0].codeHubToken).toBeUndefined();
    expect(calls[0].config.agent.reviewx_output_deepseek.permission.StructuredOutput).toBe("allow");
    expect(calls.find(call => call.input?.format)?.input.format.retryCount).toBe(0);
    expect(calls.filter(call => call.method === "GET" && call.path?.endsWith("/message"))).toEqual([]);
    await h.connection.close();
    expect((await h.calls()).slice(1).map(call => [call.method, call.path])).toEqual([
      ["GET", "/global/health"], ["GET", "/doc"], ["POST", "/session"], ["GET", "/event"],
      ["POST", "/session/ses_transport_test/message"], ["POST", "/session/ses_transport_test/message"],
      ["POST", "/session/ses_transport_test/abort"], ["DELETE", "/session/ses_transport_test"],
    ]);
    expect(h.events).toContainEqual(expect.objectContaining({ event: "service_starting", nodeVersion: process.version }));
    expect(h.events).toContainEqual(expect.objectContaining({ event: "service_listening", address: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/u) }));
    expect(h.events).toContainEqual(expect.objectContaining({ event: "service_exited", version: "1.18.25", stopReason: "cleanup" }));
    expect(h.events.filter(event => event.event === "http_started")).toHaveLength(7);
    expect(h.events.filter(event => event.event === "http_headers")).toHaveLength(7);
    expect(h.events.filter(event => event.event === "http_completed")).toHaveLength(7);
    const log = await h.log();
    expect(log).toContain("[Attempt: attempt_test]");
    expect(log).not.toContain("核实上下文");
    expect(log).not.toContain("整理已核实意见");
    expect(log).not.toContain("PRIVATE_RESPONSE_BODY");
    await expect(fetch(`http://127.0.0.1:${calls[0].port}`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  });
  test.each(["wrong_parent", "wrong_session", "unfinished"])("refuses %s without using historical or textual JSON", async mode => {
    const h = await harness(mode);
    await expect(h.connection.prompt("current request", "reviewx")).rejects.toMatchObject({ code: "INVALID_OPENCODE_RESPONSE" });
  });
  test.each([["auth_error", "OPENCODE_HTTP_ERROR"], ["old_version", "OPENCODE_INCOMPATIBLE"]])("fails startup for %s", async (mode, code) => {
    await expect(harness(mode)).rejects.toMatchObject({ code });
  });
  test("cancels a hanging request and kills the owned service", async () => {
    const controller = new AbortController();
    const h = await harness("hang", controller.signal);
    const promise = h.connection.prompt("hang", "reviewx");
    const rejection = expect(promise).rejects.toMatchObject({ code: "OPENCODE_CANCELLED" });
    controller.abort(); await rejection; await h.connection.close();
    const [startup] = await h.calls();
    expect(() => process.kill(startup.pid, 0)).toThrow();
  });
  test.each([["exit", ["OPENCODE_SERVER_EXIT", "OPENCODE_CONNECTION_FAILED"]], ["step_limit", ["OPENCODE_STEP_LIMIT"]]] as const)("fails an active request on %s", async (mode, codes) => {
    const h = await harness(mode);
    await expect(h.connection.prompt("current request", "reviewx")).rejects.toMatchObject({ code: expect.stringMatching(new RegExp(`^(${codes.join("|")})$`, "u")) });
  });

  test.each([
    ["header_reset", "waiting_headers", "OPENCODE_CONNECTION_FAILED"],
    ["body_reset", "reading_body", "OPENCODE_CONNECTION_FAILED"],
    ["invalid_json", "parsing_json", "INVALID_OPENCODE_RESPONSE"],
    ["message_http_error", "response_headers", "OPENCODE_HTTP_ERROR"],
  ])("records the failure stage and original error for %s", async (mode, stage, code) => {
    const h = await harness(mode);
    await expect(h.connection.prompt("PRIVATE_PROMPT", "reviewx")).rejects.toMatchObject({ code });
    await h.connection.close();
    const failure = h.events.find(event => event.event === "http_failed" && event.path?.toString().endsWith("/message"));
    expect(failure).toMatchObject({ method: "POST", stage, sessionID: h.connection.sessionID,
      requestID: expect.stringMatching(/^msg_/u), elapsedMs: expect.any(Number), error: expect.any(String) });
    if (mode === "body_reset") expect(failure).toMatchObject({ status: 200, responseBytes: expect.any(Number) });
    if (mode === "message_http_error") expect(failure?.status).toBe(503);
    if (mode.endsWith("reset")) expect(failure?.error).toContain("UND_ERR_SOCKET");
    if (mode === "header_reset") expect(h.events).toContainEqual(expect.objectContaining({ event: "service_output", stream: "stderr", text: "header connection diagnostic\n" }));
    const log = await h.log();
    expect(log).not.toContain("PRIVATE_PROMPT");
    expect(log).not.toContain("PRIVATE_RESPONSE_BODY");
    expect((await h.calls()).filter(call => call.path?.endsWith("/message"))).toHaveLength(1);
  });

  test.each(["ECONNREFUSED", "ECONNRESET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])("logs %s before keeping the existing public connection error", async code => {
    const h = await harness();
    const cause = Object.assign(new Error("transport failure"), { code });
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed", { cause }));
    await expect(h.connection.prompt("PRIVATE_PROMPT", "reviewx")).rejects.toMatchObject({
      code: "OPENCODE_CONNECTION_FAILED", message: "检视未完成。", reason: "无法取得 OpenCode 本机接口响应。", technical: "无法取得 OpenCode 本机接口响应。",
    });
    const failure = h.events.find(event => event.event === "http_failed");
    expect(failure?.error).toContain(code);
    expect(failure?.error).toContain("fetch failed");
    await h.connection.close();
  });

  test.each(["sse_reset", "sse_eof"])("records an interrupted event stream on %s and keeps cancellation behavior", async mode => {
    const h = await harness(mode);
    await expect(h.connection.prompt("current request", "reviewx")).rejects.toMatchObject({ code: "OPENCODE_CONNECTION_FAILED" });
    await h.connection.close();
    expect(h.events).toContainEqual(expect.objectContaining({ event: "sse_failed", stage: "reading_body", path: "/event", status: 200,
      requestID: expect.stringMatching(/^msg_/u), sessionID: h.connection.sessionID, error: expect.any(String) }));
    const [startup, ...calls] = await h.calls();
    expect(() => process.kill(startup.pid, 0)).toThrow();
    expect(calls.filter(call => call.path?.endsWith("/message"))).toHaveLength(1);
    expect(calls.some(call => call.method === "DELETE")).toBe(false);
  });

  test.each([["sse_http_error", "response_headers"], ["sse_connect_reset", "waiting_headers"]])("records event subscription failure on %s without reclassifying it", async (mode, stage) => {
    const events: ReviewTelemetry[] = [];
    const connection = harness(mode, new AbortController().signal, events);
    if (mode === "sse_http_error") await expect(connection).rejects.toMatchObject({ code: "OPENCODE_CONNECTION_FAILED" });
    else await expect(connection).rejects.toBeInstanceOf(TypeError);
    expect(events).toContainEqual(expect.objectContaining({ event: "sse_failed", stage, path: "/event", error: expect.any(String) }));
    expect(events).toContainEqual(expect.objectContaining({ event: "service_exited" }));
    expect(JSON.stringify(events)).not.toContain("PRIVATE_RESPONSE_BODY");
  });

  test("records startup HTTP failures and existing cleanup fallback", async () => {
    const events: ReviewTelemetry[] = [];
    await expect(harness("auth_error", new AbortController().signal, events)).rejects.toMatchObject({ code: "OPENCODE_HTTP_ERROR" });
    expect(events).toContainEqual(expect.objectContaining({ event: "http_failed", path: "/global/health", status: 401, stage: "response_headers" }));
    const h = await harness("cleanup_error");
    await h.connection.prompt("current request", "reviewx");
    await expect(h.connection.close()).resolves.toBeUndefined();
    expect(h.events).toContainEqual(expect.objectContaining({ event: "session_cleanup", step: "abort_session", outcome: "process_cleanup_required", error: expect.stringContaining("OPENCODE_HTTP_ERROR") }));
    const [startup, ...calls] = await h.calls();
    expect(calls.some(call => call.method === "DELETE")).toBe(false);
    expect(() => process.kill(startup.pid, 0)).toThrow();
  });

  test("records a process exit before listening with its stderr", async () => {
    const events: ReviewTelemetry[] = [];
    await expect(harness("startup_exit", new AbortController().signal, events)).rejects.toMatchObject({ code: "OPENCODE_SERVER_EXIT" });
    expect(events.find(event => event.event === "service_exited")).toMatchObject({ exitCode: 7, stopReason: "unexpected_exit", cleanupRequested: false });
    expect(events).toContainEqual(expect.objectContaining({ event: "service_output", stream: "stderr", text: "startup exit diagnostic\n" }));
    expect(events.some(event => event.event === "http_started")).toBe(false);
  });

  test("persists bounded, redacted output tails when the server exits unexpectedly", async () => {
    const h = await harness("output_exit");
    await expect(h.connection.prompt("current request", "reviewx")).rejects.toMatchObject({ code: expect.stringMatching(/^OPENCODE_(SERVER_EXIT|CONNECTION_FAILED)$/u) });
    await h.connection.close();
    const outputs = h.events.filter(event => event.event === "service_output");
    expect(outputs).toHaveLength(2);
    for (const output of outputs) {
      expect(Buffer.byteLength(String(output.text))).toBeLessThanOrEqual(OPENCODE_DIAGNOSTIC_BYTES);
      expect(output.text).toContain("truncated");
      expect(output.text).toContain(`${String(output.stream).toUpperCase()}_END`);
      expect(output.text).not.toContain("discarded-output-prefix");
    }
    const [startup] = await h.calls();
    const log = await h.log();
    for (const secret of [...startup.testSecrets, "fixture-provider-secret"]) expect(log).not.toContain(secret);
    expect(log).toContain("[REDACTED]");
    const exit = h.events.find(event => event.event === "service_exited");
    expect(exit).toMatchObject({ exitCode: 7 });
    // Socket failure can trigger cleanup before Windows delivers the child's close event.
    expect(exit?.stopReason).toBe(exit?.aborted ? "cleanup" : "unexpected_exit");
  });
});
