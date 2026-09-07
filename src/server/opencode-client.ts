import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { resolveCommand } from "@/src/cli/resolve-command";
import { AppError } from "./errors";
import type { PreparedReview } from "./git";
import { runProcess, type ResolvedCommand } from "./process";
import { OpenCodeEvents } from "./opencode-events";
import { OpenCodeDiagnostics } from "./opencode-diagnostics";

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

interface ResponseProgress {
  stage: "waiting_headers" | "response_headers" | "reading_body" | "parsing_json";
  responseBytes: number;
  status?: number;
}

async function responseJson(response: Response, progress: ResponseProgress): Promise<unknown> {
  if (!response.ok) throw openCodeError("OPENCODE_HTTP_ERROR", `OpenCode 本机接口返回 HTTP ${response.status}。`);
  if (!response.body) throw openCodeError("INVALID_OPENCODE_RESPONSE", "OpenCode 返回了空响应。");
  progress.stage = "reading_body";
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      progress.responseBytes = bytes;
      if (bytes > 64 * 1024 * 1024) throw openCodeError("OPENCODE_OUTPUT_LIMIT", "OpenCode 响应超过 64 MiB 上限。");
      buffers.push(next.value);
    }
    progress.stage = "parsing_json";
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
  const serviceStarted = Date.now();
  const resolved = command ?? await resolveCommand("opencode", environment);
  const password = randomBytes(32).toString("hex");
  const diagnostics = new OpenCodeDiagnostics(environment, password);
  let address = "", sessionID = "", version = "";
  let activeRequestID: string | undefined;
  let activeRound: number | undefined;
  let failureOutput = false;
  const emit = (event: ReviewTelemetry) => diagnostic(diagnostics.event({
    sessionID: sessionID || undefined, version: version || undefined,
    requestID: activeRequestID, round: activeRound, ...event,
  }));
  const controller = new AbortController();
  const died = new AbortController();
  const processSignal = AbortSignal.any([signal, controller.signal]);
  const requestSignal = AbortSignal.any([signal, died.signal]);
  let closing = false;
  let startupText = "";
  let resolveAddress!: (address: string) => void;
  let rejectAddress!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => { resolveAddress = resolve; rejectAddress = reject; });
  emit({ event: "service_starting", nodeVersion: process.version, undiciVersion: process.versions.undici,
    executable: resolved.executable, launcher: resolved.powerShellScript });
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
    const unexpectedExit = !closing && !signal.aborted;
    if (!closing) {
      const error = openCodeError(result.aborted ? "OPENCODE_CANCELLED" : "OPENCODE_SERVER_EXIT",
        result.aborted ? "检视已按停止请求终止。" : "OpenCode 服务在检视完成前退出。",
        `exit=${result.exitCode}; timeout=${result.timedOut}; outputLimit=${result.outputLimitExceeded}`);
      rejectAddress(error); died.abort(error);
    }
    emit({ event: "service_exited", elapsedMs: Date.now() - serviceStarted,
      exitCode: result.exitCode ?? "unavailable", processSignal: result.signal ?? undefined,
      started: result.started, timedOut: result.timedOut, aborted: result.aborted, outputLimitExceeded: result.outputLimitExceeded,
      cleanupRequested: closing, reviewAborted: signal.aborted,
      stopReason: result.timedOut ? "process_timeout" : result.outputLimitExceeded ? "output_limit" :
        !result.aborted ? "unexpected_exit" : signal.aborted ? "review_cancelled" : closing ? "cleanup" : "process_cancelled" });
    if (failureOutput || unexpectedExit || result.timedOut || result.outputLimitExceeded) {
      for (const stream of ["stdout", "stderr"] as const) {
        if (result[stream]) emit({ event: "service_output", stream, text: diagnostics.text(result[stream], true) });
      }
    }
  }, error => {
    rejectAddress(error); died.abort(error);
    emit({ event: "service_start_failed", elapsedMs: Date.now() - serviceStarted, error: diagnostics.error(error) });
  });
  // The promise is still awaited during cleanup; observe diagnostic write failures immediately.
  void completion.catch(() => undefined);
  const startupSignal = AbortSignal.any([requestSignal, AbortSignal.timeout(30_000)]);
  const abortStartup = () => rejectAddress(openCodeError("OPENCODE_STARTUP_FAILED", "OpenCode 服务启动超时或被停止。"));
  startupSignal.addEventListener("abort", abortStartup, { once: true });
  const eventController = new AbortController();
  let eventCompletion: Promise<void> | undefined;
  const headers = { Authorization: `Basic ${Buffer.from(`reviewx:${password}`).toString("base64")}`,
    "Content-Type": "application/json", "x-opencode-directory": encodeURIComponent(prepared.rootDirectory) };
  const rpc = async (path: string, method = "GET", body?: unknown, overrideSignal?: AbortSignal): Promise<unknown> => {
    const started = Date.now();
    const progress: ResponseProgress = { stage: "waiting_headers", responseBytes: 0 };
    const requestID = record(body) && typeof body.messageID === "string" ? body.messageID : activeRequestID;
    const context = { method, path, requestID };
    const requestAbort = overrideSignal ?? requestSignal;
    emit({ event: "http_started", ...context });
    try {
      const response = await fetch(`${address}${path}`, { method, headers, redirect: "error", cache: "no-store",
        body: body === undefined ? undefined : JSON.stringify(body), signal: requestAbort });
      progress.status = response.status;
      progress.stage = "response_headers";
      emit({ event: "http_headers", ...context, status: response.status, elapsedMs: Date.now() - started });
      const value = await responseJson(response, progress);
      emit({ event: "http_completed", ...context, status: response.status, responseBytes: progress.responseBytes, elapsedMs: Date.now() - started });
      return value;
    } catch (error) {
      if (!signal.aborted) failureOutput = true;
      emit({ event: "http_failed", ...context, ...progress, elapsedMs: Date.now() - started,
        aborted: requestAbort.aborted, reviewAborted: signal.aborted, serviceAborted: died.signal.aborted,
        error: diagnostics.error(error) });
      if (died.signal.aborted) throw died.signal.reason;
      if (signal.aborted) throw openCodeError("OPENCODE_CANCELLED", "检视已停止或达到总时限。");
      if (error instanceof AppError) throw error;
      throw openCodeError("OPENCODE_CONNECTION_FAILED", "无法取得 OpenCode 本机接口响应。");
    }
  };
  const close = async () => {
    if (closing) return;
    closing = true;
    const started = Date.now();
    let cleanupStep = "abort_session";
    try {
      if (sessionID && !signal.aborted && !died.signal.aborted) {
        const cleanupSignal = AbortSignal.timeout(5_000);
        await rpc(`/session/${encodeURIComponent(sessionID)}/abort`, "POST", undefined, cleanupSignal);
        cleanupStep = "delete_session";
        await rpc(`/session/${encodeURIComponent(sessionID)}`, "DELETE", undefined, cleanupSignal);
      }
    } catch (error) {
      emit({ event: "session_cleanup", outcome: "process_cleanup_required", step: cleanupStep,
        elapsedMs: Date.now() - started, error: diagnostics.error(error) });
    }
    finally { eventController.abort(); controller.abort(); await Promise.all([completion, eventCompletion]); }
  };
  try {
    if (startupSignal.aborted) abortStartup();
    address = await ready;
    startupSignal.removeEventListener("abort", abortStartup);
    emit({ event: "service_listening", address, elapsedMs: Date.now() - serviceStarted });
    const health = await rpc("/global/health");
    if (!record(health) || health.healthy !== true || typeof health.version !== "string") throw openCodeError("OPENCODE_INCOMPATIBLE", "OpenCode 健康检查不符合接口契约。");
    version = health.version;
    emit({ event: "service_healthy", elapsedMs: Date.now() - serviceStarted });
    const schema = await rpc("/doc");
    const properties = record(schema) && record(schema.components) && record(schema.components.schemas) &&
      record(schema.components.schemas.AssistantMessage) && schema.components.schemas.AssistantMessage.properties;
    if (!record(properties) || !("structured" in properties)) throw openCodeError("OPENCODE_INCOMPATIBLE", "需要支持 info.structured 的 OpenCode 版本（已验证 1.18.25）。");
    const session = await rpc("/session", "POST", { title: `ReviewX ${prepared.sourceSha.slice(0, 12)}` });
    if (!record(session) || typeof session.id !== "string" || !/^ses/u.test(session.id)) throw openCodeError("INVALID_OPENCODE_RESPONSE", "OpenCode 未返回有效会话。");
    sessionID = session.id;
    emit({ event: "session_started", version: health.version, sessionID });
    const events = new OpenCodeEvents(sessionID, event => diagnostic(diagnostics.event(event)));
    const eventSignal = AbortSignal.any([requestSignal, eventController.signal]);
    const eventStarted = Date.now();
    let eventStatus: number | undefined;
    emit({ event: "sse_started", method: "GET", path: "/event" });
    try {
      const stream = await fetch(`${address}/event`, { headers, signal: eventSignal, redirect: "error", cache: "no-store" });
      eventStatus = stream.status;
      emit({ event: "sse_headers", method: "GET", path: "/event", status: eventStatus, elapsedMs: Date.now() - eventStarted });
      if (!stream.ok || !stream.body) throw openCodeError("OPENCODE_CONNECTION_FAILED", "无法订阅 OpenCode 诊断事件。");
      eventCompletion = events.consume(stream.body, eventSignal).then(() => {
        emit({ event: "sse_closed", path: "/event", aborted: eventSignal.aborted, elapsedMs: Date.now() - eventStarted });
      }, error => {
        if (!closing && !eventSignal.aborted) {
          failureOutput = true;
          try {
            emit({ event: "sse_failed", method: "GET", path: "/event", stage: "reading_body",
              status: eventStatus, elapsedMs: Date.now() - eventStarted, error: diagnostics.error(error) });
          } finally {
            died.abort(error instanceof AppError ? error : openCodeError("OPENCODE_CONNECTION_FAILED", "OpenCode 诊断事件连接中断。"));
          }
        } else {
          emit({ event: "sse_closed", path: "/event", aborted: eventSignal.aborted, elapsedMs: Date.now() - eventStarted });
        }
      });
      void eventCompletion.catch(() => undefined);
    } catch (error) {
      if (!signal.aborted) failureOutput = true;
      emit({ event: "sse_failed", method: "GET", path: "/event", stage: eventStatus === undefined ? "waiting_headers" : "response_headers",
        status: eventStatus, aborted: eventSignal.aborted, elapsedMs: Date.now() - eventStarted, error: diagnostics.error(error) });
      throw error;
    }
    const seen = new Set<string>();
    let round = 0;
    return {
      sessionID, version: health.version,
      async prompt(text, agent, model, outputSchema) {
        const started = Date.now();
        round++;
        const requestID = `msg_${Date.now().toString(16)}${randomBytes(12).toString("hex")}`;
        activeRequestID = requestID;
        activeRound = round;
        events.register(requestID, round, outputSchema ? 3 : 20);
        emit({ event: "round_started", round, agent, sessionID, requestID });
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
        emit({ event: "round_completed", round, elapsedMs: Date.now() - started, error: message.info.error?.name });
        return message;
      },
      close,
    };
  } catch (error) {
    try {
      emit({ event: "connection_failed", elapsedMs: Date.now() - serviceStarted, listening: Boolean(address),
        aborted: signal.aborted, startupAborted: startupSignal.aborted, error: diagnostics.error(error) });
    } finally { await close(); }
    throw error;
  }
  finally { startupSignal.removeEventListener("abort", abortStartup); }
}
