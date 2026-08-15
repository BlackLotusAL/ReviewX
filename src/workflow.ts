import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  expertInputSchema,
  judgeInputSchema,
  severityToCodeHub,
  type ExpertName,
  type FindingHistory,
  type JudgeResult,
  type LogRecord,
  type MergeRequest,
  type ReviewResult,
} from "./contracts.js";
import { CodeHubClient, CodeHubCommandError } from "./codehub.js";
import { validateCommentMarkdown } from "./comment.js";
import { errorMessage, ReviewXError } from "./errors.js";
import { GitManager } from "./git.js";
import { JsonlLogger } from "./logger.js";
import { OpenCodeClient } from "./opencode.js";
import { assertPathWithin, type RuntimePaths } from "./runtime.js";
import { StateStore } from "./state.js";

const experts: ExpertName[] = ["design-reviewer", "business-reviewer", "code-reviewer"];

type TerminalRecord = Pick<
  LogRecord,
  | "result"
  | "error"
  | "agent"
  | "agent_output"
  | "agent_output_source"
  | "agent_output_chars"
  | "agent_output_truncated"
  | "duplicate_of_comment_id"
  | "comment_id"
>;

type AgentDiagnosticRecord = Pick<
  LogRecord,
  | "agent"
  | "agent_output"
  | "agent_output_source"
  | "agent_output_chars"
  | "agent_output_truncated"
>;

function agentDiagnosticRecord(error: unknown): Partial<AgentDiagnosticRecord> {
  if (!(error instanceof ReviewXError) || error.code !== "AGENT_ERROR" || !error.details) {
    return {};
  }
  const details = error.details;
  const agent = details.agent;
  const output = details.agent_output;
  const source = details.agent_output_source;
  const characters = details.agent_output_chars;
  const truncated = details.agent_output_truncated;
  if (
    (agent !== "design-reviewer" &&
      agent !== "business-reviewer" &&
      agent !== "code-reviewer" &&
      agent !== "review-judge") ||
    typeof output !== "string" ||
    (source !== "assistant_text" && source !== "opencode_stdout") ||
    typeof characters !== "number" ||
    typeof truncated !== "boolean"
  ) {
    return {};
  }
  return {
    agent,
    agent_output: output,
    agent_output_source: source,
    agent_output_chars: characters,
    agent_output_truncated: truncated,
  };
}

function historyFromJudge(
  judge: Extract<JudgeResult, { verdict: "new" }>,
  publicationStatus: "confirmed" | "unknown",
  commentId: string | null,
): FindingHistory {
  return {
    summary: {
      title: judge.selected_finding.title,
      file: judge.selected_finding.file,
      problem: judge.selected_finding.problem,
    },
    publication_status: publicationStatus,
    comment_id: commentId,
  };
}

export class ReviewWorkflow {
  constructor(
    private readonly paths: RuntimePaths,
    private readonly state: StateStore,
    private readonly logger: JsonlLogger,
    private readonly codeHub: CodeHubClient,
    private readonly git: GitManager,
    private readonly openCode: OpenCodeClient,
    private readonly agentTimeoutMs: number,
  ) {}

  async scanOnce(signal?: AbortSignal): Promise<void> {
    await this.logger.write({ level: "info", event: "scan_started" });
    const snapshot = await this.state.read();
    for (const repoId of Object.keys(snapshot.repositories)) {
      if (signal?.aborted) break;
      let mergeRequests: MergeRequest[];
      try {
        mergeRequests = await this.codeHub.mrList(repoId, signal);
      } catch (error) {
        await this.logger.write({
          level: "error",
          event: "repository_scan_failed",
          repo_id: repoId,
          error: errorMessage(error),
        });
        continue;
      }
      for (const mr of mergeRequests) {
        if (signal?.aborted) break;
        if (mr.state !== "opened") continue;
        const latest = await this.state.read();
        const cursor = latest.repositories[repoId]?.merge_requests[mr.iid]
          ?.last_processed_updated_at;
        if (cursor === mr.updated_at) continue;
        await this.review(repoId, mr, signal);
      }
    }
    await this.logger.write({ level: "info", event: "scan_finished" });
  }

  private async saveCursor(repoId: string, mrIid: string, updatedAt: string): Promise<void> {
    await this.state.updateMergeRequest(repoId, mrIid, (current) => ({
      ...current,
      last_processed_updated_at: updatedAt,
    }));
  }

  private async appendHistory(
    repoId: string,
    mrIid: string,
    history: FindingHistory,
    updatedAt?: string,
  ): Promise<void> {
    await this.state.updateMergeRequest(repoId, mrIid, (current) => ({
      ...current,
      ...(updatedAt === undefined ? {} : { last_processed_updated_at: updatedAt }),
      finding_history: [...current.finding_history, history],
    }));
  }

  private async applyJudge(
    repoId: string,
    mr: MergeRequest,
    judge: JudgeResult,
    signal?: AbortSignal,
  ): Promise<TerminalRecord> {
    if (judge.verdict === "pass") {
      await this.saveCursor(repoId, mr.iid, mr.updated_at);
      return { result: "pass" };
    }
    if (judge.verdict === "duplicate_of") {
      await this.saveCursor(repoId, mr.iid, mr.updated_at);
      return {
        result: "duplicate_of",
        duplicate_of_comment_id: judge.duplicate_comment_id,
      };
    }

    validateCommentMarkdown(judge.comment_markdown, judge.selected_finding);
    const latest = await this.codeHub.mrView(repoId, mr.iid, signal);
    if (latest.state !== "opened") return { result: "closed" };
    if (latest.updated_at !== mr.updated_at) return { result: "updated" };

    try {
      const published = await this.codeHub.createComment(
        repoId,
        mr.iid,
        judge.comment_markdown,
        severityToCodeHub[judge.selected_finding.severity],
        signal,
      );
      await this.appendHistory(
        repoId,
        mr.iid,
        historyFromJudge(judge, "confirmed", published.comment_id),
      );
      const refreshed = await this.codeHub.mrView(repoId, mr.iid, signal);
      await this.saveCursor(repoId, mr.iid, refreshed.updated_at);
      return { result: "new", comment_id: published.comment_id };
    } catch (error) {
      if (!(error instanceof CodeHubCommandError) || error.externalCode !== "WRITE_RESULT_UNKNOWN") {
        throw error;
      }
      let updatedAt = mr.updated_at;
      try {
        const refreshed = await this.codeHub.mrView(repoId, mr.iid, signal);
        updatedAt = refreshed.updated_at;
      } catch {
        // The documented fallback is the review's starting updated_at.
      }
      await this.appendHistory(
        repoId,
        mr.iid,
        historyFromJudge(judge, "unknown", null),
        updatedAt,
      );
      return { result: "publication_unknown", comment_id: null };
    }
  }

  private async review(repoId: string, mr: MergeRequest, signal?: AbortSignal): Promise<void> {
    const runId = randomUUID();
    const runDir = path.join(this.paths.runs, runId);
    assertPathWithin(this.paths.runs, runDir);
    let terminal: TerminalRecord | undefined;
    let cleanupError: string | undefined;
    await this.logger.write({
      level: "info",
      event: "review_run_started",
      run_id: runId,
      repo_id: repoId,
      mr_iid: mr.iid,
      updated_at: mr.updated_at,
    });

    try {
      await mkdir(runDir, { recursive: true });
      const repository = (await this.git.hasCache(repoId))
        ? undefined
        : await this.codeHub.repoView(repoId, signal);
      const worktreePath = await this.git.prepare(repoId, mr, repository, signal);
      const commits = await this.codeHub.mrCommits(repoId, mr.iid, signal);
      const expertInput = expertInputSchema.parse({
        repo_id: repoId,
        mr_iid: mr.iid,
        merge_request: mr,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        worktree_path: worktreePath,
        commits,
      });
      const expertInputPath = path.join(runDir, "expert-input.json");
      await writeFile(expertInputPath, `${JSON.stringify(expertInput, null, 2)}\n`, "utf8");

      const expertResults = [];
      for (const expert of experts) {
        expertResults.push(
          await this.openCode.runExpert(
            expert,
            worktreePath,
            expertInputPath,
            this.agentTimeoutMs,
            signal,
          ),
        );
      }
      const latestState = await this.state.read();
      const findingHistory =
        latestState.repositories[repoId]?.merge_requests[mr.iid]?.finding_history ?? [];
      const judgeInput = judgeInputSchema.parse({
        ...expertInput,
        expert_results: expertResults,
        finding_history: findingHistory,
      });
      const judgeInputPath = path.join(runDir, "judge-input.json");
      await writeFile(judgeInputPath, `${JSON.stringify(judgeInput, null, 2)}\n`, "utf8");
      const judge = await this.openCode.runJudge(
        worktreePath,
        judgeInputPath,
        this.agentTimeoutMs,
        signal,
      );
      terminal = await this.applyJudge(repoId, mr, judge, signal);
    } catch (error) {
      terminal = {
        result: "failed",
        error: errorMessage(error),
        ...agentDiagnosticRecord(error),
      };
    } finally {
      try {
        await this.git.cleanup(repoId, mr.iid);
      } catch (error) {
        cleanupError = errorMessage(error);
      }
      try {
        assertPathWithin(this.paths.runs, runDir);
        await rm(runDir, { recursive: true, force: true });
      } catch (error) {
        cleanupError = cleanupError ?? errorMessage(error);
      }
    }

    if (cleanupError) {
      await this.logger.write({
        level: "error",
        event: "runtime_error",
        run_id: runId,
        repo_id: repoId,
        mr_iid: mr.iid,
        error: cleanupError,
      });
    }
    const finalRecord = terminal ?? ({ result: "failed", error: "Review did not complete." } as const);
    await this.logger.write({
      level: finalRecord.result === "failed" ? "error" : "info",
      event: "review_run_finished",
      run_id: runId,
      repo_id: repoId,
      mr_iid: mr.iid,
      updated_at: mr.updated_at,
      ...finalRecord,
    });
  }
}
