import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { OpenCodeReviewer, nativeConfig } from "@/src/server/integrations/opencode";
import type { PreparedReview } from "@/src/server/integrations/git";
import type { ProcessOptions } from "@/src/server/platform/process";
import { generatedFinding as structuredFinding } from "../helpers/runtime";
import { ReviewTrace } from "@/src/server/review/trace";

const state = vi.hoisted(() => ({ url: "" }));
vi.mock("@/src/server/platform/resolve-command", () => ({ resolveCommand: async () => ({ name: "opencode", executable: "mock", prefixArgs: [] }) }));
vi.mock("@/src/server/platform/process", () => ({ runProcess: async (_: unknown, _args: string[], options: ProcessOptions) => {
  options.onStdout?.(state.url);
  await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
  return { exitCode: 0, aborted: true };
} }));
const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test.each(["normal", "disconnect", "lost-response", "repair", "bad-repair", "long-brief", "english-tag", "missing-annotation", "bad-annotation", "misgrouped-solution", "missing-source", "post-error", "new-version", "informational-note", "prefixed-location", "real-prefix-directory"])("native adapter: %s", async kind => {
  const root = await mkdtemp(join(tmpdir(), "native-review-")); roots.push(root);
  const prepared: PreparedReview = { rootDirectory: root, sourceSha: "s", targetSha: "t", baseSha: "b",
    scope: { sourceSha: "s", targetSha: "t", baseSha: "b", changedPaths: [] }, repositoryRules: [], limitations: [], gitCommands: [], cleanup: async () => {} };
  let events: ServerResponse | undefined, sessions = 0, generations = 0;
  const input = { schemaVersion: 1, summary: "完成", completion: "complete", limitations: kind === "informational-note" ? ["仓库没有额外规则文件，代码检视已完成"] : [], findings: [structuredFinding()] };
  input.findings[0].tags = ["逻辑错误", "逻辑错误"];
  if (kind !== "missing-source") {
    await mkdir(join(root, "source"));
    await writeFile(join(root, "source", "fixture.ts"), "const value = 1;\n");
  }
  if (kind === "long-brief") input.findings.push(structuredFinding("字".repeat(121)));
  if (kind === "english-tag") { const invalid = structuredFinding("标签待修复"); invalid.tags = ["bug"]; input.findings.push(invalid); }
  if (["missing-annotation", "bad-annotation", "misgrouped-solution"].includes(kind)) {
    const invalid = structuredFinding("结构待修复");
    if (kind === "missing-annotation") delete invalid.locations[0].annotations;
    if (kind === "bad-annotation") invalid.locations[0].annotations![0].line = 2;
    if (kind === "misgrouped-solution") invalid.solutions[0] = { description: "缺少明确分组。", example: { language: "ts", code: "repair();" } };
    input.findings.push(invalid);
  }
  if (["prefixed-location", "real-prefix-directory"].includes(kind)) {
    input.findings[0].locations[0].path = "source/fixture.ts";
    input.findings[0].solutions[0].steps![0].path = "source/fixture.ts";
    await mkdir(join(root, "source", "source"), { recursive: true });
    await writeFile(join(root, "source", "fixture.ts"), "code");
    if (kind === "real-prefix-directory") await writeFile(join(root, "source", "source", "fixture.ts"), "other code");
  }
  let last: object;
  const server = createServer(async (req, res) => {
    const route = req.url;
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const json = (value: unknown) => res.end(JSON.stringify(value));
    if (route === "/global/health") return json({ healthy: true, version: kind === "new-version" ? "999.0" : "test" });
    if (route === "/agent") return json(Object.keys(nativeConfig(prepared).agent).map(name => ({ name })));
    if (route === "/session") return json({ id: "s" + (++sessions) });
    if (route === "/event") { events = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); if (kind === "disconnect") res.destroy(); return; }
    if (route === "/session/status") return json({});
    if (route?.endsWith("/abort")) return json(true);
    if (route?.endsWith("/message") && req.method === "POST") {
      generations++;
      expect(body.model).toBeUndefined();
      const malformed = kind === "bad-repair" || (kind === "repair" && generations === 1);
      const document = malformed ? { ...input, findings: [...input.findings, { severity: "bad" }] } : generations === 2 ? { ...input, findings: [structuredFinding("修复后的另一条意见")] } : input;
      last = { info: { role: "assistant", providerID: "any-provider", modelID: "any-model", ...(kind === "post-error" ? { error: { message: "tail failure" } } : {}) },
        parts: [{ type: "text", text: JSON.stringify(document) }] };
      if (kind === "lost-response") { res.destroy(); return; }
      return json(last);
    }
    if (route?.endsWith("/message")) return json([last]);
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  state.url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const result = await new OpenCodeReviewer({ NODE_ENV: "test" }).review("1", { projectId: "1", iid: "1", title: "MR", state: "open", updatedAt: "now", sourceBranch: "f", targetBranch: "m" },
    prepared, new AbortController().signal, { attemptId: "test", rules: { profileHash: "", resources: [] } });
  expect(result.findings.length).toBeGreaterThan(0);
  expect(result.findings[0].body).toContain("### 🟠 Major");
  if (kind === "prefixed-location") expect(result.submission.findings[0].locations[0].path).toBe("fixture.ts");
  if (kind === "prefixed-location") expect(result.submission.findings[0].solutions[0].steps![0].path).toBe("fixture.ts");
  if (kind === "real-prefix-directory") expect(result.submission.findings[0].locations[0].path).toBe("source/fixture.ts");
  if (kind === "real-prefix-directory") expect(result.submission.findings[0].solutions[0].steps![0].path).toBe("source/fixture.ts");
  expect(generations).toBe(["repair", "bad-repair", "long-brief", "english-tag", "missing-annotation", "bad-annotation", "misgrouped-solution"].includes(kind) ? 2 : 1);
  expect(result.submission.completion).toBe(["bad-repair", "post-error"].includes(kind) ? "incomplete" : "complete");
  expect(result.findings[0].structured!.tags).toEqual(["逻辑错误"]);
  if (kind === "normal") {
    expect(result.findings[0].body).toContain("```typescript\n// 【检视注释·问题行 L1】此处逻辑导致调用结果错误。\nconst value = 1;\n```");
    expect(result.submission.findings[0].locations[0].snippet?.code).toBe("const value = 1;");
    expect(result.findings[0].body).toContain("**推荐方案**");
    expect(result.execution.warnings).toEqual([]);
  }
  if (kind === "missing-source") { expect(result.execution.warnings.some(w => w.includes("无法展示源码"))).toBe(true); expect(result.submission.findings[0].locations[0].snippet).toBeUndefined(); }
  if (["long-brief", "english-tag", "missing-annotation", "bad-annotation", "misgrouped-solution"].includes(kind)) { expect(result.findings).toHaveLength(2); expect(result.submission.findings[0].description).toBe("发现问题"); }
  events?.destroy();
});
test("permissions deny editing and scripts for every child, format agent has no tools", () => {
  const config = nativeConfig({ gitCommands: ["git -C source log -20 --oneline abc"] } as PreparedReview);
  for (const name of ["reviewx-rules", "reviewx-bugs", "reviewx-verify", "reviewx-discover", "reviewx-batch-verify"] as const) {
    expect(config.agent[name].permission["*"]).toBe("deny");
    expect(config.agent[name].permission.bash["*"]).toBe("deny");
    expect(config.agent[name]).not.toHaveProperty("model");
  }
  expect(config.agent["reviewx-format"].permission).toEqual({ "*": "deny" });
});

test.each(["normal", "lost-response", "sse-lost"])("balanced HTTP workflow: %s", async kind => {
  const root = await mkdtemp(join(tmpdir(), "balanced-http-")); roots.push(root);
  const prepared: PreparedReview = { rootDirectory: root, sourceSha: "s", targetSha: "t", baseSha: "b",
    scope: { sourceSha: "s", targetSha: "t", baseSha: "b", changedPaths: ["fixture.ts"] }, repositoryRules: [], limitations: [], gitCommands: [], cleanup: async () => {} };
  await mkdir(join(root, "source")); await writeFile(join(root, "source", "fixture.ts"), "const actual = true;\n");
  let session = 0, posts = 0;
  const messages = new Map<string, object>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const json = (value: unknown) => res.end(JSON.stringify(value));
    if (req.url === "/global/health") return json({ healthy: true, version: "test" });
    if (req.url === "/agent") return json(Object.keys(nativeConfig(prepared).agent).map(name => ({ name })));
    if (req.url === "/session") return json({ id: `s${++session}` });
    if (req.url === "/session/status") return json({});
    if (req.url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
      if (kind === "sse-lost") res.destroy();
      return;
    }
    if (req.url?.endsWith("/children")) return json([]);
    if (req.url?.endsWith("/abort")) return json(true);
    const id = req.url?.split("/")[2] ?? "";
    if (req.url?.endsWith("/message") && req.method === "GET") return json([messages.get(id)]);
    if (req.url?.endsWith("/message") && req.method === "POST") {
      posts++;
      const prompt = body.parts[0].text as string;
      const doc = body.agent === "reviewx-discover"
        ? { schemaVersion: 1, summary: "完成", completion: "complete", limitations: [], findings: Array.from({ length: 5 }, (_, i) => structuredFinding(`问题 ${i}`)) }
        : { verdicts: (JSON.parse(prompt.split("\nCandidates:\n")[1]) as Array<{ id: string; finding: object }>).map(c => ({ ...c, status: "confirmed", evidence: "独立核对" })) };
      const message = { info: { id: "m" + id, sessionID: id, role: "assistant", agent: body.agent, providerID: "test", modelID: "test", time: { created: 1, completed: 2 } },
        parts: [{ type: "text", text: JSON.stringify(doc) }, { id: "p" + id, messageID: "m" + id, sessionID: id, type: "step-finish", tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 0, write: 0 } } }] };
      messages.set(id, message);
      if (kind === "lost-response" && body.agent === "reviewx-batch-verify") { res.destroy(); return; }
      return json(message);
    }
    res.writeHead(404).end();
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  state.url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const traceFile = join(root, "trace.jsonl");
  const result = await new OpenCodeReviewer({ NODE_ENV: "test", REVIEWX_WORKFLOW: "balanced" }).review("1",
    { projectId: "1", iid: "1", title: "MR", state: "open", updatedAt: "now", sourceBranch: "f", targetBranch: "m" }, prepared,
    new AbortController().signal, { attemptId: "test", rules: { profileHash: "", resources: [] }, trace: new ReviewTrace("test", traceFile) });
  expect(posts).toBe(3); expect(result.findings).toHaveLength(5); expect(result.submission.completion).toBe("complete");
  expect(result.submission.findings.every(f => f.locations[0].snippet?.code === "const actual = true;")).toBe(true);
  expect(result.execution.workflowVersion).toBe("balanced-review/3");
  expect(result.execution.performance?.observedModelSteps).toBe(3);
  expect(result.execution.performance?.tokens.input).toBe(30);
  expect(result.execution.performance?.reconciliationFailed).toBe(false);
  if (kind === "sse-lost") expect(result.execution.performance?.eventStreamInterrupted).toBe(true);
  expect(await readFile(traceFile, "utf8")).toContain('"type":"verification.summary"');
});
