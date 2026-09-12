import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { connectOpenCode, type ReviewTelemetry } from "@/src/server/opencode-client";
import { reviewEnvironment, parseReviewCheckpoint } from "@/src/server/opencode";
import { reviewCheckpointJsonSchema } from "@/src/server/schemas";
import { completeCheckpoint, preparedFixture } from "../helpers/reviewer";

const { prepared } = await preparedFixture();
const artifacts = path.resolve("test-results", "ai", `protocol-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
const events: ReviewTelemetry[] = [], transcript: unknown[] = [];
const environment = reviewEnvironment(process.env);
const config = JSON.parse(environment.OPENCODE_CONFIG_CONTENT!);
config.agent.reviewx.prompt = "You are a protocol test agent. Remember exact fixture data and follow the next protocol verification instructions. Use no repository tools for this synthetic test.";
environment.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
const model = { providerID: "deepseek", modelID: "deepseek-v4-flash" };
let connection: Awaited<ReturnType<typeof connectOpenCode>> | undefined;
try {
  connection = await connectOpenCode(prepared, environment, AbortSignal.timeout(180_000), event => events.push(event));
  assert.equal((await stat(path.join(prepared.runtimeDirectory, "session.sqlite"))).isFile(), true);
  const checkpoint = completeCheckpoint();
  const requests: Array<[string, string, Record<string, unknown>?]> = [
    [`Remember this exact fixture checkpoint, including every section character: ${JSON.stringify(checkpoint)}. Reply only ACK.`, "reviewx"],
    ["Protocol verification complete. Repeat the retained checkpoint sections exactly, its confidence and evidence, and mark COMPLETE. Do not change any fixture data.", "reviewx"],
    ["Serialize the retained, verified checkpoint unchanged through StructuredOutput.", "reviewx_output_deepseek", reviewCheckpointJsonSchema],
    ["Continue after the structured output. Verify the initially retained fixture again. Mark COMPLETE and repeat its exact sections, confidence and evidence.", "reviewx"],
    ["Serialize the retained checkpoint again, unchanged, via StructuredOutput.", "reviewx_output_deepseek", reviewCheckpointJsonSchema],
  ];
  for (const [text, agent, schema] of requests) {
    const response = await connection.prompt(text, agent, model, schema);
    transcript.push({ text, agent, response });
    if (schema) assert.deepEqual(parseReviewCheckpoint(response.info.structured, prepared), parseReviewCheckpoint(checkpoint, prepared));
    process.stdout.write(`Protocol turn ${transcript.length}/5 passed
`);
  }
  await writeFile(path.join(artifacts, "result.json"), JSON.stringify({ passed: true, version: connection.version, model, transcript, events }, null, 2));
} finally {
  await writeFile(path.join(artifacts, "events.json"), JSON.stringify(events, null, 2));
  await connection?.close(); await prepared.cleanup();
}
