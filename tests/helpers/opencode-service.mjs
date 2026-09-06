import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
const mode = process.env.FAKE_MODE;
const streams = new Set();
const capture = value => appendFileSync(process.env.FAKE_CAPTURE, `${JSON.stringify(value)}\n`);
const emit = (type, properties) => { for (const stream of streams) stream.write(`data: ${JSON.stringify({ type, properties })}\n\n`); };
const sessionID = "ses_transport_test";
let sequence = 0;
const server = createServer(async (request, response) => {
  const auth = `Basic ${Buffer.from(`reviewx:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
  if (request.headers.authorization !== auth || mode === "auth_error") { response.writeHead(401); response.end("{}"); return; }
  const url = new URL(request.url, "http://localhost");
  const body = []; for await (const chunk of request) body.push(chunk);
  const input = body.length ? JSON.parse(Buffer.concat(body).toString("utf8")) : undefined;
  capture({ path: url.pathname, method: request.method, input, directory: request.headers["x-opencode-directory"] });
  const json = value => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
  if (url.pathname === "/event") {
    response.writeHead(200, { "Content-Type": "text/event-stream" }); response.write(": connected\n\n"); streams.add(response);
    request.on("close", () => streams.delete(response)); return;
  }
  if (url.pathname === "/global/health") return json({ healthy: true, version: "1.18.25" });
  if (url.pathname === "/doc") return json({ components: { schemas: { AssistantMessage: { properties: mode === "old_version" ? {} : { structured: {} } } } } });
  if (url.pathname === "/session" && request.method === "POST") return json({ id: sessionID });
  if (url.pathname.endsWith("/abort") || request.method === "DELETE") return json(true);
  if (url.pathname === `/session/${sessionID}/message` && request.method === "POST") {
    sequence++;
    if (mode === "exit") { process.exit(7); }
    if (mode === "hang") return;
    if (mode === "step_limit") {
      for (let step = 0; step < 21; step++) emit("message.updated", { info: {
        id: `msg_step_${step}`, role: "assistant", parentID: input.messageID, sessionID, time: { created: 1, completed: 2 },
      } });
      return;
    }
    const info = { id: `msg_response_${sequence}`, parentID: mode === "wrong_parent" ? "msg_other" : input.messageID,
      sessionID: mode === "wrong_session" ? "ses_other" : sessionID, role: "assistant", providerID: "deepseek", modelID: "deepseek-v4-flash",
      time: { created: 1, ...(mode === "unfinished" ? {} : { completed: 2 }) },
      finish: "tool-calls", structured: { status: "complete", nextChecks: [], findings: [], limitations: [] },
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 0 } }, cost: 0.01 };
    emit("message.updated", { info }); emit("message.updated", { info });
    const part = { id: `prt_tool_${sequence}`, messageID: info.id, sessionID, type: "tool", tool: "StructuredOutput", state: { status: "completed", input: info.structured } };
    emit("message.part.updated", { part });
    return json({ info, parts: [part] });
  }
  response.writeHead(400); response.end("{}"); // History GET intentionally unavailable, matching the native format-encoding bug.
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  writeFileSync(process.env.FAKE_CAPTURE, `${JSON.stringify({ pid: process.pid, port, args: process.argv.slice(2),
    authLength: process.env.OPENCODE_SERVER_PASSWORD.length, db: process.env.OPENCODE_DB,
    codeHubToken: process.env.CODEHUB_TOKEN, config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) })}\n`);
  process.stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`);
});
