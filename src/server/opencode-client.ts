import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { resolveCommand } from "@/src/cli/resolve-command";
import { AppError } from "./errors";
import type { PreparedReview } from "./git";
import { runProcess, type ResolvedCommand } from "./process";
import { OpenCodeEvents } from "./opencode-events";

export type ReviewTelemetry = Record<string, string | number | boolean | undefined>;
export interface OpenCodeMessage {
  info: Record<string, unknown> & {
    id: string; sessionID: string; role: string; parentID?: string;
    modelID?: string; providerID?: string; finish?: string;
    time: { created: number; completed?: number };
    error?: { name: string }; structured?: unknown;
  };
  parts: Array<Record<string, unknown>>;
}
export interface ReviewModel { providerID: string; modelID: string }
export interface OpenCodeConnection {
  sessionID: string;
  version: string;
  prompt(text: string, agent: string, model?: ReviewModel, schema?: Record<string, unknown>): Promise<OpenCodeMessage>;
  close(): Promise<void>;
}
export type OpenCodeConnectionFactory = (
  prepared: PreparedReview, environment: NodeJS.ProcessEnv, signal: AbortSignal,
  diagnostic: (event: ReviewTelemetry) => void,
) => Promise<OpenCodeConnection>;

export function openCodeError(code: string, reason: string, technical = reason): AppError {
  return new AppError({ code, message: code === "OPENCODE_CANCELLED" ? "OpenCode 检视已停止。" : "检视未完成。",
    reason, impact: "本次检视不生成可处理意见或 PASS 报告。",
    nextStep: code === "OPENCODE_CANCELLED" ? "如仍需检视，请手动重新检视。" : "查看检视诊断后重新检视。", technical });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeOpenCodeMessage(value: unknown, sessionID: string): OpenCodeMessage {
  if (!record(value) || !record(value.info)) throw openCodeError("INVALID_OPENCODE_RESPONSE", "OpenCode 消息缺少有效 info。");
  const info = value.info;
  if (!Array.isArray(value.parts) || !value.parts.every(record) ||
    typeof value.info.id !== "string" || !value.info.id.startsWith("msg") || value.info.sessionID !== sessionID ||
    !["assistant", "user"].includes(String(value.info.role)) ||
    !record(value.info.time) || typeof value.info.time.created !== "number" || !Number.isFinite(value.info.time.created) ||
    ["parentID", "providerID", "modelID", "finish"].some(key => info[key] !== undefined && typeof info[key] !== "string") ||
    (value.info.error !== undefined && (!record(value.info.error) || typeof value.info.error.name !== "string"))) {
    throw openCodeError("INVALID_OPENCODE_RESPONSE", "OpenCode 消息不符合当前接口契约。");
  }
  if (value.parts.some(part => (part.sessionID !== undefined && part.sessionID !== sessionID) ||
    (part.messageID !== undefined && part.messageID !== info.id))) throw openCodeError("INVALID_OPENCODE_RESPONSE", "OpenCode 消息片段不属于当前响应。");
  return value as unknown as OpenCodeMessage;
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw openCodeError("OPENCODE_HTTP_ERROR", `OpenCode 本机接口返回 HTTP ${response.status}。`);
  if (!response.body) throw openCodeError("INVALID_OPENCODE_RESPONSE", "OpenCode 返回了空响应。");
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 64 * 1024 * 1024) throw openCodeError("OPENCODE_OUTPUT_LIMIT", "OpenCode 响应超过 64 MiB 上限。");
      buffers.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(buffers).toString("utf8")) as unknown; }
    catch { throw openCodeError("INVALID_OPENCODE_RESPONSE", "OpenCode 本机接口未返回有效 JSON。"); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** One process and one session per attempt; runProcess retains Windows tree cancellation. */
export async function connectOpenCode(
  prepared: PreparedReview, environment: NodeJS.ProcessEnv, signal: AbortSignal,
  diagnostic: (event: ReviewTelemetry) => void,
  command?: ResolvedCommand,
): Promise<OpenCodeConnection> {
  signal.throwIfAborted();
  const resolved = command ?? await resolveCommand("opencode", environment);
  const password = randomBytes(32).toString("hex");
  const controller = new AbortController();
  const died = new AbortController();
  const processSignal = AbortSignal.any([signal, controller.signal]);
  const requestSignal = AbortSignal.any([signal, died.signal]);
  let closing = false;
  let startupText = "";
  let resolveAddress!: (address: string) => void;
  let rejectAddress!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => { resolveAddress = resolve; rejectAddress = reject; });
  const completion = runProcess(resolved, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: prepared.rootDirectory,
    env: { ...environment, OPENCODE_SERVER_USERNAME: "reviewx", OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DB: join(prepared.runtimeDirectory, "session.sqlite") },
    signal: processSignal, timeoutMs: 60 * 60_000, maxOutputBytes: 8 * 1024 * 1024,
    onStdout: chunk => {
      startupText = (startupText + chunk).slice(-16_384);
      const match = /opencode server listening on (http:\/\/127\.0\.0\.1:(\d+))/u.exec(startupText);
      if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535) resolveAddress(match[1]);
    },
  }).then(result => {
    if (!closing) {
      const error = openCodeError(result.aborted ? "OPENCODE_CANCELLED" : "OPENCODE_SERVER_EXIT",
        result.aborted ? "检视已按停止请求终止。" : "OpenCode 服务在检视完成前退出。",
        `exit=${result.exitCode}; timeout=${result.timedOut}; outputLimit=${result.outputLimitExceeded}`);
      rejectAddress(error); died.abort(error);
    }
  }, error => { rejectAddress(error); died.abort(error); });
  const startupSignal = AbortSignal.any([requestSignal, AbortSignal.timeout(30_000)]);
  const abortStartup = () => rejectAddress(openCodeError("OPENCODE_STARTUP_FAILED", "OpenCode 服务启动超时或被停止。"));
  startupSignal.addEventListener("abort", abortStartup, { once: true });
  let address = "", sessionID = "";
  const eventController = new AbortController();
  let eventCompletion: Promise<void> | undefined;
  const headers = { Authorization: `Basic ${Buffer.from(`reviewx:${password}`).toString("base64")}`,
    "Content-Type": "application/json", "x-opencode-directory": encodeURIComponent(prepared.rootDirectory) };
  const rpc = async (path: string, method = "GET", body?: unknown, overrideSignal?: AbortSignal): Promise<unknown> => {
    try {
      return await responseJson(await fetch(`${address}${path}`, { method, headers, redirect: "error", cache: "no-store",
        body: body === undefined ? undefined : JSON.stringify(body), signal: overrideSignal ?? requestSignal }));
    } catch (error) {
      if (died.signal.aborted) throw died.signal.reason;
      if (signal.aborted) throw openCodeError("OPENCODE_CANCELLED", "检视已停止或达到总时限。");
      if (error instanceof AppError) throw error;
      throw openCodeError("OPENCODE_CONNECTION_FAILED", "无法取得 OpenCode 本机接口响应。");
    }
  };
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      if (sessionID && !signal.aborted && !died.signal.aborted) {
        const cleanupSignal = AbortSignal.timeout(5_000);
        await rpc(`/session/${encodeURIComponent(sessionID)}/abort`, "POST", undefined, cleanupSignal);
        await rpc(`/session/${encodeURIComponent(sessionID)}`, "DELETE", undefined, cleanupSignal);
      }
    } catch { diagnostic({ event: "session_cleanup", outcome: "process_cleanup_required" }); }
    finally { eventController.abort(); controller.abort(); await Promise.all([completion, eventCompletion]); }
  };
  try {
    if (startupSignal.aborted) abortStartup();
    address = await ready;
    startupSignal.removeEventListener("abort", abortStartup);
    const health = await rpc("/global/health");
    if (!record(health) || health.healthy !== true || typeof health.version !== "string") throw openCodeError("OPENCODE_INCOMPATIBLE", "OpenCode 健康检查不符合接口契约。");
    const schema = await rpc("/doc");
    const properties = record(schema) && record(schema.components) && record(schema.components.schemas) &&
      record(schema.components.schemas.AssistantMessage) && schema.components.schemas.AssistantMessage.properties;
    if (!record(properties) || !("structured" in properties)) throw openCodeError("OPENCODE_INCOMPATIBLE", "需要支持 info.structured 的 OpenCode 版本（已验证 1.18.25）。");
    const session = await rpc("/session", "POST", { title: `ReviewX ${prepared.sourceSha.slice(0, 12)}` });
    if (!record(session) || typeof session.id !== "string" || !/^ses/u.test(session.id)) throw openCodeError("INVALID_OPENCODE_RESPONSE", "OpenCode 未返回有效会话。");
    sessionID = session.id;
    diagnostic({ event: "session_started", version: health.version, sessionID });
    const events = new OpenCodeEvents(sessionID, diagnostic);
    const eventSignal = AbortSignal.any([requestSignal, eventController.signal]);
    const stream = await fetch(`${address}/event`, { headers, signal: eventSignal, redirect: "error", cache: "no-store" });
    if (!stream.ok || !stream.body) throw openCodeError("OPENCODE_CONNECTION_FAILED", "无法订阅 OpenCode 诊断事件。");
    eventCompletion = events.consume(stream.body, eventSignal).catch(error => {
      if (!closing && !eventSignal.aborted) died.abort(error instanceof AppError ? error : openCodeError("OPENCODE_CONNECTION_FAILED", "OpenCode 诊断事件连接中断。"));
    });
    const seen = new Set<string>();
    let round = 0;
    return {
      sessionID, version: health.version,
      async prompt(text, agent, model, outputSchema) {
        const started = Date.now();
        round++;
        const requestID = `msg_${Date.now().toString(16)}${randomBytes(12).toString("hex")}`;
        events.register(requestID, round, outputSchema ? 3 : 20);
        diagnostic({ event: "round_started", round, agent, sessionID, requestID });
        const value = await rpc(`/session/${encodeURIComponent(sessionID)}/message`, "POST", {
          messageID: requestID, agent, ...(model ? { model } : {}), parts: [{ type: "text", text }],
          ...(outputSchema ? { format: { type: "json_schema", schema: outputSchema, retryCount: 0 } } : {}),
        });
        const message = decodeOpenCodeMessage(value, sessionID);
        if (message.info.role !== "assistant" || message.info.parentID !== requestID || seen.has(message.info.id) ||
          typeof message.info.time.completed !== "number" || !Number.isFinite(message.info.time.completed)) {
          throw openCodeError("INVALID_OPENCODE_RESPONSE", "OpenCode 返回了未完成、重复或无关联的消息。");
        }
        if (model && (message.info.modelID !== model.modelID || message.info.providerID !== model.providerID)) throw openCodeError("INVALID_OPENCODE_RESPONSE", "OpenCode 未沿用指定模型。");
        seen.add(message.info.id);
        events.message(message);
        diagnostic({ event: "round_completed", round, elapsedMs: Date.now() - started, error: message.info.error?.name });
        return message;
      },
      close,
    };
  } catch (error) { await close(); throw error; }
  finally { startupSignal.removeEventListener("abort", abortStartup); }
}
