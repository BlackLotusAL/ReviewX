import { request as httpRequest, type IncomingMessage } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { isAppError } from "../errors";
import { reviewError } from "../review/materials";

type RequestOptions = { headers: Record<string, string>; signal: AbortSignal; body?: unknown };

function networkError(url: string, cause: unknown) {
  return isAppError(cause) ? cause : reviewError("OPENCODE_NETWORK_ERROR", "原生 HTTP 通信失败。", {
    technical: `Route: ${new URL(url).pathname}\n${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`,
    cause, classified: false,
  });
}

export function openResponse(url: string, options: RequestOptions): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) { reject(options.signal.reason); return; }
    const req = httpRequest(url, { method: options.body === undefined ? "GET" : "POST", headers: options.headers, agent: false });
    req.setTimeout(0);
    let response: IncomingMessage | undefined;
    const abort = () => { response?.destroy(); req.destroy(options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted")); };
    const cleanup = () => options.signal.removeEventListener("abort", abort);
    options.signal.addEventListener("abort", abort, { once: true });
    req.on("error", error => { cleanup(); reject(networkError(url, error)); });
    req.once("response", res => {
      response = res;
      res.once("close", cleanup);
      // Install immediately: a response can fail before its consumer starts reading.
      res.on("error", () => undefined);
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.destroy();
        reject(reviewError("OPENCODE_PROTOCOL_ERROR", `原生 HTTP 请求失败（${res.statusCode}）。`, { technical: `Route: ${new URL(url).pathname}` }));
      } else resolve(res);
    });
    if (options.signal.aborted) abort();
    else req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

export async function httpJson(url: string, options: RequestOptions, limit = 128 * 1024 * 1024): Promise<unknown> {
  let response: IncomingMessage | undefined;
  try {
    response = await openResponse(url, options);
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of response) {
      options.signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > limit) throw reviewError("REVIEW_INCOMPLETE", "原生 HTTP 响应超过上限。");
      chunks.push(chunk);
    }
    options.signal.throwIfAborted();
    if (!response.complete) throw new Error("Response closed before completion");
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch (cause) { throw reviewError("OPENCODE_PROTOCOL_ERROR", "原生 HTTP 返回无效 JSON。", { cause, technical: `Route: ${new URL(url).pathname}` }); }
  } catch (error) { throw networkError(url, error); }
  finally { response?.destroy(); }
}

export async function consumeEvents(response: IncomingMessage, signal: AbortSignal, onEvent: (event: unknown) => void, limit: number): Promise<void> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const consume = (text: string) => {
    buffer += text;
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/u.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      if (Buffer.byteLength(frame) > limit) throw new Error("Oversized event frame");
      buffer = buffer.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /u, "")).join("\n");
      if (data) onEvent(JSON.parse(data));
    }
    if (Buffer.byteLength(buffer) > limit) throw new Error("Oversized event frame");
  };
  try {
    for await (const chunk of response) { signal.throwIfAborted(); consume(decoder.write(chunk)); }
    consume(decoder.end());
    signal.throwIfAborted();
    throw new Error("Event stream disconnected");
  } finally { response.destroy(); }
}
