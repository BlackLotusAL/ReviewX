import { openCodeError, type OpenCodeMessage, type ReviewTelemetry } from "./opencode-client";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Event metadata avoids the 1.18.25 history encoder bug for persisted OutputFormatJsonSchema users. */
export class OpenCodeEvents {
  private readonly requests = new Map<string, { round: number; limit: number; messages: Set<string> }>();
  private readonly messageRounds = new Map<string, number>();
  private readonly usage = new Set<string>();
  private readonly tools = new Set<string>();
  constructor(private readonly sessionID: string, private readonly diagnostic: (event: ReviewTelemetry) => void) {}

  register(requestID: string, round: number, limit: number): void {
    this.requests.set(requestID, { round, limit, messages: new Set() });
  }

  message(message: OpenCodeMessage): void {
    this.info(message.info);
    for (const part of message.parts) this.part(part);
  }

  private info(info: Record<string, unknown>): void {
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
          if (event.type === "message.updated" && record(event.properties.info)) this.info(event.properties.info);
          if (event.type === "message.part.updated" && record(event.properties.part)) this.part(event.properties.part);
        }
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}
