import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { OpenCodeReviewer, toolArgs, toolPermission } from "@/src/server/integrations/opencode";
import { digest } from "@/src/server/review/materials";
import type { NativeMessage } from "@/src/server/review/types";
import type { PreparedReview } from "@/src/server/integrations/git";
import type { ProcessOptions, ProcessResult } from "@/src/server/platform/process";

const nativeState = vi.hoisted(() => ({ exitEarly: false, url: "" }));
vi.mock("@/src/server/platform/resolve-command", () => ({ resolveCommand: async () => ({ name: "opencode", executable: "mock-native", prefixArgs: [] }) }));
vi.mock("@/src/server/platform/process", () => ({ runProcess: async (_command: unknown, _args: string[], options: ProcessOptions) => {
  expect(options.outputMode).toBe("tail");
  expect(options.maxOutputBytes).toBe(16 * 1024);
  options.onStdout?.("x".repeat(20 * 1024));
  options.onStderr?.("native stderr diagnostic\n");
  options.onStdout?.(nativeState.url);
  await new Promise<void>(resolve => {
    options.signal!.addEventListener("abort", () => resolve(), { once: true });
    if (nativeState.exitEarly) setTimeout(resolve, 100);
  });
  return { started: true, exitCode: 1, signal: null, stdout: "", stderr: "", timedOut: false, aborted: true, outputLimitExceeded: false } satisfies ProcessResult;
} }));
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test.each(["normal", "post-submit-error", "disconnect", "tool-conflict", "native-instructions", "new-version", "instruction-object", "instruction-mixed", "user-agents", "delayed-idle", "fetch-failure", "unsupported", "process-exit", "intermediate-idle", "missing-version"])("production native HTTP adapter: %s", async kind => {
  nativeState.exitEarly = kind === "process-exit";
  const root = await mkdtemp(join(tmpdir(), "reviewx HTTP ")); roots.push(root);
  const prepared: PreparedReview = { rootDirectory: root, sourceSha: "s", targetSha: "t", baseSha: "b", cleanup: async () => {},
    context: { scope: { sourceSha: "s", targetSha: "t", baseSha: "b", scopeHash: "hash", changes: [] }, diff: () => [], read: async () => [], search: async () => ({ matches: [], nextOffset: null, limitations: [] }) } };
  if (kind === "user-agents") { await mkdir(join(root, "opencode")); await writeFile(join(root, "opencode/AGENTS.md"), "User preferences"); }
  if (kind === "unsupported") prepared.context.scope.changes.push({ changeId: "binary", type: "D", oldPath: "binary.dat", diffPages: 0, diffHash: "", hunks: [], unsupported: "binary file" });
  const messages: NativeMessage[] = [{ info: { id: "m", role: "assistant", sessionID: "s", modelID: "default", providerID: "native", finish: "stop", time: { completed: 1 } }, parts: [] }];
  let events!: ServerResponse;
  let submitted = false;
  let requestCount = 0;
  const server = createServer(async (req, res) => {
    const json = (data: unknown) => res.end(JSON.stringify(data));
    const route = new URL(req.url!, "http://localhost").pathname;
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    try {
    if (route === "/global/health") return json({ healthy: true, version: kind === "missing-version" ? "" : kind === "new-version" ? "2.0.0" : "1.18.30" });
    if (route === "/config") {
      if (kind === "process-exit") return;
      if (kind === "fetch-failure") { res.destroy(); return; }
      return json({ instructions: kind === "native-instructions" ? ["uncontrolled.md"] : kind === "user-agents" ? [join(root, "opencode/AGENTS.md")] : kind === "instruction-object" ? { path: "legacy" } : kind === "instruction-mixed" ? [null, 42, {}, " "] : [] });
    }
    if (route === "/agent") return json([{ name: "reviewx", permission: Object.entries(toolPermission).map(([permission, action]) => ({ permission, pattern: "*", action })) }]);
    if (route === "/experimental/tool/ids") return json([...Object.keys(toolArgs), "bash", ...(kind === "tool-conflict" ? ["reviewx_submit"] : [])]);
    if (route === "/session") return json({ id: "s" });
    if (route === "/session/status") return json({});
    if (route === "/event") { events = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); return; }
    if (route === "/session/s/abort") return json(true);
    if (route === "/session/s/message" && req.method === "POST") {
      requestCount++;
      const request = JSON.parse(body);
      expect(request.model).toBeUndefined(); expect(request.variant).toBeUndefined(); expect(request.tools.bash).toBe(false);
      let call = 0;
      for (const [tool, data] of [["reviewx_index", { page: 0 }], ["reviewx_rules", { id: "general", page: 0 }], ["reviewx_submit", { contractVersion: "reviewx-review/1", completion: "complete", blockers: [], findings: [] }]] as const) {
        const toolModule = await import(/* @vite-ignore */ pathToFileURL(join(root, "trusted-config/tools", `${tool}.js`)).href);
        const context = { sessionID: "s", messageID: "m", callID: String(++call) };
        const output = await toolModule.default.execute(data, context);
        messages[0].parts.push({ type: "tool", tool, ...context, state: { status: "completed", input: data, output } });
      }
      submitted = true;
      const event = kind === "post-submit-error" ? { type: "session.error", properties: { sessionID: "s" } } : { type: "session.status", properties: { sessionID: "s", status: { type: "idle" } } };
      if (kind === "disconnect") events.destroy(); else if (kind === "delayed-idle") setTimeout(() => events.write(`data: ${JSON.stringify(event)}\n\n`), 11_000);
      else if (kind === "intermediate-idle") {
        events.write(`data: ${JSON.stringify(event)}\n\n`);
        events.write('data: {"type":"session.status","properties":{"sessionID":"s","status":{"type":"busy"}}}\n\n');
        setTimeout(() => events.write(`data: ${JSON.stringify(event)}\n\n`), 300);
      } else events.write(`data: ${JSON.stringify(event)}\n\n`);
      return json(messages[0]);
    }
    if (route === "/session/s/message") return json(messages);
    throw new Error(`Unexpected route ${route}`);
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  nativeState.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const result = new OpenCodeReviewer({ NODE_ENV: "test", XDG_CONFIG_HOME: root }).review("1", { projectId: "1", iid: "1", title: "Synthetic", sourceBranch: "s", targetBranch: "t", updatedAt: "now", state: "open" }, prepared, new AbortController().signal,
    { attemptId: "attempt", rules: { profileHash: "hash", resources: [{ id: "general", version: "1", body: "rules", resourceHash: digest("rules") }] } });
  if (["normal", "new-version", "instruction-object", "instruction-mixed", "user-agents", "delayed-idle", "unsupported", "intermediate-idle"].includes(kind)) {
    const accepted = await result; expect(accepted.submission?.findings).toEqual([]); expect(accepted.execution?.terminal.processExited).toBe(true); expect(accepted.execution?.receipts).toHaveLength(3); expect(accepted.execution.protocol).toBe(`opencode-http/${kind === "new-version" ? "2.0.0" : "1.18.30"}`);
    if (kind === "unsupported") expect(accepted.execution?.progress.limitations).toContain("跳过不支持变更：binary.dat（binary file）。");
  }
  else if (kind === "fetch-failure") {
    await expect(result).rejects.toMatchObject({ code: "OPENCODE_NETWORK_ERROR", classified: false, cause: expect.any(Error), technical: expect.stringContaining("/config"), stderr: expect.stringContaining("native stderr diagnostic") });
  } else if (kind === "process-exit") {
    await expect(result).rejects.toMatchObject({ code: "OPENCODE_PROTOCOL_ERROR", technical: expect.stringContaining("Process: exited=true"), stderr: expect.stringContaining("native stderr diagnostic") });
  } else if (kind === "disconnect") {
    await expect(result).rejects.toMatchObject({ code: "OPENCODE_PROTOCOL_ERROR", stderr: expect.stringContaining("native stderr diagnostic") });
  } else await expect(result).rejects.toThrow();
  expect(requestCount).toBe(["tool-conflict", "native-instructions", "fetch-failure", "process-exit", "missing-version"].includes(kind) ? 0 : 1);
  expect(submitted).toBe(requestCount === 1);
}, 25_000);
