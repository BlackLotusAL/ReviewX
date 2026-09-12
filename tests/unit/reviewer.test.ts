import { afterEach, describe, expect, test, vi } from "vitest";
import { OpenCodeReviewer, parseReviewCheckpoint, reviewEnvironment, type ReviewerPhase } from "@/src/server/opencode";
import type { OpenCodeConnection, OpenCodeConnectionFactory, OpenCodeMessage } from "@/src/server/opencode-client";
import { assistant, completeCheckpoint, finding, preparedFixture, structuredFinding } from "../helpers/reviewer";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
async function harness(responses: OpenCodeMessage[]) {
  const fixture = await preparedFixture(); cleanups.push(fixture.prepared.cleanup);
  const prompt = vi.fn<OpenCodeConnection["prompt"]>(async () => { const next = responses.shift(); if (!next) throw new Error("Unexpected extra model request"); return next; });
  const close = vi.fn(async () => undefined);
  const connect: OpenCodeConnectionFactory = vi.fn(async () => ({ sessionID: "ses_test", version: "1.18.25", prompt, close }));
  const reviewer = new OpenCodeReviewer({ NODE_ENV: "test" }, { connect });
  const phase = vi.fn<(phase: ReviewerPhase) => Promise<void>>(async () => undefined);
  const run = (signal = new AbortController().signal) => reviewer.review("101", fixture.details, fixture.prepared, signal, { phase });
  return { ...fixture, prompt, close, connect, phase, run };
}

describe("multi-turn reviewer", () => {
  test.each(["title", "description", "locations", "impact", "solution", "prevention"])("requires %s and corrects missing sections once", async key => {
    const invalid = { ...structuredFinding } as Record<string, unknown>; delete invalid[key];
    const bad = { ...completeCheckpoint(), findings: [invalid] };
    const h = await harness([assistant(), assistant(), assistant(bad), assistant(completeCheckpoint())]);
    expect((await h.run()).findings).toEqual([finding]);
    expect(h.prompt).toHaveBeenCalledTimes(4);
    const failed = await harness([assistant(), assistant(), assistant(bad), assistant(bad)]);
    await expect(failed.run()).rejects.toMatchObject({ code: "INVALID_REVIEWER_OUTPUT" });
  });
  test("rejects positions that do not refer to evidence", async () => {
    const h = await harness([]);
    expect(() => parseReviewCheckpoint({ ...completeCheckpoint(), findings: [{ ...structuredFinding, locations: [{ evidenceIndex: 1, symbol: "allow" }] }] }, h.prepared)).toThrow();
  });
  test("investigates, always verifies, and reads only the structured result with confidence/evidence", async () => {
    const h = await harness([assistant(completeCheckpoint([])), assistant(), assistant(completeCheckpoint())]);
    expect(await h.run()).toEqual({ findings: [finding], limitations: [] });
    expect(h.phase.mock.calls.map(call => call[0])).toEqual(["understanding_changes", "verifying_findings", "finalizing_review"]);
    expect(h.prompt.mock.calls).toHaveLength(3);
    expect(h.prompt.mock.calls[2]).toEqual([expect.any(String), "reviewx_output_deepseek", { providerID: "deepseek", modelID: "deepseek-v4-flash" }, expect.any(Object)]);
    expect(h.close).toHaveBeenCalledOnce();
  });
  test("requests missing context, retains low confidence, and preserves limitations", async () => {
    const h = await harness([assistant(), assistant(), assistant({ status: "needs_context", nextChecks: ["Read caller guard"], findings: [], limitations: [] }),
      assistant(), assistant({ ...completeCheckpoint([{ ...finding, confidence: 89 }]), limitations: ["External contract unavailable"] })]);
    expect(await h.run()).toEqual({ findings: [{ ...finding, confidence: 89 }], limitations: ["External contract unavailable"] });
    expect(h.prompt.mock.calls[3]?.[0]).toContain("Read caller guard");
    expect(h.prompt).toHaveBeenCalledTimes(5);
  });
  test.each([[[0]], [[35]], [[89]], [[90]], [[100]], [[90, 0, 100, 35, 89]]])("preserves all scores and ordered bodies: %j", async (scores) => {
    const findings = scores.map((confidence, index) => ({ ...finding, confidence, body: `${finding.body}\n\nFinding ${index}` }));
    const h = await harness([assistant(), assistant(), assistant(completeCheckpoint(findings))]);
    expect((await h.run()).findings).toEqual(parseReviewCheckpoint(completeCheckpoint(findings), h.prepared).findings);
  });
  test("never treats exhausted verification as PASS", async () => {
    const incomplete = () => assistant({ status: "needs_context", nextChecks: ["Missing critical caller"], findings: [], limitations: [] });
    const h = await harness([assistant(), assistant(), incomplete(), assistant(), incomplete(), assistant(), incomplete()]);
    await expect(h.run()).rejects.toMatchObject({ code: "REVIEW_INCOMPLETE" });
    expect(h.prompt).toHaveBeenCalledTimes(7);
    expect(h.close).toHaveBeenCalledOnce();
  });
  test("corrects structure once within the existing session without another investigation", async () => {
    const h = await harness([assistant(), assistant(), assistant(undefined, "StructuredOutputError"), assistant(completeCheckpoint())]);
    expect((await h.run()).findings).toEqual([finding]);
    expect(h.prompt).toHaveBeenCalledTimes(4);
    expect(h.prompt.mock.calls[3]?.[0]).toContain("Correct only");
  });
  test("refuses a second format failure and does not retry provider failures", async () => {
    const h = await harness([assistant(), assistant(), assistant({}), assistant({})]);
    await expect(h.run()).rejects.toMatchObject({ code: "INVALID_REVIEWER_OUTPUT" });
    expect(h.prompt).toHaveBeenCalledTimes(4);
    const provider = await harness([assistant(undefined, "ProviderAuthError")]);
    await expect(provider.run()).rejects.toMatchObject({ code: "OPENCODE_ERROR" });
    expect(provider.prompt).toHaveBeenCalledOnce();
  });
  test("shares the single correction budget across separate verification rounds", async () => {
    const h = await harness([assistant(), assistant(), assistant({}),
      assistant({ status: "needs_context", nextChecks: ["Check caller"], findings: [], limitations: [] }),
      assistant(), assistant({})]);
    await expect(h.run()).rejects.toMatchObject({ code: "INVALID_REVIEWER_OUTPUT" });
    expect(h.prompt).toHaveBeenCalledTimes(6);
    expect(h.prompt.mock.calls[5]?.[0]).toContain("Serialize the most recent verification");
  });
  test("rejects missing finish markers and keeps ordinary model serialization in its normal configuration", async () => {
    const unfinished = assistant(); delete unfinished.info.finish;
    const broken = await harness([unfinished]);
    await expect(broken.run()).rejects.toMatchObject({ code: "OPENCODE_INCOMPLETE" });
    const responses = [assistant(), assistant(), assistant(completeCheckpoint())].map(message => ({ ...message,
      info: { ...message.info, providerID: "other-provider", modelID: "other-model" } }));
    const normal = await harness(responses);
    await normal.run();
    expect(normal.prompt.mock.calls[2]?.[1]).toBe("reviewx_output");
  });
  test("cancels an active request, closes its connection, and shares one overall timeout", async () => {
    const fixture = await preparedFixture(); cleanups.push(fixture.prepared.cleanup);
    const close = vi.fn(async () => undefined);
    const connect: OpenCodeConnectionFactory = async (_prepared, _env, signal) => ({ sessionID: "ses_test", version: "test", close,
      prompt: async () => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); if (signal.aborted) reject(signal.reason); }),
    });
    const reviewer = new OpenCodeReviewer({ NODE_ENV: "test" }, { connect, timeoutMs: 25 });
    await expect(reviewer.review("101", fixture.details, fixture.prepared, new AbortController().signal)).rejects.toMatchObject({ code: "OPENCODE_TIMEOUT" });
    expect(close).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const run = new OpenCodeReviewer({ NODE_ENV: "test" }, { connect }).review("101", fixture.details, fixture.prepared, controller.signal);
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: "OPENCODE_CANCELLED" });
  });
  test("requires valid scores and contained changed-code evidence", async () => {
    const fixture = await preparedFixture(); cleanups.push(fixture.prepared.cleanup);
    for (const confidence of [-1, 101, 90.5, "95", undefined, NaN]) {
      expect(() => parseReviewCheckpoint(completeCheckpoint([{ ...finding, confidence } as typeof finding]), fixture.prepared)).toThrow();
    }
    for (const evidence of [
      [], [{ ...finding.evidence[0], path: "../secret" }], [{ ...finding.evidence[0], endLine: 4 }],
      [{ ...finding.evidence[0], startLine: 1, endLine: 1 }], [{ ...finding.evidence[0], path: "absent.ts" }],
    ]) expect(() => parseReviewCheckpoint(completeCheckpoint([{ ...finding, evidence }]), fixture.prepared)).toThrow();
    expect(parseReviewCheckpoint(completeCheckpoint(), fixture.prepared).findings[0].body).toBe(finding.body);
  });
  test("keeps provider auth, removes repository auth and only enables required tools", () => {
    const env = reviewEnvironment({ NODE_ENV: "test", CODEHUB_TOKEN: "private-codehub", GH_TOKEN: "private-gh", SSH_AUTH_SOCK: "sock", DEEPSEEK_API_KEY: "provider-auth" });
    expect(env.CODEHUB_TOKEN).toBeUndefined(); expect(env.GH_TOKEN).toBeUndefined(); expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBe("provider-auth");
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(config.agent.reviewx.steps).toBe(20);
    expect(config.agent.reviewx.permission).toEqual({ "*": "deny", read: "allow", glob: "allow", grep: "allow", external_directory: "deny" });
    expect(config.agent.reviewx_output_deepseek.permission).toEqual({ "*": "deny", StructuredOutput: "allow" });
    expect(config.agent.reviewx_output_deepseek.thinking).toEqual({ type: "disabled" });
    expect(config.agent.reviewx.thinking).toBeUndefined();
  });
});
