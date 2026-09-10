import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { connectOpenCode, type ReviewTelemetry } from "@/src/server/opencode-client";
import { parseReviewCheckpoint, reviewEnvironment } from "@/src/server/opencode";
import { reviewCheckpointJsonSchema } from "@/src/server/schemas";
import { completeCheckpoint, preparedFixture } from "../helpers/reviewer";

// Real OpenCode, deterministic local provider; no external model or repository data.
// The second turn reports overflowing usage to exercise native automatic compaction.
const artifacts = path.resolve("test-results", "compaction-probe", String(Date.now()));
await mkdir(artifacts, { recursive: true });
const events: ReviewTelemetry[] = [];
let overflowNext = false;
const calls: Array<{ ordinal: number; path: string; streaming: boolean; tools: string[]; inputTokens: number }> = [];
const server = createServer(async (request, response) => {
  const buffers = [];
  for await (const chunk of request) buffers.push(chunk);
  const body = JSON.parse(Buffer.concat(buffers).toString("utf8"));
  const ordinal = calls.length + 1;
  const inputTokens = overflowNext ? 200_000 : 100;
  overflowNext = false;
  calls.push({ ordinal, path: request.url ?? "", streaming: body.stream === true,
    tools: (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name), inputTokens });
  const common = { id: `chatcmpl_${ordinal}`, created: 1, model: "fixture" };
  const usage = { prompt_tokens: inputTokens, completion_tokens: 1, total_tokens: inputTokens + 1 };
  response.writeHead(200, { "Content-Type": body.stream ? "text/event-stream" : "application/json" });
  if (body.stream) {
    const structured = calls.at(-1)!.tools.includes("StructuredOutput");
    const delta = structured ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${ordinal}`, type: "function",
      function: { name: "StructuredOutput", arguments: JSON.stringify(completeCheckpoint([])) } }] }
      : { role: "assistant", content: "COMPLETE: synthetic protocol fixture only." };
    for (const value of [
      { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
      { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: structured ? "tool_calls" : "stop" }], usage },
    ]) response.write(`data: ${JSON.stringify(value)}\n\n`);
    response.end("data: [DONE]\n\n");
  } else response.end(JSON.stringify({ ...common, object: "chat.completion", usage,
    choices: [{ index: 0, message: { role: "assistant", content: "Synthetic summary." }, finish_reason: "stop" }] }));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const { prepared } = await preparedFixture();
let connection: Awaited<ReturnType<typeof connectOpenCode>> | undefined;
try {
  const environment = reviewEnvironment(process.env);
  const config = JSON.parse(environment.OPENCODE_CONFIG_CONTENT!);
  config.enabled_providers = ["reviewx_fixture"];
  config.model = "reviewx_fixture/fixture";
  config.small_model = "reviewx_fixture/fixture";
  config.agent.title = { disable: true };
  config.provider = { reviewx_fixture: { npm: "@ai-sdk/openai-compatible", name: "Local protocol fixture",
    options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-fixture-only" },
    models: { fixture: { name: "fixture", limit: { context: 128_000, output: 1000 } } } } };
  environment.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  const model = { providerID: "reviewx_fixture", modelID: "fixture" };
  connection = await connectOpenCode(prepared, environment, AbortSignal.timeout(60_000), event => {
    events.push(event);
    if (["message_received", "message_rejected", "compaction_started", "compaction_continuation", "session_compacted"].includes(String(event.event)))
      process.stdout.write(`${JSON.stringify(event)}\n`);
  });
  await connection.prompt("First synthetic protocol turn. Reply COMPLETE.", "reviewx", model);
  overflowNext = true;
  const reply = await connection.prompt("Second synthetic protocol turn. Reply COMPLETE.", "reviewx", model);
  assert(events.some(event => event.event === "compaction_started" && event.round === 2));
  assert(events.some(event => event.event === "response_parent_linked" && event.round === 2 && event.parentID === reply.info.parentID));
  const output = await connection.prompt("Serialize the synthetic complete checkpoint with empty findings, nextChecks and limitations.",
    "reviewx_output", model, reviewCheckpointJsonSchema);
  assert.deepEqual(parseReviewCheckpoint(output.info.structured, prepared), completeCheckpoint([]));
  assert(!events.some(event => event.event === "message_rejected"));
  await writeFile(path.join(artifacts, "result.json"), JSON.stringify({ passed: true, version: connection.version,
    note: "Controlled native compaction compatibility test; not the remote user's unprovided response." }, null, 2));
  process.stdout.write(`Native compaction continuation validated. Artifacts: ${artifacts}\n`);
} finally {
  await connection?.close();
  await prepared.cleanup();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await writeFile(path.join(artifacts, "events.json"), JSON.stringify(events, null, 2));
  await writeFile(path.join(artifacts, "calls.json"), JSON.stringify(calls, null, 2));
}
