import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { OpenCodeReviewer, toolArgs, toolPermission } from "@/src/server/integrations/opencode";
import { digest } from "@/src/server/review/materials";
import type { NativeMessage } from "@/src/server/review/types";
import type { PreparedReview } from "@/src/server/integrations/git";
import type { ProcessOptions, ProcessResult } from "@/src/server/platform/process";

vi.mock("@/src/server/platform/resolve-command", () => ({ resolveCommand: async () => ({ name: "opencode", executable: "mock-native", prefixArgs: [] }) }));
vi.mock("@/src/server/platform/process", () => ({ runProcess: async (_command: unknown, _args: string[], options: ProcessOptions) => {
  options.onStdout?.("http://127.0.0.1:19281");
  await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
  return { started: true, exitCode: 1, signal: null, stdout: "", stderr: "", timedOut: false, aborted: true, outputLimitExceeded: false } satisfies ProcessResult;
} }));
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test.each(["normal", "post-submit-error", "disconnect", "tool-conflict", "native-instructions"])("production native HTTP adapter: %s", async kind => {
  const root = await mkdtemp(join(tmpdir(), "reviewx HTTP ")); roots.push(root);
  const prepared: PreparedReview = { rootDirectory: root, sourceSha: "s", targetSha: "t", baseSha: "b", cleanup: async () => {},
    context: { scope: { sourceSha: "s", targetSha: "t", baseSha: "b", scopeHash: "hash", changes: [] }, diff: () => [], read: async () => [], search: async () => ({ matches: [], nextOffset: null, limitations: [] }) } };
  const nativeFetch = globalThis.fetch;
  const messages: NativeMessage[] = [{ info: { id: "m", role: "assistant", sessionID: "s", modelID: "default", providerID: "native", finish: "stop", time: { completed: 1 } }, parts: [] }];
  let events!: ReadableStreamDefaultController<Uint8Array>;
  let submitted = false;
  let requestCount = 0;
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (!input.startsWith("http://127.0.0.1:19281")) return nativeFetch(input, init);
    const url = new URL(input), route = url.pathname;
    if (route === "/global/health") return json({ healthy: true, version: "1.18.30" });
    if (route === "/config") return json(kind === "native-instructions" ? { instructions: ["uncontrolled.md"] } : {});
    if (route === "/agent") return json([{ name: "reviewx", permission: Object.entries(toolPermission).map(([permission, action]) => ({ permission, pattern: "*", action })) }]);
    if (route === "/experimental/tool/ids") return json([...Object.keys(toolArgs), "bash", ...(kind === "tool-conflict" ? ["reviewx_submit"] : [])]);
    if (route === "/session") return json({ id: "s" });
    if (route === "/session/status") return json({});
    if (route === "/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) { events = controller; init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* already disconnected */ } }, { once: true }); } }));
    if (route === "/session/s/abort") return json(true);
    if (route === "/session/s/message" && init?.method === "POST") {
      requestCount++;
      const request = JSON.parse(init.body as string);
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
      if (kind === "disconnect") events.error(new Error("stream lost")); else events.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      return json(messages[0]);
    }
    if (route === "/session/s/message") return json(messages);
    throw new Error(`Unexpected route ${route}`);
  });
  const result = new OpenCodeReviewer({ NODE_ENV: "test", XDG_CONFIG_HOME: root }).review("1", { projectId: "1", iid: "1", title: "Synthetic", sourceBranch: "s", targetBranch: "t", updatedAt: "now", state: "open" }, prepared, new AbortController().signal,
    { attemptId: "attempt", rules: { profileHash: "hash", resources: [{ id: "general", version: "1", body: "rules", resourceHash: digest("rules") }] } });
  if (kind === "normal") { const accepted = await result; expect(accepted.submission?.findings).toEqual([]); expect(accepted.execution?.terminal.processExited).toBe(true); expect(accepted.execution?.receipts).toHaveLength(3); }
  else await expect(result).rejects.toThrow();
  expect(requestCount).toBe(kind === "tool-conflict" || kind === "native-instructions" ? 0 : 1);
  expect(submitted).toBe(requestCount === 1);
}, 15_000);
