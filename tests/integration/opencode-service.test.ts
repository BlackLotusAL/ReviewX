import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { connectOpenCode, type ReviewTelemetry } from "@/src/server/opencode-client";
import { reviewEnvironment } from "@/src/server/opencode";
import { reviewCheckpointJsonSchema } from "@/src/server/schemas";
import { preparedFixture } from "../helpers/reviewer";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function harness(mode = "normal", signal = new AbortController().signal) {
  const fixture = await preparedFixture(); cleanups.push(fixture.prepared.cleanup);
  const capture = path.join(fixture.root, "capture.jsonl");
  const events: ReviewTelemetry[] = [];
  const connection = await connectOpenCode(fixture.prepared, reviewEnvironment({ ...process.env,
    FAKE_CAPTURE: capture, FAKE_MODE: mode, CODEHUB_TOKEN: "repository-private" }), signal, event => events.push(event),
  { name: "opencode", executable: process.execPath, prefixArgs: [path.resolve("tests/helpers/opencode-service.mjs")] });
  cleanups.push(connection.close);
  const calls = async () => (await readFile(capture, "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  return { ...fixture, connection, events, calls };
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
    expect((await h.calls()).some(call => call.method === "DELETE")).toBe(true);
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
});
