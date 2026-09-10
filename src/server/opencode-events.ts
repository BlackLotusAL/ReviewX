import { openCodeError, type OpenCodeMessage, type ReviewTelemetry } from "./opencode-client";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

interface RequestTrace {
  requestID: string; round: number; limit: number; messages: Set<string>; parents: Set<string>;
  compacted: boolean; text?: string; user?: Record<string, unknown>;
}

function sameUserConfiguration(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  // Compare only the replayed user configuration; never use repository/model prose as provenance.
  return ["agent", "model", "format", "tools", "system"].every(key => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

/** Event metadata avoids the 1.18.25 history encoder bug for persisted OutputFormatJsonSchema users. */
export class OpenCodeEvents {
  private readonly requests = new Map<string, RequestTrace>();
  private readonly messageRounds = new Map<string, number>();
  private readonly usage = new Set<string>();
  private readonly tools = new Set<string>();
  private readonly compactionParts = new Set<string>();
  private activeRequest?: { requestID: string; round: number };
  private observedRequest?: RequestTrace;
  private readonly users = new Map<string, { request: RequestTrace; info: Record<string, unknown> }>();
  private readonly parentWaiters = new Set<() => void>();
  constructor(private readonly sessionID: string, private readonly diagnostic: (event: ReviewTelemetry) => void) {}

  register(requestID: string, round: number, limit: number, text?: string): void {
    this.requests.set(requestID, { requestID, round, limit, messages: new Set(), parents: new Set([requestID]), compacted: false, text });
    this.activeRequest = { requestID, round };
  }

  hasResponseParent(requestID: string, parentID: string | undefined): boolean {
    return parentID !== undefined && this.requests.get(requestID)?.parents.has(parentID) === true;
  }

  async waitForResponseParent(requestID: string, parentID: string | undefined, signal: AbortSignal, timeoutMs = 1000): Promise<boolean> {
    if (this.hasResponseParent(requestID, parentID)) return true;
    if (!parentID || signal.aborted) return false;
    // HTTP and SSE are separate sockets: the response may arrive before its provenance events.
    // This waits for evidence only; it neither resubmits a prompt nor reads historical messages.
    return new Promise(resolve => {
      const finish = (linked: boolean) => {
        clearTimeout(timer);
        this.parentWaiters.delete(check);
        signal.removeEventListener("abort", abort);
        resolve(linked);
      };
      const check = () => { if (this.hasResponseParent(requestID, parentID)) finish(true); };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.parentWaiters.add(check);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else check();
    });
  }

  message(message: OpenCodeMessage): void {
    this.info(message.info);
    for (const part of message.parts) this.part(part);
  }

  private info(info: Record<string, unknown>): void {
    if (info.sessionID === this.sessionID && info.role === "user" && typeof info.id === "string") {
      const request = this.requests.get(info.id);
      if (request?.requestID === info.id) {
        this.observedRequest = request;
        request.user = info;
      }
      // SSE order binds generated users to the last observed submitted user, not the latest HTTP call.
      // Late events from an earlier round therefore cannot authorize a parent in the next round.
      if (!this.users.has(info.id) && this.observedRequest) this.users.set(info.id, { request: this.observedRequest, info });
      return;
    }
    if (info.sessionID !== this.sessionID || info.role !== "assistant" || typeof info.id !== "string" || typeof info.parentID !== "string") return;
    const request = this.requests.get(info.parentID);
    if (!request) return;
    request.messages.add(info.id);
    this.messageRounds.set(info.id, request.round);
    if (request.messages.size > request.limit) throw openCodeError("OPENCODE_STEP_LIMIT", `OpenCode 单轮超过 ${request.limit} 个模型步骤，检视未完成。`);
    if (!record(info.time) || numeric(info.time.completed) === undefined || this.usage.has(info.id)) return;
    this.usage.add(info.id);
    const tokens = record(info.tokens) ? info.tokens : {}, cache = record(tokens.cache) ? tokens.cache : {};
    this.diagnostic({ event: "model_usage", round: request.round, step: request.messages.size, messageID: info.id,
      model: `${info.providerID}/${info.modelID}`, reportedCost: numeric(info.cost), inputTokens: numeric(tokens.input),
      outputTokens: numeric(tokens.output), reasoningTokens: numeric(tokens.reasoning), cacheReadTokens: numeric(cache.read), cacheWriteTokens: numeric(cache.write) });
    // A tool-only final investigation step still needs another model step to reach a conclusion.
    if (request.limit === 20 && request.messages.size === 20 && info.finish === "tool-calls")
      throw openCodeError("OPENCODE_STEP_LIMIT", "查证已用完 20 个模型步骤且尚未形成结论，检视未完成。");
  }

  private part(part: Record<string, unknown>): void {
    const user = part.sessionID === this.sessionID && typeof part.messageID === "string" ? this.users.get(part.messageID) : undefined;
    const request = user?.request;
    const messageID = typeof part.messageID === "string" ? part.messageID : undefined;
    if (request && messageID && part.type === "compaction" && part.auto === true) {
      request.compacted = true;
      // Count compaction model steps in the original round; do not accept summaries as final replies.
      this.requests.set(messageID, request);
    }
    if (request?.compacted && messageID && part.type === "text" && request.user &&
      (part.synthetic === true && record(part.metadata) && part.metadata.compaction_continue === true ||
        typeof request.text === "string" && part.text === request.text && sameUserConfiguration(user!.info, request.user))) {
      if (!request.parents.has(messageID)) {
        request.parents.add(messageID);
        this.requests.set(messageID, request);
        for (const check of this.parentWaiters) check();
        this.diagnostic({ event: "response_parent_linked", sessionID: this.sessionID, requestID: request.requestID,
          round: request.round, parentID: messageID,
          kind: part.synthetic === true && record(part.metadata) && part.metadata.compaction_continue === true ? "compaction_continuation" : "compaction_replay" });
      }
    }
    if (part.sessionID === this.sessionID && typeof part.id === "string" && !this.compactionParts.has(part.id) &&
      (part.type === "compaction" || (part.type === "text" && part.synthetic === true &&
        record(part.metadata) && part.metadata.compaction_continue === true))) {
      this.compactionParts.add(part.id);
      this.diagnostic({ event: part.type === "compaction" ? "compaction_started" : "compaction_continuation",
        sessionID: this.sessionID, ...this.activeRequest,
        messageID: typeof part.messageID === "string" ? part.messageID : undefined,
        auto: typeof part.auto === "boolean" ? part.auto : undefined,
        overflow: typeof part.overflow === "boolean" ? part.overflow : undefined });
    }
    if (part.sessionID === this.sessionID && part.type === "retry") throw openCodeError("OPENCODE_ERROR", "OpenCode 报告供应商或网络错误，检视已终止。");
    if (part.sessionID !== this.sessionID || part.type !== "tool" || typeof part.id !== "string" || typeof part.tool !== "string" || typeof part.messageID !== "string") return;
    const round = this.messageRounds.get(part.messageID);
    const state = record(part.state) ? part.state : {};
    if (!round || !["completed", "error"].includes(String(state.status)) || this.tools.has(part.id)) return;
    this.tools.add(part.id);
    const input = record(state.input) ? state.input : {};
    this.diagnostic({ event: "tool_call", round, tool: part.tool, outcome: String(state.status),
      path: typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : undefined });
  }

  async consume(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader(), decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (signal.aborted) return;
          throw openCodeError("OPENCODE_CONNECTION_FAILED", "OpenCode 诊断事件流中断。");
        }
        pending += decoder.decode(value, { stream: true });
        if (pending.length > 64 * 1024 * 1024) throw openCodeError("OPENCODE_OUTPUT_LIMIT", "OpenCode 事件超过大小上限。");
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/u.exec(pending)) !== null) {
          const frame = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
          const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          let event: unknown;
          try { event = JSON.parse(data); } catch { throw openCodeError("INVALID_OPENCODE_RESPONSE", "OpenCode 事件不是有效 JSON。"); }
          if (!record(event) || !record(event.properties)) continue;
          if (event.type === "session.compacted" && event.properties.sessionID === this.sessionID)
            this.diagnostic({ event: "session_compacted", sessionID: this.sessionID, ...this.activeRequest });
          if (event.type === "message.updated" && record(event.properties.info)) this.info(event.properties.info);
          if (event.type === "message.part.updated" && record(event.properties.part)) this.part(event.properties.part);
        }
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}
