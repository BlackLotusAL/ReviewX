import { describe, expect, test } from "vitest";
import { digest, reviewError, safeRepositoryPath, textPages } from "@/src/server/review/materials";
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
    messages[0].parts.push({ type: "tool", tool, callID, sessionID: "session", messageID: "message", state: { status: "completed", input: structuredClone(input), output } });
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
    const f = fixture(); f.submission.findings = []; expect(JSON.parse(await f.call("reviewx_submit", f.submission)).status).toBe("REJECTED");
    const g = fixture(); await g.prepare(); g.submission.findings = []; await g.call("reviewx_submit", g.submission); expect(g.accept().submission.findings).toEqual([]);
  });
  test.each(["unknown change", "wrong path", "wrong revision", "unread line", "empty body", "extra field"])("drops invalid second finding: %s", async (kind) => {
    const f = fixture(); await f.prepare(); const second = f.submission.findings[1];
    if (kind === "unknown change") second.changeIds = ["unknown"];
    if (kind === "wrong path") second.evidence[0].path = "a";
    if (kind === "wrong revision") second.evidence[0].revision = "base";
    if (kind === "unread line") second.evidence[0].endLine = 401;
    if (kind === "empty body") second.body = " ";
    if (kind === "extra field") Object.assign(second, { extra: true });
    await f.call("reviewx_submit", f.submission); expect(f.accept().submission).toMatchObject({ completion: "incomplete", findings: [f.submission.findings[0]] });
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
  test("duplicate events and identical new submits are idempotent", async () => {
    const f = fixture(); await f.prepare(); await f.call("reviewx_submit", f.submission, "submit"); const count = f.receiver.receipts.length;
    await f.call("reviewx_submit", f.submission, "submit"); expect(f.receiver.receipts).toHaveLength(count); expect(f.accept().submission).toEqual(f.submission);
    const g = fixture(); await g.prepare(); await g.call("reviewx_submit", g.submission); expect(JSON.parse(await g.call("reviewx_submit", g.submission)).duplicate).toBe(true);
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
    expect(JSON.parse(await f.call("reviewx_submit", f.submission)).status).toBe(kind === "body" ? "SUBMITTED" : "REJECTED");
  });
  test("frozen rule hash is checked before any delivery", async () => {
    const f = fixture(); f.receiver.rules.resources[0].body = "changed";
    await expect(f.receiver.initialize()).rejects.toMatchObject({ code: "REVIEW_RULE_ERROR" });
  });
  test.each(["D", "R"])("required baseline pages for %s cannot be omitted", async type => {
    const f = fixture(); f.receiver.context.scope.changes[0].type = type;
    await f.prepare(); expect(JSON.parse(await f.call("reviewx_submit", f.submission)).status).toBe("REJECTED");
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
  await f.call("reviewx_submit", f.submission); expect(f.accept().submission).toMatchObject({ completion: "incomplete", findings: [f.submission.findings[1]] });
});

test.each(["terminal", "message", "completion"])("terminal diagnostics identify %s", async branch => {
  const f = fixture(); await f.prepare(); await f.call("reviewx_submit", f.submission);
  f.receiver.closed = branch !== "terminal";
  if (branch === "message") f.messages[0].info.sessionID = "foreign";
  if (branch === "completion") f.messages[0].info.finish = "length";
  try { f.receiver.accept(f.messages, { idle: true, error: false, disconnected: false }); throw new Error("Expected rejection"); }
  catch (error) { expect(error).toMatchObject({ code: "OPENCODE_FAILED", technical: expect.stringContaining("branch: " + branch) }); }
});


test("incomplete with no findings and missing materials is partial, not pass", async () => {
  const f = fixture(); f.submission = { ...f.submission, completion: "incomplete", blockers: ["Needs context"], findings: [] };
  await f.call("reviewx_submit", f.submission);
  expect(f.accept().submission.completion).toBe("incomplete");
  expect(f.receiver.snapshot().limitations.join(" ")).toContain("缺失必需材料");
});
test("rejected replacement preserves valid candidate; valid replacement does not merge findings", async () => {
  const f = fixture(); await f.prepare(); await f.call("reviewx_submit", f.submission);
  expect(JSON.parse(await f.call("reviewx_submit", { broken: true })).status).toBe("REJECTED");
  expect(f.receiver.candidate).toEqual(f.submission);
  const next = { ...f.submission, findings: [f.submission.findings[1]] };
  await f.call("reviewx_submit", next);
  expect(f.accept().submission).toEqual(next);
});
test("reading missing evidence then resubmitting identical content restores completeness", async () => {
  const f = fixture(); await f.prepare();
  const next = { ...f.submission, findings: [{ ...f.submission.findings[0], evidence: [{ revision: "source" as const, path: "a", startLine: 401, endLine: 401 }] }] };
  await f.call("reviewx_submit", next);
  expect(f.receiver.candidate).toMatchObject({ completion: "incomplete", findings: [] });
  await f.call("reviewx_read", { revision: "source", path: "a", page: 2 });
  expect(JSON.parse(await f.call("reviewx_submit", next)).duplicate).toBe(false);
  expect(f.accept().submission).toEqual(next);
  expect(f.receiver.snapshot().limitations).toEqual([]);
  expect(f.receiver.diagnostics.some(d => d.code === "FINDING_DROPPED")).toBe(true);
});
test("known unreadable material and invalid parameters recover; unknown internal errors remain fatal", async () => {
  const f = fixture(); await f.prepare();
  f.receiver.context.read = async () => { throw reviewError("REVIEW_INCOMPLETE", "Cannot paginate"); };
  expect(JSON.parse(await f.call("reviewx_read", { revision: "source", path: "a", page: 0 })).status).toBe("ERROR");
  expect(JSON.parse(await f.call("reviewx_index", { page: 99 })).status).toBe("ERROR");
  expect(f.receiver.fatal).toBe(false);
  f.receiver.context.read = async () => { throw new Error("Unexpected disk failure"); };
  await expect(f.call("reviewx_read", { revision: "source", path: "a", page: 0 })).rejects.toThrow();
  expect(f.receiver.fatal).toBe(true);
});
test("same call ID with altered parameters is fatal", async () => {
  const f = fixture(); await f.call("reviewx_index", { page: 0 }, "same");
  await expect(f.call("reviewx_index", { page: 1 }, "same")).rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
});
