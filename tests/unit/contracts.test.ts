import { describe, expect, test } from "vitest";
import { isOpenMrState, normalizeCommentBody, projectNameFromCloneUrl } from "@/src/server/integrations/codehub";
import { submissionSchema } from "@/src/server/review/schema";
import { codeHubRepoSchema, codeHubMrSchema } from "@/src/server/integrations/codehub-schemas";
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

  test("CodeHub open-state aliases are accepted without accepting terminal states", () => {
    for (const state of ["open", "opened", "OPEN", " Opened "]) expect(isOpenMrState(state)).toBe(true);
    for (const state of ["closed", "merged", "locked", "reopened", ""]) expect(isOpenMrState(state)).toBe(false);
  });

  test("CodeHub MR web_url must be credential-free HTTPS", () => {
    const mr = {
      iid: "7",
      state: "opened",
      source_branch: "feature",
      target_branch: "main",
      updated_at: "2026-09-02T00:00:00Z",
      web_url: "https://codehub.example/team/repo/merge_requests/7",
    };
    expect(codeHubMrSchema.parse(mr).web_url).toBe(mr.web_url);
    expect(codeHubMrSchema.safeParse({ ...mr, web_url: undefined }).success).toBe(false);
    expect(codeHubMrSchema.safeParse({ ...mr, web_url: "not a URL" }).success).toBe(false);
    expect(codeHubMrSchema.safeParse({ ...mr, web_url: "http://codehub.example/mr/7" }).success).toBe(false);
    expect(codeHubMrSchema.safeParse({ ...mr, web_url: "https://token@codehub.example/mr/7" }).success).toBe(false);
  });

  test("formal contract is strict and chat JSON is not a result", () => {
    expect(submissionSchema.safeParse({ findings: [] }).success).toBe(false);
    expect(submissionSchema.safeParse({ contractVersion: "reviewx-review/1", completion: "complete", blockers: [], findings: [] }).success).toBe(true);
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


test("project web_url is a required string and is passed through without URL validation", () => {
  const repo = { clone_urls: { https: "https://codehub.example/a/b.git" } };
  for (const web_url of [undefined, null, 42]) {
    expect(codeHubRepoSchema.safeParse({ ...repo, web_url }).success).toBe(false);
  }
  for (const web_url of ["", "relative/path", "http://codehub.example/a", "https://user:pass@codehub.example/a"]) {
    expect(codeHubRepoSchema.parse({ ...repo, web_url }).web_url).toBe(web_url);
  }
});
