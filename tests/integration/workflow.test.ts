import { access, readFile, readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkflowHarness,
  finalComment,
  type WorkflowHarness,
} from "../helpers/harness.js";

const active: WorkflowHarness[] = [];

async function harness(
  decision: Parameters<typeof createWorkflowHarness>[0],
  markdown?: string,
) {
  const value = await createWorkflowHarness(decision, markdown);
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

function eventName(line: string): string {
  const match = /^\[[^\]]+\] \[[A-Z]+\] \[([a-z_]+)\]/u.exec(line);
  if (!match?.[1]) throw new Error(`Invalid log line: ${line}`);
  return match[1];
}

function findLog(logs: string[], event: string): string {
  const line = logs.find((candidate) => eventName(candidate) === event);
  if (!line) throw new Error(`Missing ${event} log.`);
  return line;
}

afterEach(async () => {
  await Promise.all(active.splice(0).map((item) => item.cleanup()));
});

describe("full Markdown review workflow with real Git", () => {
  it("passes three expert Markdown reports to the Judge and persists replayable artifacts", async () => {
    const value = await harness({ verdict: "PASS" });
    await value.workflow.scanOnce();

    expect((await value.state.read()).repositories["1"]!.merge_requests["7"]).toEqual({
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
    expect(value.agents.judgeInputFiles[0]).toHaveLength(4);
    expect(value.agents.judgeInputContents[0]!.slice(1)).toEqual([
      value.agents.expertMarkdown,
      value.agents.expertMarkdown,
      value.agents.expertMarkdown,
    ]);

    const [runId] = await readdir(value.paths.agentOutputs);
    expect(runId).toBeDefined();
    for (const name of ["01-design-reviewer", "02-business-reviewer", "03-code-reviewer"]) {
      const directory = `${value.paths.agentOutputs}/${runId}/${name}`;
      expect(await readFile(`${directory}/report.md`, "utf8")).toBe(value.agents.expertMarkdown);
      expect(JSON.parse(await readFile(`${directory}/input-manifest.json`, "utf8")).files)
        .toHaveLength(1);
    }
    const judgeDirectory = `${value.paths.agentOutputs}/${runId}/04-review-judge`;
    expect(JSON.parse(await readFile(`${judgeDirectory}/decision.json`, "utf8"))).toEqual({
      verdict: "PASS",
    });
    expect(await readFile(`${judgeDirectory}/report.md`, "utf8"))
      .toBe('<!-- reviewx-decision: {"verdict":"PASS"} -->');
    expect(JSON.parse(await readFile(`${judgeDirectory}/input-manifest.json`, "utf8")).files)
      .toHaveLength(4);
    expect(await missing(`${judgeDirectory}/attempt-1/assistant.txt`)).toBe(false);
    expect(await missing(`${value.paths.runs}/${runId}`)).toBe(true);
    expect(await missing(`${value.paths.worktrees}/1/7`)).toBe(true);
    expect(value.git.calls.some((call) => call.includes("diff"))).toBe(false);
  });

  it("preserves arbitrary expert Markdown without JSON extraction or repair", async () => {
    const value = await harness({ verdict: "PASS" });
    value.agents.expertMarkdown = `# Review notes

Prose with { "json": true } and code:

\`\`\`diff
-old
+new
\`\`\``;
    await value.workflow.scanOnce();

    const [runId] = await readdir(value.paths.agentOutputs);
    expect(await readFile(
      `${value.paths.agentOutputs}/${runId}/02-business-reviewer/report.md`,
      "utf8",
    )).toBe(value.agents.expertMarkdown);
    expect(findLog(value.logs, "review_run_finished")).toContain("result pass");
  });

  it("streams safe progress for every Agent and persists progress summaries", async () => {
    const value = await harness({ verdict: "PASS" });
    value.agents.failedToolAgent = "design-reviewer";
    await value.workflow.scanOnce();

    const progressEvents = value.logs.map(eventName).filter((event) =>
      event.startsWith("agent_") && !["agent_started", "agent_finished"].includes(event)
    );
    expect(progressEvents.filter((event) => event === "agent_process_ready")).toHaveLength(4);
    expect(progressEvents.filter((event) => event === "agent_tool_finished")).toHaveLength(4);
    expect(progressEvents.filter((event) => event === "agent_step_finished")).toHaveLength(8);
    expect(progressEvents.filter((event) => event === "agent_progress_summary")).toHaveLength(4);

    const designStarted = value.logs.findIndex((line) =>
      eventName(line) === "agent_started" && line.includes("design-reviewer")
    );
    const designTool = value.logs.findIndex((line) =>
      eventName(line) === "agent_tool_finished" && line.includes("design-reviewer")
    );
    const designFinished = value.logs.findIndex((line) =>
      eventName(line) === "agent_finished" && line.includes("design-reviewer")
    );
    expect(designStarted).toBeLessThan(designTool);
    expect(designTool).toBeLessThan(designFinished);
    expect(value.logs[designTool]).toContain("path=service.ts");
    expect(value.logs[designTool]).toContain("[WARN]");
    expect(value.logs[designTool]).toContain("status failed");
    expect(findLog(value.logs, "agent_step_finished")).toContain("model-to-action 25ms");
    expect(value.logs.some((line) =>
      eventName(line) === "agent_process_ready" &&
      line.includes("review-judge, attempt 1, step 0")
    )).toBe(true);

    const combinedLogs = value.logs.join("");
    expect(combinedLogs).not.toContain("TOOL_OUTPUT_MUST_NOT_REACH_LOGS");
    expect(combinedLogs).not.toContain("tool-secret");
    expect(combinedLogs).not.toContain(value.agents.expertMarkdown);
    expect(await readFile(value.paths.log, "utf8")).toBe(combinedLogs);

    const [runId] = await readdir(value.paths.agentOutputs);
    expect(JSON.parse(await readFile(
      `${value.paths.agentOutputs}/${runId}/01-design-reviewer/metadata.json`,
      "utf8",
    )).progress).toMatchObject({
      steps: 2,
      tool_calls: 1,
      step_duration_ms: 150,
      tool_duration_ms: 15,
      input_tokens: 150,
      output_tokens: 30,
      cache_read_tokens: 75,
    });
    expect(JSON.parse(await readFile(
      `${value.paths.agentOutputs}/${runId}/04-review-judge/attempt-1/metadata.json`,
      "utf8",
    )).progress).toMatchObject({ steps: 2, tool_calls: 1 });
  });

  it("retries an invalid Judge control header once and retains both attempts", async () => {
    const value = await harness({ verdict: "PASS" });
    value.agents.invalidJudgeAttempts = 1;
    await value.workflow.scanOnce();

    expect(value.agents.agents.slice(-2)).toEqual(["review-judge", "review-judge"]);
    const [runId] = await readdir(value.paths.agentOutputs);
    const directory = `${value.paths.agentOutputs}/${runId}/04-review-judge`;
    expect(await readFile(`${directory}/attempt-1/decision-error.txt`, "utf8"))
      .toContain("reviewx-decision");
    expect(await missing(`${directory}/attempt-2/assistant.txt`)).toBe(false);
    expect(JSON.parse(await readFile(`${directory}/metadata.json`, "utf8"))).toMatchObject({
      status: "succeeded",
      attempts: 2,
      decision_status: "succeeded",
      verdict: "PASS",
    });
    expect(value.logs.some((line) =>
      eventName(line) === "agent_process_ready" && line.includes("attempt 1")
    )).toBe(true);
    expect(value.logs.some((line) =>
      eventName(line) === "agent_process_ready" && line.includes("attempt 2")
    )).toBe(true);
  });

  it("fails after exactly one Judge retry and leaves the cursor untouched", async () => {
    const value = await harness({ verdict: "PASS" });
    value.agents.invalidJudgeAttempts = 2;
    await value.workflow.scanOnce();

    expect(value.agents.agents.filter((agent) => agent === "review-judge")).toHaveLength(2);
    expect((await value.state.read()).repositories["1"]!.merge_requests["7"]).toBeUndefined();
    expect(findLog(value.logs, "agent_failed")).toContain("invalid decision document");
    expect(findLog(value.logs, "review_run_finished")).toContain("result failed");
  });

  it("extracts and publishes validated Judge Markdown while retaining raw narration", async () => {
    const markdown = finalComment();
    const rawMarkdown = markdown
      .replace("- 严重级别：Major", "- **严重级别**：major")
      .replace("- 标签：`#correctness` `#transaction`", "* **标签**: #correctness, #transaction")
      .replace("- 简述：事务提交前", "**简述**: 事务提交前")
      .replace("- 增加事务回滚时不发送事件的测试", "* 增加事务回滚时不发送事件的测试");
    const value = await harness({ verdict: "NEW", severity: "major" }, rawMarkdown);
    value.agents.judgePrefix = [
      "```html",
      '<!-- reviewx-decision: {"verdict":"PASS"} -->',
      "```",
      "",
      "I've verified the finding. The control-header decision is NEW with major severity.",
      "",
    ].join("\n");
    value.agents.judgeSuffix = "\n\nI need to fix a typo. Let me re-output the final answer cleanly.";
    process.env.CODEHUB_TEST_TOKEN = "must-not-leak";
    try {
      await value.workflow.scanOnce();
    } finally {
      delete process.env.CODEHUB_TEST_TOKEN;
    }

    expect(value.codeHub.comments).toEqual([{ body: markdown, severity: "major" }]);
    const mrState = (await value.state.read()).repositories["1"]!.merge_requests["7"]!;
    expect(mrState.last_processed_updated_at).toBe("2026-08-12T00:01:00Z");
    expect(mrState.finding_history).toEqual([
      {
        review_markdown: markdown,
        publication_status: "confirmed",
        comment_id: "comment-1",
      },
    ]);
    expect(value.agents.environments.every((env) => env.CODEHUB_TEST_TOKEN === undefined)).toBe(true);
    expect(value.logs.join("")).not.toContain("must-not-leak");
    expect(value.logs.join("")).not.toContain(markdown);
    const [runId] = await readdir(value.paths.agentOutputs);
    expect(await readFile(`${value.paths.agentOutputs}/${runId}/review.md`, "utf8")).toBe(markdown);
    const judgeDirectory = `${value.paths.agentOutputs}/${runId}/04-review-judge`;
    expect(await readFile(`${judgeDirectory}/attempt-1/report.md`, "utf8")).toBe(
      `${value.agents.judgePrefix}<!-- reviewx-decision: {"verdict":"NEW","severity":"major"} -->\n\n${rawMarkdown}${value.agents.judgeSuffix}`,
    );
    expect(await readFile(`${judgeDirectory}/report.md`, "utf8")).toBe(
      `<!-- reviewx-decision: {"verdict":"NEW","severity":"major"} -->\n\n${markdown}`,
    );
    expect(value.agents.agents.filter((agent) => agent === "review-judge")).toHaveLength(1);
  });

  it("persists duplicate_of without publishing", async () => {
    const value = await harness({
      verdict: "DUPLICATE",
      duplicate_comment_id: "old-comment",
    });
    await value.workflow.scanOnce();
    expect(value.codeHub.comments).toHaveLength(0);
    expect((await value.state.read()).repositories["1"]!.merge_requests["7"])
      .toMatchObject({ last_processed_updated_at: "2026-08-12T00:00:00Z" });
    expect(findLog(value.logs, "review_run_finished")).toContain("duplicate comment old-comment");
    const [runId] = await readdir(value.paths.agentOutputs);
    expect(await readFile(
      `${value.paths.agentOutputs}/${runId}/04-review-judge/report.md`,
      "utf8",
    )).toBe(
      '<!-- reviewx-decision: {"verdict":"DUPLICATE","duplicate_comment_id":"old-comment"} -->',
    );
  });

  it("passes legacy history to the Judge without rewriting state", async () => {
    const value = await harness({ verdict: "PASS" });
    await value.state.updateMergeRequest("1", "7", (current) => ({
      ...current,
      finding_history: [
        {
          summary: { title: "Legacy", file: "service.ts", problem: "Legacy problem" },
          publication_status: "confirmed",
          comment_id: "legacy-comment",
        },
      ],
    }));
    await value.workflow.scanOnce();

    const judgeContext = JSON.parse(value.agents.judgeInputContents[0]![0]!);
    expect(judgeContext.finding_history[0]).toMatchObject({
      summary: { title: "Legacy" },
      comment_id: "legacy-comment",
    });
    expect((await value.state.read()).repositories["1"]!.merge_requests["7"]!.finding_history[0])
      .toHaveProperty("summary");
  });

  it.each([
    ["closed", "closed", "2026-08-12T00:00:00Z"],
    ["updated", "opened", "2026-08-12T00:00:30Z"],
  ] as const)("does not publish when the MR is %s", async (result, state, updatedAt) => {
    const value = await harness({ verdict: "NEW", severity: "major" }, finalComment());
    value.codeHub.prePublishState = state;
    value.codeHub.prePublishUpdatedAt = updatedAt;
    await value.workflow.scanOnce();
    expect(value.codeHub.comments).toHaveLength(0);
    expect((await value.state.read()).repositories["1"]!.merge_requests["7"]).toBeUndefined();
    expect(findLog(value.logs, "review_run_finished")).toContain(`result ${result}`);
    const [runId] = await readdir(value.paths.agentOutputs);
    expect(await readFile(`${value.paths.agentOutputs}/${runId}/review.md`, "utf8"))
      .toBe(finalComment());
  });

  it.each(["unknown", "missing_id"] as const)(
    "records %s publication history and treats the update as processed",
    async (publication) => {
      const value = await harness({ verdict: "NEW", severity: "major" }, finalComment());
      value.codeHub.publication = publication;
      await value.workflow.scanOnce();
      const mrState = (await value.state.read()).repositories["1"]!.merge_requests["7"]!;
      expect(mrState.finding_history[0]).toMatchObject({
        review_markdown: finalComment(),
        publication_status: "unknown",
        comment_id: null,
      });
      expect(findLog(value.logs, "review_run_finished")).toContain("result publication_unknown");
    },
  );

  it("leaves the cursor untouched on expert failure and retries from the beginning", async () => {
    const value = await harness({ verdict: "PASS" });
    value.agents.invalidExpert = "business-reviewer";
    await value.workflow.scanOnce();
    expect((await value.state.read()).repositories["1"]!.merge_requests["7"]).toBeUndefined();
    expect(value.agents.agents).toEqual(["design-reviewer", "business-reviewer"]);
    expect(findLog(value.logs, "agent_failed")).not.toContain("not-json");

    value.agents.invalidExpert = undefined;
    await value.workflow.scanOnce();
    expect(value.agents.agents.slice(2)).toEqual([
      "design-reviewer",
      "business-reviewer",
      "code-reviewer",
      "review-judge",
    ]);
  });

  it("isolates repository failures and keeps cleanup failures non-terminal", async () => {
    const repositoryFailure = await harness({ verdict: "PASS" });
    repositoryFailure.codeHub.listFailure = true;
    await repositoryFailure.workflow.scanOnce();
    expect(repositoryFailure.agents.agents).toEqual([]);
    expect(findLog(repositoryFailure.logs, "repository_scan_failed")).toContain("[WARN]");

    const cleanupFailure = await harness({ verdict: "PASS" });
    cleanupFailure.git.cleanupFailure = true;
    await cleanupFailure.workflow.scanOnce();
    expect(findLog(cleanupFailure.logs, "cleanup_failed")).toContain("[WARN]");
    expect(findLog(cleanupFailure.logs, "review_run_finished")).toContain("result pass");
  });
});
