import { access, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkflowHarness,
  finalComment,
  finding,
  type WorkflowHarness,
} from "../helpers/harness.js";

const active: WorkflowHarness[] = [];

async function harness(result: Parameters<typeof createWorkflowHarness>[0]) {
  const value = await createWorkflowHarness(result);
  active.push(value);
  return value;
}

async function missing(target: string) {
  try {
    await access(target);
    return false;
  } catch {
    return true;
  }
}

afterEach(async () => {
  await Promise.all(active.splice(0).map((item) => item.cleanup()));
});

describe("full review workflow with real Git", () => {
  it("processes the final multi-commit worktree once and persists pass", async () => {
    const value = await harness({ verdict: "pass" });
    await value.workflow.scanOnce();
    const state = await value.state.read();
    expect(state.repositories["1"]!.merge_requests["7"]).toEqual({
      last_processed_updated_at: "2026-08-12T00:00:00Z",
      finding_history: [],
    });
    expect(value.agents.agents).toEqual([
      "design-reviewer",
      "business-reviewer",
      "code-reviewer",
      "review-judge",
    ]);
    expect((value.agents.inputs[0] as { commits: unknown[] }).commits).toHaveLength(2);
    expect(value.git.calls.some((call) => call.includes("diff"))).toBe(false);
    expect(await missing(value.paths.worktrees)).toBe(false);
    expect(await missing(`${value.paths.worktrees}/1/7`)).toBe(true);
    expect(await missing(`${value.paths.runs}/${(JSON.parse(value.logs[1]!) as { run_id: string }).run_id}`)).toBe(true);

    await value.workflow.scanOnce();
    expect(value.agents.agents).toHaveLength(4);
    expect(value.codeHub.comments).toHaveLength(0);
  });

  it("extracts prose-wrapped fenced JSON from every expert and the judge", async () => {
    const value = await harness({ verdict: "pass" });
    value.agents.fencedOutput = true;

    await value.workflow.scanOnce();

    expect(value.agents.agents).toEqual([
      "design-reviewer",
      "business-reviewer",
      "code-reviewer",
      "review-judge",
    ]);
    expect(
      value.logs.map((line) => JSON.parse(line)).find((record) => record.event === "review_run_finished"),
    ).toMatchObject({ result: "pass" });
    expect(
      value.logs.map((line) => JSON.parse(line)).find((record) => record.event === "review_run_finished"),
    ).not.toHaveProperty("agent_output");
  });

  it("persists artifacts while removing analysis fences before every terminal result", async () => {
    const value = await harness({ verdict: "pass" });
    value.agents.pollutedOutput = true;

    await value.workflow.scanOnce();

    const records = value.logs.map((line) => JSON.parse(line));
    const runId = records.find((record) => record.event === "review_run_started").run_id as string;
    expect(records.find((record) => record.event === "review_run_finished")).toMatchObject({
      result: "pass",
    });
    const artifactNames = [
      "01-design-reviewer",
      "02-business-reviewer",
      "03-code-reviewer",
      "04-review-judge",
    ];
    for (const name of artifactNames) {
      const directory = `${value.paths.agentOutputs}/${runId}/${name}`;
      const metadata = JSON.parse(await readFile(`${directory}/metadata.json`, "utf8"));
      expect(metadata).toMatchObject({
        status: "succeeded",
        strategy: "trailing_raw",
        parse_status: "succeeded",
        schema_status: "succeeded",
      });
      expect(await readFile(`${directory}/assistant.txt`, "utf8")).toContain("```diff");
      expect(JSON.parse(await readFile(`${directory}/processed.txt`, "utf8"))).toBeTruthy();
      expect(JSON.parse(await readFile(`${directory}/result.json`, "utf8"))).toBeTruthy();
    }
    expect(await missing(`${value.paths.runs}/${runId}`)).toBe(true);
    expect(await missing(`${value.paths.agentOutputs}/${runId}`)).toBe(false);
  });

  it("publishes one new comment, refreshes the cursor, and prevents its own loop", async () => {
    const value = await harness({
      verdict: "new",
      selected_finding: finding,
      comment_markdown: finalComment(),
    });
    process.env.CODEHUB_TEST_TOKEN = "must-not-leak";
    try {
      await value.workflow.scanOnce();
    } finally {
      delete process.env.CODEHUB_TEST_TOKEN;
    }
    expect(value.codeHub.comments).toEqual([{ body: finalComment(), severity: "major" }]);
    const mrState = (await value.state.read()).repositories["1"]!.merge_requests["7"]!;
    expect(mrState.last_processed_updated_at).toBe("2026-08-12T00:01:00Z");
    expect(mrState.finding_history).toEqual([
      {
        summary: {
          title: finding.title,
          file: finding.file,
          problem: finding.problem,
        },
        publication_status: "confirmed",
        comment_id: "comment-1",
      },
    ]);
    expect(value.agents.environments.every((env) => env.CODEHUB_TEST_TOKEN === undefined)).toBe(true);
    const config = JSON.parse(value.agents.environments[0]!.OPENCODE_CONFIG_CONTENT!);
    expect(config.permission["*"]).toBe("deny");
    expect(config.permission.bash["git diff *"]).toBe("allow");

    value.codeHub.listUpdatedAt = "2026-08-12T00:01:00Z";
    await value.workflow.scanOnce();
    expect(value.codeHub.comments).toHaveLength(1);
    expect(value.agents.agents).toHaveLength(4);
  });

  it("persists duplicate_of without publishing", async () => {
    const value = await harness({ verdict: "duplicate_of", duplicate_comment_id: "old-comment" });
    await value.workflow.scanOnce();
    expect(value.codeHub.comments).toHaveLength(0);
    expect((await value.state.read()).repositories["1"]!.merge_requests["7"])
      .toMatchObject({ last_processed_updated_at: "2026-08-12T00:00:00Z" });
    const terminal = value.logs.map((line) => JSON.parse(line)).find((x) => x.event === "review_run_finished");
    expect(terminal).toMatchObject({
      result: "duplicate_of",
      duplicate_of_comment_id: "old-comment",
    });
  });

  it.each([
    ["closed", "closed", "2026-08-12T00:00:00Z"],
    ["updated", "opened", "2026-08-12T00:00:30Z"],
  ] as const)("does not publish when the MR is %s", async (result, state, updatedAt) => {
    const value = await harness({
      verdict: "new",
      selected_finding: finding,
      comment_markdown: finalComment(),
    });
    value.codeHub.prePublishState = state;
    value.codeHub.prePublishUpdatedAt = updatedAt;
    await value.workflow.scanOnce();
    expect(value.codeHub.comments).toHaveLength(0);
    expect((await value.state.read()).repositories["1"]!.merge_requests["7"]).toBeUndefined();
    const terminal = value.logs.map((line) => JSON.parse(line)).find((x) => x.event === "review_run_finished");
    expect(terminal.result).toBe(result);
  });

  it.each(["unknown", "missing_id"] as const)(
    "records %s publication history and treats the update as processed",
    async (publication) => {
      const value = await harness({
        verdict: "new",
        selected_finding: finding,
        comment_markdown: finalComment(),
      });
      value.codeHub.publication = publication;
      await value.workflow.scanOnce();
      const mrState = (await value.state.read()).repositories["1"]!.merge_requests["7"]!;
      expect(mrState.last_processed_updated_at).toBe("2026-08-12T00:01:00Z");
      expect(mrState.finding_history[0]).toMatchObject({
        publication_status: "unknown",
        comment_id: null,
      });
      const terminal = value.logs
        .map((line) => JSON.parse(line))
        .find((x) => x.event === "review_run_finished");
      expect(terminal).toMatchObject({ result: "publication_unknown", comment_id: null });
      value.codeHub.listUpdatedAt = "2026-08-12T00:01:00Z";
      await value.workflow.scanOnce();
      expect(value.codeHub.comments).toHaveLength(1);
      expect(value.agents.agents).toHaveLength(4);
    },
  );

  it("leaves the cursor untouched on agent failure and retries from the beginning", async () => {
    const value = await harness({ verdict: "pass" });
    value.agents.invalidExpert = "business-reviewer";
    await value.workflow.scanOnce();
    expect((await value.state.read()).repositories["1"]!.merge_requests["7"]).toBeUndefined();
    expect(value.agents.agents).toEqual(["design-reviewer", "business-reviewer"]);
    expect(
      value.logs.map((line) => JSON.parse(line)).find((record) =>
        record.event === "review_run_finished" && record.result === "failed"
      ),
    ).toMatchObject({
      agent: "business-reviewer",
      agent_output: "not-json\n",
      agent_output_source: "opencode_stdout",
      agent_output_chars: 9,
      agent_output_truncated: false,
      agent_output_artifact: expect.stringContaining("02-business-reviewer"),
    });
    value.agents.invalidExpert = undefined;
    await value.workflow.scanOnce();
    expect(value.agents.agents.slice(2)).toEqual([
      "design-reviewer",
      "business-reviewer",
      "code-reviewer",
      "review-judge",
    ]);
    expect((await value.state.read()).repositories["1"]!.merge_requests["7"])
      .toMatchObject({ last_processed_updated_at: "2026-08-12T00:00:00Z" });
    expect((await readFile(value.paths.log, "utf8")).trim().split(/\r?\n/u).length).toBe(
      value.logs.length,
    );
  });

  it("isolates repository scan failures and continues the scan lifecycle", async () => {
    const value = await harness({ verdict: "pass" });
    value.codeHub.listFailure = true;
    await value.workflow.scanOnce();
    expect(value.agents.agents).toEqual([]);
    expect(value.logs.map((line) => JSON.parse(line).event)).toEqual([
      "scan_started",
      "repository_scan_failed",
      "scan_finished",
    ]);
  });

  it("ignores non-open list results and honors a pre-aborted scan", async () => {
    const value = await harness({ verdict: "pass" });
    value.codeHub.listState = "closed";
    await value.workflow.scanOnce();
    expect(value.agents.agents).toEqual([]);

    const controller = new AbortController();
    controller.abort();
    const callCount = value.codeHub.calls.length;
    await value.workflow.scanOnce(controller.signal);
    expect(value.codeHub.calls).toHaveLength(callCount);
  });

  it("does not advance the cursor when comment publication fails", async () => {
    const value = await harness({
      verdict: "new",
      selected_finding: finding,
      comment_markdown: finalComment(),
    });
    value.codeHub.publication = "failure";
    await value.workflow.scanOnce();
    expect((await value.state.read()).repositories["1"]!.merge_requests["7"]).toBeUndefined();
    const terminal = value.logs.map((line) => JSON.parse(line)).find((x) => x.event === "review_run_finished");
    expect(terminal).toMatchObject({ result: "failed" });
  });

  it("uses the review start timestamp when unknown publication cannot refresh", async () => {
    const value = await harness({
      verdict: "new",
      selected_finding: finding,
      comment_markdown: finalComment(),
    });
    value.codeHub.publication = "unknown";
    value.codeHub.refreshFailure = true;
    await value.workflow.scanOnce();
    const mrState = (await value.state.read()).repositories["1"]!.merge_requests["7"]!;
    expect(mrState.last_processed_updated_at).toBe("2026-08-12T00:00:00Z");
    expect(mrState.finding_history[0]).toMatchObject({ publication_status: "unknown" });
  });

  it("fails a new result whose Markdown does not match the finding", async () => {
    const value = await harness({
      verdict: "new",
      selected_finding: finding,
      comment_markdown: "not a valid review comment",
    });
    await value.workflow.scanOnce();
    expect(value.codeHub.comments).toEqual([]);
    expect(value.codeHub.viewCalls).toBe(0);
    const terminal = value.logs.map((line) => JSON.parse(line)).find((x) => x.event === "review_run_finished");
    expect(terminal).toMatchObject({ result: "failed" });
  });
});
