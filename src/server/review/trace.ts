import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import type { ReviewPerformance } from "@/src/shared/review-contract";
import { digest } from "./materials";

type Fields = Record<string, unknown>;
const record = (value: unknown): Fields => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Metadata only. Writes are ordered and best effort, independent of report success. */
export class ReviewTrace {
  private started = performance.now();
  private pending = Promise.resolve();
  private sequence = 0;
  private seen = new Set<string>();
  private reads = new Set<string>();
  private steps = new Map<string, ReviewPerformance["tokens"]>();
  private spans = new Map<string, (outcome?: string) => void>();
  readonly sessions = new Map<string, string>();
  private counters = { httpRequests: 0, generationRequests: 0, toolCalls: 0, repeatedReads: 0 };
  private interrupted = false;
  private reconciliationFailed = false;
  private writeFailed = false;
  constructor(readonly attemptId: string, private file?: string) {}

  emit(type: string, fields: Fields = {}, stableId?: string): void {
    if (stableId && this.seen.has(stableId)) return;
    if (stableId) this.seen.add(stableId);
    const line = JSON.stringify({ ...fields, type, attemptId: this.attemptId, sequence: ++this.sequence,
      at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - this.started) }) + "\n";
    if (this.file) this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.file!), { recursive: true });
      await appendFile(this.file!, line, "utf8");
    }).catch(() => { this.writeFailed = true; });
  }
  span(name: string, fields: Fields = {}): (outcome?: string) => void {
    const start = performance.now(), spanId = `${name}:${++this.sequence}`;
    this.emit("span.start", { ...fields, name, spanId });
    let ended = false;
    const end = (outcome = "complete") => {
      if (ended) return; ended = true;
      this.spans.delete(spanId);
      this.emit("span.end", { ...fields, name, spanId, durationMs: performance.now() - start, outcome });
    };
    this.spans.set(spanId, end);
    return end;
  }
  closeSpans(outcome: string): void { for (const end of this.spans.values()) end(outcome); }
  http(route: string, method: string): void { this.counters.httpRequests++; this.emit("http.request", { route, method }); }
  generation(sessionID: string, agent: string): void {
    this.sessions.set(sessionID, agent); this.counters.generationRequests++;
    this.emit("generation.request", { sessionID, agent });
  }
  streamInterrupted(): void { this.interrupted = true; this.emit("observability.stream_interrupted"); }
  reconciliationFailure(sessionID: string): void { this.reconciliationFailed = true; this.emit("observability.reconciliation_failed", { sessionID }); }
  event(value: unknown): void {
    const event = record(value), properties = record(event.properties), info = record(properties.info);
    if (event.type === "session.created" && typeof info.id === "string" && this.sessions.has(String(info.parentID))) {
      this.sessions.set(info.id, "native-child"); this.emit("session.created", { sessionID: info.id, parentID: info.parentID }, `session:${info.id}`);
    }
    if (event.type === "message.updated") this.message({ info, parts: [] });
    if (event.type === "message.part.updated") this.part(record(properties.part));
    if (event.type === "session.status") {
      const status = record(properties.status);
      if (this.sessions.has(String(properties.sessionID))) this.emit("session.status", {
        sessionID: properties.sessionID, status: status.type, attempt: number(status.attempt), next: number(status.next),
      });
    }
  }
  message(value: unknown): void {
    const message = record(value), info = record(message.info), sessionID = String(info.sessionID ?? "");
    if (!this.sessions.has(sessionID)) return;
    const time = record(info.time);
    if (typeof info.agent === "string") this.sessions.set(sessionID, info.agent);
    if (info.role === "assistant" && typeof info.id === "string" && number(time.completed) !== null) this.emit("model.message", {
      sessionID, messageID: info.id, agent: this.sessions.get(sessionID), providerID: info.providerID, modelID: info.modelID,
      startedAt: number(time.created), completedAt: number(time.completed), hasError: !!info.error,
      durationMs: number(time.created) !== null ? Number(time.completed) - Number(time.created) : null,
    }, `message:${sessionID}:${info.id}`);
    if (Array.isArray(message.parts)) for (const part of message.parts) this.part({ ...record(part), sessionID, messageID: info.id });
  }
  private part(part: Fields): void {
    const sessionID = String(part.sessionID ?? "");
    if (!this.sessions.has(sessionID) || typeof part.id !== "string") return;
    const key = `${sessionID}:${part.messageID}:${part.id}`;
    const fields = { sessionID, messageID: part.messageID, partID: part.id, agent: this.sessions.get(sessionID) };
    if (part.type === "step-finish") {
      const tokens = record(part.tokens), cache = record(tokens.cache);
      const usage = { input: number(tokens.input), output: number(tokens.output), reasoning: number(tokens.reasoning), cacheRead: number(cache.read), cacheWrite: number(cache.write) };
      this.steps.set(key, usage);
      this.emit("model.step", { ...fields, tokens: usage, cost: number(part.cost) }, `step:${key}`);
    }
    if (part.type === "compaction") this.emit("model.compaction", fields, `compaction:${key}`);
    if (part.type === "retry") this.emit("model.retry", { ...fields, attempt: number(part.attempt), statusCode: number(record(part.error).statusCode) }, `retry:${key}`);
    if (part.type !== "tool") return;
    const state = record(part.state), time = record(state.time), input = record(state.input);
    if (!["completed", "error"].includes(String(state.status)) || this.seen.has(`tool:${key}`)) return;
    this.counters.toolCalls++;
    const output = typeof state.output === "string" ? state.output : undefined;
    const location = { path: typeof input.filePath === "string" ? input.filePath : undefined, offset: number(input.offset), limit: number(input.limit) };
    if (part.tool === "read" && output !== undefined) {
      const readKey = JSON.stringify({ ...location, hash: digest(output) });
      if (this.reads.has(readKey)) this.counters.repeatedReads++; else this.reads.add(readKey);
    }
    this.emit("tool.complete", { ...fields, toolCallID: part.callID, tool: part.tool, status: state.status,
      ...location, startedAt: number(time.start), completedAt: number(time.end),
      durationMs: number(time.start) !== null && number(time.end) !== null ? Number(time.end) - Number(time.start) : null,
      outputBytes: output === undefined ? null : Buffer.byteLength(output), outputHash: output === undefined ? null : digest(output),
    }, `tool:${key}`);
  }
  summary(): ReviewPerformance {
    const sum = (field: keyof ReviewPerformance["tokens"]) => {
      const values = [...this.steps.values()].map(step => step[field]);
      return !values.length || values.some(v => v === null) ? null : values.reduce<number>((a, v) => a + v!, 0);
    };
    return { ...this.counters, observedModelSteps: this.steps.size, providerAttempts: null,
      tokens: { input: sum("input"), output: sum("output"), reasoning: sum("reasoning"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite") },
      eventStreamInterrupted: this.interrupted, reconciliationFailed: this.reconciliationFailed, traceWriteFailed: this.writeFailed };
  }
  async flush(): Promise<void> { await this.pending; }
}
