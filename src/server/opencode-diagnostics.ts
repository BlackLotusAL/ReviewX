import type { ReviewTelemetry } from "./opencode-client";
import { Redactor } from "./redaction";

export const OPENCODE_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_CAUSES = 5;

function property(value: object, key: string): unknown {
  try { return Reflect.get(value, key); } catch { return undefined; }
}

/** Diagnostic text only: never enumerate an error's request/response/config objects. */
export class OpenCodeDiagnostics {
  private readonly redactor: Redactor;

  constructor(environment: Readonly<Record<string, string | undefined>>, password: string) {
    this.redactor = new Redactor({ ...environment,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_SERVER_AUTHORIZATION: Buffer.from(`reviewx:${password}`).toString("base64"),
    });
  }

  private limit(text: string, tail = false): string {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= OPENCODE_DIAGNOSTIC_BYTES) return text;
    const marker = tail ? "[truncated; last 16 KiB]\n" : "\n[truncated; first 16 KiB]";
    const budget = OPENCODE_DIAGNOSTIC_BYTES - Buffer.byteLength(marker);
    if (tail) {
      let start = bytes.length - budget;
      while ((bytes[start] & 0xc0) === 0x80) start++;
      return marker + bytes.subarray(start).toString("utf8");
    }
    let end = budget;
    while ((bytes[end] & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8") + marker;
  }

  text(value: string, tail = false): string {
    return this.limit(this.redactor.redact(value), tail);
  }

  event(event: ReviewTelemetry): ReviewTelemetry {
    return Object.fromEntries(Object.entries(event).map(([key, value]) =>
      [key, typeof value === "string" ? this.text(value) : value]));
  }

  error(error: unknown): string {
    const causes: Array<Record<string, string | number>> = [];
    const stacks: Array<{ depth: number; stack: string }> = [];
    const seen = new Set<object>();
    let current = error;
    let termination = "complete";
    for (let depth = 0; current !== undefined && current !== null; depth++) {
      if (typeof current === "object" && seen.has(current)) { termination = "circular cause"; break; }
      if (depth === MAX_CAUSES) { termination = "truncated; maximum 5 cause levels"; break; }
      const entry: Record<string, string | number> = { depth };
      if (typeof current !== "object") {
        entry.name = typeof current;
        entry.message = this.redactor.redact(typeof current === "function" ? "[function thrown]" : String(current));
        causes.push(entry);
        break;
      }
      seen.add(current);
      for (const key of ["name", "code", "message"]) {
        const value = property(current, key);
        if (typeof value === "string" || typeof value === "number") entry[key] = this.redactor.redact(String(value));
      }
      causes.push(entry);
      const stack = property(current, "stack");
      if (typeof stack === "string") stacks.push({ depth, stack: this.redactor.redact(stack) });
      current = property(current, "cause");
    }
    // Keep cause codes ahead of potentially long stacks. Redact fields before JSON escaping.
    return this.limit(JSON.stringify({ causes, termination, stacks }));
  }
}
