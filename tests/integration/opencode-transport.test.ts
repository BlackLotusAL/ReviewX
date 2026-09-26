import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, expect, test } from "vitest";
import { consumeEvents, httpJson, openResponse } from "@/src/server/integrations/opencode-http";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function serve(handler: (res: ServerResponse) => void) {
  const server = createServer((_, res) => handler(res)); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const options = () => ({ headers: {}, signal: AbortSignal.timeout(5000) });

test("JSON waits for headers and preserves body", async () => {
  const url = await serve(res => setTimeout(() => res.end('{"ok":true}'), 100));
  expect(await httpJson(url, options())).toEqual({ ok: true });
});
test.each(["status", "json", "large", "disconnect", "cancel"])("JSON rejects %s", async kind => {
  const url = await serve(res => {
    if (kind === "cancel") return;
    if (kind === "status") { res.writeHead(500).end("bad"); return; }
    if (kind === "disconnect") { res.writeHead(200, { "content-length": "100" }); res.write("{"); setTimeout(() => res.destroy(), 20); return; }
    res.end(kind === "large" ? '"' + "x".repeat(100) + '"' : "bad json");
  });
  await expect(httpJson(url, { headers: {}, signal: AbortSignal.timeout(kind === "cancel" ? 50 : 5000) }, 20)).rejects.toThrow();
});
test("SSE decodes split UTF-8, CRLF, multiline data and many heartbeats", async () => {
  const url = await serve(res => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const bytes = Buffer.from('data: {"text":\r\ndata: "中文"}\r\n\r\n');
    for (const byte of bytes) res.write(Buffer.from([byte]));
    for (let i = 0; i < 100; i++) res.write(": heartbeat\n\n");
    res.end();
  });
  const opts = options(), events: unknown[] = [];
  const response = await openResponse(url, opts);
  await expect(consumeEvents(response, opts.signal, event => events.push(event), 80)).rejects.toThrow("disconnected");
  expect(events).toEqual([{ text: "中文" }]);
});
test("SSE bounds an individual frame", async () => {
  const url = await serve(res => res.end("data: " + "x".repeat(100)));
  const opts = options();
  await expect(consumeEvents(await openResponse(url, opts), opts.signal, () => {}, 20)).rejects.toThrow("Oversized");
});
test("abort closes an idle SSE response", async () => {
  const url = await serve(res => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); });
  const controller = new AbortController();
  const response = await openResponse(url, { headers: {}, signal: controller.signal });
  const reading = consumeEvents(response, controller.signal, () => {}, 100);
  controller.abort(new Error("Cancelled"));
  await expect(reading).rejects.toThrow();
  expect(response.destroyed).toBe(true);
});
test.runIf(process.env.REVIEWX_LONG_HTTP_TEST === "1")("headers may arrive after 300 seconds", async () => {
  const url = await serve(res => { const timer = setTimeout(() => res.end('{"long":true}'), 305_000); res.on("close", () => clearTimeout(timer)); });
  expect(await httpJson(url, { headers: {}, signal: AbortSignal.timeout(320_000) })).toEqual({ long: true });
}, 325_000);
