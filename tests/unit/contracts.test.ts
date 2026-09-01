import { describe, expect, test } from "vitest";
import { normalizeCommentBody, projectNameFromCloneUrl } from "@/src/server/codehub";
import { extractOpenCodeFinalBody, parseReviewerBody } from "@/src/server/opencode";
import { reviewerResultSchema } from "@/src/server/schemas";
import { safeMarkdownUrl } from "@/src/shared/markdown";
import { assertSameOrigin, jsonBody } from "@/src/server/http";

describe("PRD boundary contracts", () => {
  test("comment Markdown becomes real CRLF without disturbing other characters", () => {
    const body = "标题\n\n- tab\t\"quoted\"\\path\rnext\r\nlast";
    const normalized = normalizeCommentBody(body);
    expect(normalized).toBe("标题\r\n\r\n- tab\t\"quoted\"\\path\r\nnext\r\nlast");
    expect(normalized).not.toContain("\\r\\n");
  });

  test("project display name comes from credential-free HTTPS repository path", () => {
    expect(projectNameFromCloneUrl("https://codehub.example/group/sub/repo.git")).toBe("group/sub/repo");
    expect(() => projectNameFromCloneUrl("https://codehub.example/")).toThrow();
  });

  test("OpenCode accepts one final JSON body and rejects prose or any invalid finding", () => {
    const body = JSON.stringify({ findings: [
      { severity: "major", body: "### 🟠 Major: Bug\n\nDetails" },
      { severity: "suggestion", body: "### 🟢 Suggestion: Test\n\nDetails", extra: true },
    ], extra: "minimum contract allows extra fields" });
    const stream = [
      JSON.stringify({ type: "step_start" }),
      JSON.stringify({ type: "text", part: { type: "text", text: body } }),
    ].join("\n");
    expect(parseReviewerBody(extractOpenCodeFinalBody(stream)).findings).toHaveLength(2);
    expect(() => parseReviewerBody("```json\n{\"findings\":[]}\n```")).toThrow(/JSON/u);
    expect(reviewerResultSchema.safeParse({ findings: [{ severity: "major", body: "" }] }).success).toBe(false);
    expect(() => extractOpenCodeFinalBody(`${JSON.stringify({ type: "error" })}\n`)).toThrow(/失败/u);
  });

  test("untrusted Markdown URLs allow public HTTP(S) only", () => {
    expect(safeMarkdownUrl("https://example.com/a?q=1")).toBe("https://example.com/a?q=1");
    for (const unsafe of [
      "javascript:alert(1)",
      "file:///C:/Windows/win.ini",
      "data:text/html,x",
      "http://127.0.0.1:3000/secret",
      "http://192.168.1.2/admin",
      "http://0.0.0.0/internal",
      "http://100.64.1.2/internal",
      "http://[::1]/internal",
      "http://[fc00::1]/internal",
      "http://[fe80::1]/internal",
      "http://[::ffff:127.0.0.1]/internal",
      "https://user:password@example.com/",
      "/relative/local/path",
    ]) expect(safeMarkdownUrl(unsafe)).toBe("");
  });

  test("mutations require the exact loopback Host, same Origin, and JSON", () => {
    const previous = process.env.REVIEWX_ORIGIN;
    process.env.REVIEWX_ORIGIN = "http://127.0.0.1:45678";
    try {
      expect(() => assertSameOrigin(new Request("http://127.0.0.1:45678/api/projects", {
        method: "POST",
        headers: { host: "127.0.0.1:45678", origin: "http://127.0.0.1:45678", "content-type": "application/json" },
        body: "{}",
      }))).not.toThrow();
      for (const headers of [
        { host: "localhost:45678", origin: "http://127.0.0.1:45678", "content-type": "application/json" },
        { host: "127.0.0.1:45678", origin: "http://evil.example", "content-type": "application/json" },
        { host: "127.0.0.1:45678", origin: "http://127.0.0.1:45678", "content-type": "text/plain" },
      ]) {
        expect(() => assertSameOrigin(new Request("http://127.0.0.1:45678/api/projects", { method: "POST", headers, body: "{}" }))).toThrow();
      }
    } finally {
      if (previous === undefined) delete process.env.REVIEWX_ORIGIN;
      else process.env.REVIEWX_ORIGIN = previous;
    }
  });

  test("JSON body enforcement measures streamed bytes even without Content-Length", async () => {
    const previous = process.env.REVIEWX_ORIGIN;
    process.env.REVIEWX_ORIGIN = "http://127.0.0.1:45678";
    try {
      const request = new Request("http://127.0.0.1:45678/api/projects", {
        method: "POST",
        headers: { host: "127.0.0.1:45678", origin: "http://127.0.0.1:45678", "content-type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(1024 * 1024) }),
      });
      await expect(jsonBody(request)).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });
    } finally {
      if (previous === undefined) delete process.env.REVIEWX_ORIGIN;
      else process.env.REVIEWX_ORIGIN = previous;
    }
  });
});
