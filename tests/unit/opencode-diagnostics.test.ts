import { describe, expect, test } from "vitest";
import { OpenCodeDiagnostics, OPENCODE_DIAGNOSTIC_BYTES } from "@/src/server/opencode-diagnostics";

const password = "a".repeat(64);
const authorization = Buffer.from(`reviewx:${password}`).toString("base64");
const providerSecret = 'provider-"quoted"\\value\nsecret';
const diagnostics = new OpenCodeDiagnostics({ PROVIDER_API_KEY: providerSecret }, password);

describe("OpenCode diagnostic text", () => {
  test("keeps native error codes and causes without enumerating request or response data", () => {
    const cause = Object.assign(new Error(`socket reset ${providerSecret} ${password} Basic ${authorization}`), { code: "ECONNRESET" });
    const error = Object.assign(new TypeError("fetch failed", { cause }), {
      request: { body: "PRIVATE_PROMPT", headers: { Authorization: `Basic ${authorization}` } },
      response: { body: "PRIVATE_RESPONSE_BODY" },
    });
    const text = diagnostics.error(error);
    const parsed = JSON.parse(text);
    expect(parsed.causes).toEqual([
      { depth: 0, name: "TypeError", message: "fetch failed" },
      { depth: 1, name: "Error", code: "ECONNRESET", message: expect.stringContaining("socket reset") },
    ]);
    expect(parsed.stacks).toHaveLength(2);
    expect(parsed.stacks[0].stack).toContain("TypeError: fetch failed");
    for (const secret of [providerSecret, password, authorization, "PRIVATE_PROMPT", "PRIVATE_RESPONSE_BODY", "quoted"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("[REDACTED]");
  });

  test("terminates circular cause chains and limits deep chains to five levels", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    first.cause = second;
    const circular = JSON.parse(diagnostics.error(first));
    expect(circular.causes).toHaveLength(2);
    expect(circular.termination).toBe("circular cause");
    let error = new Error("not-included");
    for (let index = 0; index < 6; index++) error = new Error(`level-${index}`, { cause: error });
    const deep = JSON.parse(diagnostics.error(error));
    expect(deep.causes).toHaveLength(5);
    expect(deep.termination).toContain("truncated");
    expect(JSON.stringify(deep)).not.toContain("not-included");
  });

  test("redacts before truncating UTF-8 text and marks bounded output and errors", () => {
    const text = "discarded-prefix" + "文🧪".repeat(4000) + password + "tail";
    const tail = diagnostics.text(text, true);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(OPENCODE_DIAGNOSTIC_BYTES);
    expect(tail).toContain("truncated");
    expect(tail).toContain("[REDACTED]");
    expect(tail.endsWith("tail")).toBe(true);
    expect(tail).not.toContain("discarded-prefix");
    expect(tail).not.toContain("\ufffd");
    const hugeSecret = "confidential-" + "秘密".repeat(10_000);
    const redactor = new OpenCodeDiagnostics({ PROVIDER_API_KEY: hugeSecret }, password);
    expect(redactor.text(`prefix ${hugeSecret} suffix`, true)).toBe("prefix [REDACTED] suffix");
    const error = new Error("文🧪".repeat(5000));
    const diagnostic = diagnostics.error(error);
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(OPENCODE_DIAGNOSTIC_BYTES);
    expect(diagnostic).toContain("truncated");
    expect(diagnostic).not.toContain("\ufffd");
  });

  test("handles thrown primitives and inaccessible error fields without invoking serialization hooks", () => {
    expect(JSON.parse(diagnostics.error("connection failed")).causes[0].message).toBe("connection failed");
    const error = { name: "TransportError", code: "ECONNREFUSED",
      get message() { throw new Error("getter failure"); },
      toJSON() { throw new Error("must not run"); },
    };
    expect(JSON.parse(diagnostics.error(error)).causes[0]).toMatchObject({ name: "TransportError", code: "ECONNREFUSED" });
    expect(diagnostics.event({ event: "test", detail: `${password} ${authorization}`, elapsedMs: 123, aborted: false }))
      .toEqual({ event: "test", detail: "[REDACTED] [REDACTED]", elapsedMs: 123, aborted: false });
  });
});
