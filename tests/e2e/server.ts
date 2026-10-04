import { createServer } from "node:http";
import next from "next";
import { installRuntimeForTests } from "@/src/server/bootstrap";
import { configureMr, createRuntimeHarness, generatedFinding } from "../helpers/runtime";
import { renderFinding } from "@/src/shared/finding-markdown";

const host = "127.0.0.1";
const port = 3210;
const origin = `http://${host}:${port}`;
process.env.REVIEWX_ORIGIN = origin;

const harness = await createRuntimeHarness();
configureMr(harness, "101", "1", "Security-sensitive parser update");
configureMr(harness, "101", "2", "Queue worker tests");
// Leave time for browser actions and the dev server's first stop-route compilation.
harness.reviewer.delayMs = 3_000;
const correctedFinding = generatedFinding("单位换算缺失导致重试提前触发。");
correctedFinding.title = "恢复延迟单位换算"; correctedFinding.tags = ["功能回归", "单位换算"];
correctedFinding.locations[0].endLine = 2;
correctedFinding.locations[0].highlights = [{ startLine: 1, endLine: 2 }];
correctedFinding.locations[0].snippet = { language: "typescript", code: "const value = seconds;\nreturn value;" };
correctedFinding.locations[0].annotations = [{ line: 2, text: "缺少秒到毫秒换算，导致重试提前。" }];
correctedFinding.locations.push({ path: "delay.py", revision: "source", startLine: 2, endLine: 2,
  highlights: [{ startLine: 2, endLine: 2 }], snippet: { language: "python", code: "    return seconds" }, annotations: [{ line: 2, text: "Python 实现同样缺少毫秒换算。" }] });
correctedFinding.locations.push({ path: "fixture.ts", revision: "source", startLine: 5, endLine: 5, label: "调用方", highlights: [],
  snippet: { language: "typescript", code: "schedule(value);" }, annotations: [{ line: 5, text: "调用方按毫秒使用该值。" }] });
correctedFinding.solutions[0] = { kind: "recommended", description: "恢复两个实现的秒到毫秒换算。", steps: [
  { description: "修复 TypeScript 实现。", path: "fixture.ts", example: { language: "typescript", code: "return seconds * 1000;" } },
  { description: "修复 Python 实现。", path: "delay.py", example: { language: "python", code: "def delay(seconds):\n    return seconds * 1000" } },
] };
harness.reviewer.results.set("1", {
  findings: [
    {
      severity: "major",
      body: [
        "### 🟠 Major: Unsafe Markdown probe",
        "",
        "The visible text is safe.",
        "",
        "<script>window.__reviewxInjected = true</script>",
        "",
        "<form action=\"https://evil.example\"><input name=\"secret\"></form>",
        "",
        "<iframe src=\"https://evil.example\"></iframe>",
        "",
        "[Local file](file:///C:/Windows/win.ini)",
        "![Loopback image](http://127.0.0.1:65535/private.png)",
        "![Public image](https://example.com/public.png)",
        "[Public documentation](https://example.com/docs)",
      ].join("\n"),
    },
    { severity: "suggestion", body: renderFinding({ ...correctedFinding, severity: "suggestion" }) },
  ],
});
harness.reviewer.results.set("2", { findings: [] });
installRuntimeForTests(harness.runtime);

const application = next({ dev: process.env.REVIEWX_E2E_PRODUCTION !== "1", dir: process.cwd(), hostname: host, port });
await application.prepare();
const handler = application.getRequestHandler();
const server = createServer((request, response) => {
  if (request.headers.host !== `${host}:${port}`) {
    response.statusCode = 421;
    response.end("Invalid Host");
    return;
  }
  void handler(request, response);
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolve);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await harness.cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
