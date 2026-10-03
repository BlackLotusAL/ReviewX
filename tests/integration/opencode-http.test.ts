import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { OpenCodeReviewer, nativeConfig } from "@/src/server/integrations/opencode";
import type { PreparedReview } from "@/src/server/integrations/git";
import type { ProcessOptions } from "@/src/server/platform/process";
import { structuredFinding } from "../helpers/runtime";

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

test.each(["normal", "disconnect", "lost-response", "repair", "bad-repair", "post-error", "new-version", "informational-note", "prefixed-location", "real-prefix-directory"])("native adapter: %s", async kind => {
  const root = await mkdtemp(join(tmpdir(), "native-review-")); roots.push(root);
  const prepared: PreparedReview = { rootDirectory: root, sourceSha: "s", targetSha: "t", baseSha: "b",
    scope: { sourceSha: "s", targetSha: "t", baseSha: "b", changedPaths: [] }, repositoryRules: [], limitations: [], gitCommands: [], cleanup: async () => {} };
  let events: ServerResponse | undefined, sessions = 0, generations = 0;
  const input = { schemaVersion: 1, summary: "完成", completion: "complete", limitations: kind === "informational-note" ? ["仓库没有额外规则文件，代码检视已完成"] : [], findings: [structuredFinding()] };
  if (["prefixed-location", "real-prefix-directory"].includes(kind)) {
    input.findings[0].locations[0].path = "source/fixture.ts";
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
  if (kind === "real-prefix-directory") expect(result.submission.findings[0].locations[0].path).toBe("source/fixture.ts");
  expect(generations).toBe(["repair", "bad-repair"].includes(kind) ? 2 : 1);
  expect(result.submission.completion).toBe(["bad-repair", "post-error"].includes(kind) ? "incomplete" : "complete");
  events?.destroy();
});
test("permissions deny editing and scripts for every child, format agent has no tools", () => {
  const config = nativeConfig({ gitCommands: ["git -C source log -20 --oneline abc"] } as PreparedReview);
  for (const name of ["reviewx-rules", "reviewx-bugs", "reviewx-verify"] as const) {
    expect(config.agent[name].permission["*"]).toBe("deny");
    expect(config.agent[name].permission.bash["*"]).toBe("deny");
    expect(config.agent[name]).not.toHaveProperty("model");
  }
  expect(config.agent["reviewx-format"].permission).toEqual({ "*": "deny" });
});
