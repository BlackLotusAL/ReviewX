import { describe, expect, test } from "vitest";
import { digest, safeRepositoryPath, textPages } from "@/src/server/review/materials";
import { ResultReceiver } from "@/src/server/review/result-receiver";
import type { FixedContext, NativeMessage } from "@/src/server/review/types";
import type { ReviewSubmission } from "@/src/shared/review-contract";
import { Redactor } from "@/src/server/platform/redaction";

function fixture(unsupported = false) {
  const controller = new AbortController();
  const pages = textPages("line\n".repeat(401));
  const context: FixedContext = {
    scope: { sourceSha: "s", targetSha: "t", baseSha: "b", scopeHash: "hash", changes: ["a", "b"].map((name) => ({ changeId: name, type: "M", oldPath: name, newPath: name, diffHash: "diff", diffPages: 1, hunks: [] })) },
    diff: () => textPages("diff\n"), read: async (_, path) => { if (!["a", "b", "caller"].includes(path)) throw new Error("Unknown"); return pages; },
    search: async () => ({ matches: [{ path: "caller", line: 1 }], nextOffset: null, limitations: [] }),
  };
  if (unsupported) context.scope.changes.push({ changeId: "binary", type: "R", oldPath: "old.bin", newPath: "new.bin", diffHash: "", diffPages: 3, hunks: [], unsupported: "binary file" });
  const receiver = new ResultReceiver("session", context, { profileHash: "hash", resources: [{ id: "rule", version: "v1", body: "rules", resourceHash: digest("rules") }] }, controller.signal, new Redactor({}));
  const messages: NativeMessage[] = [{ info: { id: "message", sessionID: "session", role: "assistant", finish: "stop", time: { completed: 1 }, modelID: "default", providerID: "native" }, parts: [] }];
  let id = 0;
  async function call(tool: string, input: unknown, callID = String(++id)) {
    const output = await receiver.call(tool, input, { sessionID: "session", messageID: "message", callID });
    messages[0].parts.push({ type: "tool", tool, callID, sessionID: "session", messageID: "message", state: { status: "completed", input, output } });
    return output;
  }
  async function prepare() {
    await receiver.initialize();
    await call("reviewx_index", { page: 0 });
    await call("reviewx_rules", { id: "rule", page: 0 });
    for (const changeId of ["a", "b"]) await call("reviewx_diff", { changeId, page: 0 });
    for (const path of ["a", "b"]) for (const page of [0, 1]) await call("reviewx_read", { revision: "source", path, page });
  }
  const submission: ReviewSubmission = { contractVersion: "reviewx-review/1", completion: "complete", blockers: [], findings: ["a", "b"].map((path) => ({ severity: "major", body: `正文 ${path}\r\n \t\n`, changeIds: [path], evidence: [{ revision: "source", path, startLine: 199, endLine: 202 }] })) };
  function accept() { receiver.closed = true; return receiver.accept(messages, { idle: true, error: false, disconnected: false }); }
  return { receiver, messages, call, prepare, submission, accept, controller };
}

describe("production formal result boundary", () => {
  test("multiple bodies retain exact order and trailing bytes with continuous pages", async () => {
    const f = fixture(); await f.prepare(); await f.call("reviewx_submit", f.submission);
    expect(f.receiver.candidate).toEqual(f.submission);
    expect(() => f.receiver.accept(f.messages, { idle: true, error: false, disconnected: false })).toThrow();
    expect(f.accept().submission).toEqual(f.submission);
  });
  test("empty findings require complete material", async () => {
    const f = fixture(); f.submission.findings = []; await expect(f.call("reviewx_submit", f.submission)).rejects.toThrow();
    const g = fixture(); await g.prepare(); g.submission.findings = []; await g.call("reviewx_submit", g.submission); expect(g.accept().submission.findings).toEqual([]);
  });
  test.each(["unknown change", "wrong path", "wrong revision", "unread line", "empty body", "extra field", "incomplete"])("rejects entire second finding: %s", async (kind) => {
    const f = fixture(); await f.prepare(); const second = f.submission.findings[1];
    if (kind === "unknown change") second.changeIds = ["unknown"];
    if (kind === "wrong path") second.evidence[0].path = "a";
    if (kind === "wrong revision") second.evidence[0].revision = "base";
    if (kind === "unread line") second.evidence[0].endLine = 401;
    if (kind === "empty body") second.body = " ";
    if (kind === "extra field") Object.assign(second, { extra: true });
    if (kind === "incomplete") f.submission.completion = "incomplete";
    await expect(f.call("reviewx_submit", f.submission)).rejects.toThrow(); expect(() => f.accept()).toThrow();
  });
  test.each(["error", "cancel", "disconnect", "busy", "unknown finish", "missing receipt", "wrong session", "tool output changed"])("submission is insufficient after %s", async (kind) => {
    const f = fixture(); await f.prepare(); await f.call("reviewx_submit", f.submission); f.receiver.closed = true;
    if (kind === "cancel") f.controller.abort();
    if (kind === "unknown finish") f.messages[0].info.finish = "length";
    if (kind === "missing receipt") f.messages[0].parts.pop();
    if (kind === "wrong session") f.messages[0].info.sessionID = "other";
    if (kind === "tool output changed") f.messages[0].parts[0].state!.output = "altered";
    expect(() => f.receiver.accept(f.messages, { idle: kind !== "busy", error: kind === "error", disconnected: kind === "disconnect" })).toThrow();
  });
  test("chat-only output, no formal submit and foreign tool owner cannot succeed", async () => {
    const f = fixture(); await f.prepare(); expect(() => f.accept()).toThrow();
    await expect(f.receiver.call("reviewx_submit", f.submission, { sessionID: "other", messageID: "m", callID: "c" })).rejects.toThrow();
  });
  test("duplicate event deduplicates; distinct submits conflict", async () => {
    const f = fixture(); await f.prepare(); await f.call("reviewx_submit", f.submission, "submit"); const count = f.receiver.receipts.length;
    await f.call("reviewx_submit", f.submission, "submit"); expect(f.receiver.receipts).toHaveLength(count); expect(f.accept().submission).toEqual(f.submission);
    const g = fixture(); await g.prepare(); await g.call("reviewx_submit", g.submission); await expect(g.call("reviewx_submit", g.submission)).rejects.toThrow();
  });
  test("no shell tool and no model regex", async () => {
    const f = fixture(); await expect(f.call("bash", { command: "dir" })).rejects.toThrow();
    await expect(f.call("reviewx_search", { revision: "source", regex: ".*", offset: 0 })).rejects.toThrow();
  });
  test.each(["../x", "C:/x", "//host/share", "a\\b", "a/../b", "a/CON.txt", "a/aux", "a.", ".git/config", "a::$DATA"])("rejects Windows special path %s", (p) => expect(safeRepositoryPath(p)).toBe(false));
  test("pages preserve raw text without truncating long lines", () => {
    const raw = "行\r\n".repeat(405); const pages = textPages(raw);
    expect(pages.map(p => p.content).join("")).toBe(raw); expect(pages).toHaveLength(3);
    expect(() => textPages("x".repeat(32769))).toThrow();
  });
  test.each(["body", "count", "submission"])("rejects size limit without clipping: %s", async kind => {
    const f = fixture(); await f.prepare();
    if (kind === "body") f.submission.findings[0].body = "x".repeat(65537);
    if (kind === "count") f.submission.findings = Array.from({ length: 101 }, () => f.submission.findings[0]);
    if (kind === "submission") f.submission.findings = Array.from({ length: 20 }, () => ({ ...f.submission.findings[0], body: "x".repeat(60000) }));
    await expect(f.call("reviewx_submit", f.submission)).rejects.toThrow();
  });
  test("frozen rule hash is checked before any delivery", async () => {
    const f = fixture(); f.receiver.rules.resources[0].body = "changed";
    await expect(f.receiver.initialize()).rejects.toMatchObject({ code: "REVIEW_RULE_ERROR" });
  });
  test.each(["D", "R"])("required baseline pages for %s cannot be omitted", async type => {
    const f = fixture(); f.receiver.context.scope.changes[0].type = type;
    await f.prepare(); await expect(f.call("reviewx_submit", f.submission)).rejects.toMatchObject({ code: "REVIEW_INCOMPLETE" });
  });
});


test("unsupported changes are skipped without blocking supported findings", async () => {
  const f = fixture(true); await f.prepare();
  const index = JSON.parse(await f.call("reviewx_index", { page: 0 }));
  expect(index.requiredBase).toEqual([]);
  expect([...f.receiver.required].some(key => key.includes("binary") || key.includes("old.bin"))).toBe(false);
  expect(JSON.parse(await f.call("reviewx_diff", { changeId: "binary", page: 0 }))).toMatchObject({ totalPages: 0, note: expect.stringContaining("binary file") });
  expect(f.receiver.fatal).toBe(false);
  expect(f.receiver.snapshot().limitations).toEqual(["跳过不支持变更：new.bin（binary file）。"]);
  await f.call("reviewx_submit", f.submission);
  expect(f.accept().submission).toEqual(f.submission);
});

test.each(["changeId", "source", "base"])("unsupported finding references are rejected: %s", async kind => {
  const f = fixture(true); await f.prepare();
  if (kind === "changeId") f.submission.findings[0].changeIds.push("binary");
  else f.submission.findings[0].evidence.push({ revision: kind as "source" | "base", path: kind === "source" ? "new.bin" : "old.bin", startLine: 1, endLine: 1 });
  await expect(f.call("reviewx_submit", f.submission)).rejects.toMatchObject({ code: "INVALID_REVIEW_SCOPE" });
});

test.each(["terminal", "message", "completion"])("terminal diagnostics identify %s", async branch => {
  const f = fixture(); await f.prepare(); await f.call("reviewx_submit", f.submission);
  f.receiver.closed = branch !== "terminal";
  if (branch === "message") f.messages[0].info.sessionID = "foreign";
  if (branch === "completion") f.messages[0].info.finish = "length";
  try { f.receiver.accept(f.messages, { idle: true, error: false, disconnected: false }); throw new Error("Expected rejection"); }
  catch (error) { expect(error).toMatchObject({ code: "OPENCODE_FAILED", technical: expect.stringContaining('"branch":"' + branch + '"') }); }
});
