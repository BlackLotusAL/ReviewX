import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  expertInputSchema,
  judgeContextSchema,
  severityToCodeHub,
  type CommentResult,
  type Commit,
  type ExpertName,
  type ExpertReport,
  type FindingHistory,
  type JudgeReport,
  type MergeRequest,
  type ReviewResult,
} from "./contracts.js";
import { CodeHubClient, CodeHubCommandError } from "./codehub.js";
import { errorMessage } from "./errors.js";
import { GitManager } from "./git.js";
import { TextLogger, type AgentName, type LogLevel } from "./logger.js";
import { OpenCodeClient, type AgentRunProgress } from "./opencode.js";
import { assertPathWithin, type RuntimePaths } from "./runtime.js";
import { StateStore } from "./state.js";

const experts: ExpertName[] = ["design-reviewer", "business-reviewer", "code-reviewer"];

interface TerminalRecord {
  result: ReviewResult;
  error?: string;
  duplicate_of_comment_id?: string | null;
  comment_id?: string | null;
}

export interface ScanSummary {
  repositoryCount: number;
  pendingReviewCount: number;
  completedReviewCount: number;
  failureCount: number;
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function terminalLevel(result: ReviewResult): LogLevel {
  if (result === "failed") return "error";
  if (result === "publication_unknown" || result === "updated" || result === "closed") {
    return "warn";
  }
  return "info";
}

function hasNewerUpdate(cursor: string | undefined, updatedAt: string): boolean {
  if (cursor === undefined) return true;
  const cursorTime = Date.parse(cursor);
  const updatedTime = Date.parse(updatedAt);
  if (Number.isFinite(cursorTime) && Number.isFinite(updatedTime)) {
    return updatedTime > cursorTime;
  }
  return updatedAt !== cursor;
}

function isSameUpdate(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime === rightTime;
  }
  return left === right;
}

function historyFromMarkdown(
  reviewMarkdown: string,
  publicationStatus: "confirmed" | "unknown",
  commentId: string | null,
): FindingHistory {
  return {
    review_markdown: reviewMarkdown,
    publication_status: publicationStatus,
    comment_id: commentId,
  };
}

export class ReviewWorkflow {
  constructor(
    private readonly paths: RuntimePaths,
    private readonly state: StateStore,
    private readonly logger: TextLogger,
    private readonly codeHub: CodeHubClient,
    private readonly git: GitManager,
    private readonly openCode: OpenCodeClient,
    private readonly agentTimeoutMs: number,
  ) {}

  async scanOnce(signal?: AbortSignal): Promise<ScanSummary> {
    const scanStartedAt = Date.now();
    await this.logger.write({ level: "info", event: "scan_started" });
    const snapshot = await this.state.read();
    const repositoryIds = Object.keys(snapshot.repositories);
    let pendingReviewCount = 0;
    let completedReviewCount = 0;
    let failureCount = 0;

    for (const repoId of repositoryIds) {
      if (signal?.aborted) break;
      const repositoryStartedAt = Date.now();
      await this.logger.write({
        level: "info",
        event: "repository_scan_started",
        repo_id: repoId,
      });
      let mergeRequests: MergeRequest[];
      try {
        mergeRequests = await this.codeHub.mrList(repoId, signal);
      } catch (error) {
        failureCount += 1;
        await this.logger.write({
          level: "warn",
          event: "repository_scan_failed",
          repo_id: repoId,
          duration_ms: elapsedSince(repositoryStartedAt),
          error: errorMessage(error),
        });
        continue;
      }

      let repositoryPendingCount = 0;
      for (const mr of mergeRequests) {
        if (signal?.aborted) break;
        if (mr.state !== "opened") continue;
        const latest = await this.state.read();
        const cursor = latest.repositories[repoId]?.merge_requests[mr.iid]
          ?.last_processed_updated_at;
        if (!hasNewerUpdate(cursor, mr.updated_at)) continue;
        repositoryPendingCount += 1;
        pendingReviewCount += 1;
        const terminal = await this.review(repoId, mr, signal);
        if (terminal.result === "failed") {
          failureCount += 1;
        } else {
          completedReviewCount += 1;
        }
      }

      await this.logger.write({
        level: "info",
        event: "repository_scan_finished",
        repo_id: repoId,
        merge_request_count: mergeRequests.length,
        pending_review_count: repositoryPendingCount,
        duration_ms: elapsedSince(repositoryStartedAt),
      });
    }

    await this.logger.write({
      level: "info",
      event: "scan_finished",
      repository_count: repositoryIds.length,
      pending_review_count: pendingReviewCount,
      completed_review_count: completedReviewCount,
      failure_count: failureCount,
      duration_ms: elapsedSince(scanStartedAt),
    });
    return {
      repositoryCount: repositoryIds.length,
      pendingReviewCount,
      completedReviewCount,
      failureCount,
    };
  }

  private async saveCursor(
    runId: string,
    repoId: string,
    mrIid: string,
    updatedAt: string,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.state.updateMergeRequest(repoId, mrIid, (current) => ({
        ...current,
        last_processed_updated_at: updatedAt,
      }));
    } catch (error) {
      await this.logger.write({
        level: "error",
        event: "state_save_failed",
        run_id: runId,
        repo_id: repoId,
        mr_iid: mrIid,
        operation: "cursor",
        duration_ms: elapsedSince(startedAt),
        error: errorMessage(error),
      });
      throw error;
    }
    await this.logger.write({
      level: "info",
      event: "state_saved",
      run_id: runId,
      repo_id: repoId,
      mr_iid: mrIid,
      operation: "cursor",
      updated_at: updatedAt,
      duration_ms: elapsedSince(startedAt),
    });
  }

  private async appendHistory(
    runId: string,
    repoId: string,
    mrIid: string,
    history: FindingHistory,
    updatedAt?: string,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.state.updateMergeRequest(repoId, mrIid, (current) => ({
        ...current,
        ...(updatedAt === undefined ? {} : { last_processed_updated_at: updatedAt }),
        finding_history: [...current.finding_history, history],
      }));
    } catch (error) {
      await this.logger.write({
        level: "error",
        event: "state_save_failed",
        run_id: runId,
        repo_id: repoId,
        mr_iid: mrIid,
        operation: "finding_history",
        duration_ms: elapsedSince(startedAt),
        error: errorMessage(error),
      });
      throw error;
    }
    await this.logger.write({
      level: "info",
      event: "state_saved",
      run_id: runId,
      repo_id: repoId,
      mr_iid: mrIid,
      operation: "finding_history",
      publication_status: history.publication_status,
      comment_id: history.comment_id,
      ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
      duration_ms: elapsedSince(startedAt),
    });
  }

  private async saveReviewReport(runId: string, markdown: string): Promise<void> {
    const reportDirectory = path.join(this.paths.agentOutputs, runId);
    const reportPath = path.join(reportDirectory, "review.md");
    assertPathWithin(this.paths.agentOutputs, reportDirectory);
    assertPathWithin(this.paths.agentOutputs, reportPath);
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(reportPath, markdown, "utf8");
  }

  private async applyJudge(
    runId: string,
    repoId: string,
    mr: MergeRequest,
    judge: JudgeReport,
    signal?: AbortSignal,
  ): Promise<TerminalRecord> {
    if (judge.decision.verdict === "pass") {
      await this.saveCursor(runId, repoId, mr.iid, mr.updated_at);
      return { result: "pass" };
    }
    if (judge.decision.verdict === "duplicate_of") {
      await this.saveCursor(runId, repoId, mr.iid, mr.updated_at);
      return {
        result: "duplicate_of",
        duplicate_of_comment_id: judge.decision.duplicate_comment_id,
      };
    }

    await this.saveReviewReport(runId, judge.markdown);

    const publishStartedAt = Date.now();
    await this.logger.write({
      level: "info",
      event: "comment_publish_started",
      run_id: runId,
      repo_id: repoId,
      mr_iid: mr.iid,
      severity: judge.decision.severity,
    });

    let latest: MergeRequest;
    try {
      latest = await this.codeHub.mrView(repoId, mr.iid, signal);
    } catch (error) {
      await this.logger.write({
        level: "error",
        event: "comment_publish_failed",
        run_id: runId,
        repo_id: repoId,
        mr_iid: mr.iid,
        duration_ms: elapsedSince(publishStartedAt),
        error: errorMessage(error),
      });
      throw error;
    }
    if (latest.state !== "opened") {
      await this.logger.write({
        level: "warn",
        event: "comment_publish_skipped",
        run_id: runId,
        repo_id: repoId,
        mr_iid: mr.iid,
        reason: "closed",
        duration_ms: elapsedSince(publishStartedAt),
      });
      return { result: "closed" };
    }
    if (!isSameUpdate(latest.updated_at, mr.updated_at)) {
      await this.logger.write({
        level: "warn",
        event: "comment_publish_skipped",
        run_id: runId,
        repo_id: repoId,
        mr_iid: mr.iid,
        reason: "updated",
        duration_ms: elapsedSince(publishStartedAt),
      });
      return { result: "updated" };
    }

    let published: CommentResult;
    try {
      published = await this.codeHub.createComment(
        repoId,
        mr.iid,
        judge.markdown,
        severityToCodeHub[judge.decision.severity],
        signal,
      );
    } catch (error) {
      if (!(error instanceof CodeHubCommandError) || error.externalCode !== "WRITE_RESULT_UNKNOWN") {
        await this.logger.write({
          level: "error",
          event: "comment_publish_failed",
          run_id: runId,
          repo_id: repoId,
          mr_iid: mr.iid,
          duration_ms: elapsedSince(publishStartedAt),
          error: errorMessage(error),
        });
        throw error;
      }
      await this.logger.write({
        level: "warn",
        event: "comment_publish_unknown",
        run_id: runId,
        repo_id: repoId,
        mr_iid: mr.iid,
        duration_ms: elapsedSince(publishStartedAt),
        error: errorMessage(error),
      });
      let updatedAt = mr.updated_at;
      try {
        const refreshed = await this.codeHub.mrView(repoId, mr.iid, signal);
        updatedAt = refreshed.updated_at;
      } catch {
        // The documented fallback is the review's starting updated_at.
      }
      await this.appendHistory(
        runId,
        repoId,
        mr.iid,
        historyFromMarkdown(judge.markdown, "unknown", null),
        updatedAt,
      );
      return { result: "publication_unknown", comment_id: null };
    }

    await this.logger.write({
      level: "info",
      event: "comment_publish_finished",
      run_id: runId,
      repo_id: repoId,
      mr_iid: mr.iid,
      comment_id: published.comment_id,
      duration_ms: elapsedSince(publishStartedAt),
    });
    let updatedAt = mr.updated_at;
    try {
      const refreshed = await this.codeHub.mrView(repoId, mr.iid, signal);
      updatedAt = refreshed.updated_at;
    } catch {
      // The confirmed comment must still mark this MR version as processed.
    }
    await this.appendHistory(
      runId,
      repoId,
      mr.iid,
      historyFromMarkdown(judge.markdown, "confirmed", published.comment_id),
      updatedAt,
    );
    return { result: "new", comment_id: published.comment_id };
  }

  private async runExpert(
    runId: string,
    repoId: string,
    mrIid: string,
    expert: ExpertName,
    worktreePath: string,
    inputPath: string,
    artifactDir: string,
    signal?: AbortSignal,
  ): Promise<ExpertReport> {
    const startedAt = Date.now();
    await this.logger.write({
      level: "info",
      event: "agent_started",
      run_id: runId,
      repo_id: repoId,
      mr_iid: mrIid,
      agent: expert,
    });
    try {
      const result = await this.openCode.runExpert(expert, worktreePath, inputPath, {
        artifactDir,
        timeoutMs: this.agentTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
        onProgress: async (progress) => {
          await this.logAgentProgress(runId, repoId, mrIid, expert, progress);
        },
      });
      await this.logger.write({
        level: "info",
        event: "agent_finished",
        run_id: runId,
        repo_id: repoId,
        mr_iid: mrIid,
        agent: expert,
        report_chars: result.markdown.length,
        duration_ms: elapsedSince(startedAt),
      });
      return result;
    } catch (error) {
      await this.logAgentFailure(runId, repoId, mrIid, expert, startedAt, error);
      throw error;
    }
  }

  private async runJudge(
    runId: string,
    repoId: string,
    mrIid: string,
    worktreePath: string,
    inputPaths: readonly string[],
    artifactDir: string,
    signal?: AbortSignal,
  ): Promise<JudgeReport> {
    const agent = "review-judge" as const;
    const startedAt = Date.now();
    await this.logger.write({
      level: "info",
      event: "agent_started",
      run_id: runId,
      repo_id: repoId,
      mr_iid: mrIid,
      agent,
    });
    try {
      const result = await this.openCode.runJudge(worktreePath, inputPaths, {
        artifactDir,
        timeoutMs: this.agentTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
        onProgress: async (progress) => {
          await this.logAgentProgress(runId, repoId, mrIid, agent, progress);
        },
      });
      await this.logger.write({
        level: "info",
        event: "agent_finished",
        run_id: runId,
        repo_id: repoId,
        mr_iid: mrIid,
        agent,
        verdict: result.decision.verdict,
        ...(result.decision.verdict === "new"
          ? { severity: result.decision.severity }
          : result.decision.verdict === "duplicate_of"
            ? { duplicate_of_comment_id: result.decision.duplicate_comment_id }
            : {}),
        duration_ms: elapsedSince(startedAt),
      });
      return result;
    } catch (error) {
      await this.logAgentFailure(runId, repoId, mrIid, agent, startedAt, error);
      throw error;
    }
  }

  private async logAgentFailure(
    runId: string,
    repoId: string,
    mrIid: string,
    agent: AgentName,
    startedAt: number,
    error: unknown,
  ): Promise<void> {
    await this.logger.write({
      level: "error",
      event: "agent_failed",
      run_id: runId,
      repo_id: repoId,
      mr_iid: mrIid,
      agent,
      duration_ms: elapsedSince(startedAt),
      error: errorMessage(error),
    });
  }

  private async logAgentProgress(
    runId: string,
    repoId: string,
    mrIid: string,
    agent: AgentName,
    progress: AgentRunProgress,
  ): Promise<void> {
    const context = {
      run_id: runId,
      repo_id: repoId,
      mr_iid: mrIid,
      agent,
      step: progress.step,
      ...(progress.attempt === undefined ? {} : { attempt: progress.attempt }),
    } as const;
    switch (progress.type) {
      case "process_ready":
        await this.logger.write({
          level: "info",
          event: "agent_process_ready",
          ...context,
          startup_ms: progress.startup_ms,
        });
        break;
      case "step_started":
        await this.logger.write({
          level: "info",
          event: "agent_step_started",
          ...context,
        });
        break;
      case "tool_started":
        await this.logger.write({
          level: "info",
          event: "agent_tool_started",
          ...context,
          tool: progress.tool,
          ...(progress.action === undefined ? {} : { action: progress.action }),
        });
        break;
      case "tool_finished":
        await this.logger.write({
          level: progress.status === "failed" ? "warn" : "info",
          event: "agent_tool_finished",
          ...context,
          tool: progress.tool,
          ...(progress.action === undefined ? {} : { action: progress.action }),
          status: progress.status,
          ...(progress.duration_ms === undefined
            ? {}
            : { duration_ms: progress.duration_ms }),
        });
        break;
      case "step_finished":
        await this.logger.write({
          level: "info",
          event: "agent_step_finished",
          ...context,
          ...(progress.reason === undefined ? {} : { reason: progress.reason }),
          ...(progress.duration_ms === undefined
            ? {}
            : { duration_ms: progress.duration_ms }),
          ...(progress.model_until_action_ms === undefined
            ? {}
            : { model_until_action_ms: progress.model_until_action_ms }),
          ...(progress.text_generation_ms === undefined
            ? {}
            : { text_generation_ms: progress.text_generation_ms }),
          ...(progress.input_tokens === undefined
            ? {}
            : { input_tokens: progress.input_tokens }),
          ...(progress.output_tokens === undefined
            ? {}
            : { output_tokens: progress.output_tokens }),
          ...(progress.reasoning_tokens === undefined
            ? {}
            : { reasoning_tokens: progress.reasoning_tokens }),
          ...(progress.cache_read_tokens === undefined
            ? {}
            : { cache_read_tokens: progress.cache_read_tokens }),
          ...(progress.cache_write_tokens === undefined
            ? {}
            : { cache_write_tokens: progress.cache_write_tokens }),
        });
        break;
      case "waiting":
        await this.logger.write({
          level: "info",
          event: "agent_waiting",
          ...context,
          last_event: progress.last_event,
          idle_ms: progress.idle_ms,
        });
        break;
      case "summary":
        await this.logger.write({
          level: "info",
          event: "agent_progress_summary",
          ...context,
          summary: progress.summary,
        });
        break;
    }
  }

  private async review(
    repoId: string,
    mr: MergeRequest,
    signal?: AbortSignal,
  ): Promise<TerminalRecord> {
    const runStartedAt = Date.now();
    const runId = randomUUID();
    const runDir = path.join(this.paths.runs, runId);
    assertPathWithin(this.paths.runs, runDir);
    let terminal: TerminalRecord | undefined;
    const cleanupErrors: string[] = [];
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
      const worktreeStartedAt = Date.now();
      await this.logger.write({
        level: "info",
        event: "worktree_prepare_started",
        run_id: runId,
        repo_id: repoId,
        mr_iid: mr.iid,
      });
      let worktreePath: string;
      try {
        const hasCache = await this.git.hasCache(repoId);
        const repository = hasCache ? undefined : await this.codeHub.repoView(repoId, signal);
        worktreePath = await this.git.prepare(repoId, mr, repository, signal);
        await this.logger.write({
          level: "info",
          event: "worktree_prepare_finished",
          run_id: runId,
          repo_id: repoId,
          mr_iid: mr.iid,
          cache: hasCache ? "existing" : "created",
          duration_ms: elapsedSince(worktreeStartedAt),
        });
      } catch (error) {
        await this.logger.write({
          level: "error",
          event: "worktree_prepare_failed",
          run_id: runId,
          repo_id: repoId,
          mr_iid: mr.iid,
          duration_ms: elapsedSince(worktreeStartedAt),
          error: errorMessage(error),
        });
        throw error;
      }

      const commitsStartedAt = Date.now();
      await this.logger.write({
        level: "info",
        event: "commits_load_started",
        run_id: runId,
        repo_id: repoId,
        mr_iid: mr.iid,
      });
      let commits: Commit[];
      try {
        commits = await this.codeHub.mrCommits(repoId, mr.iid, signal);
        await this.logger.write({
          level: "info",
          event: "commits_load_finished",
          run_id: runId,
          repo_id: repoId,
          mr_iid: mr.iid,
          commit_count: commits.length,
          duration_ms: elapsedSince(commitsStartedAt),
        });
      } catch (error) {
        await this.logger.write({
          level: "error",
          event: "commits_load_failed",
          run_id: runId,
          repo_id: repoId,
          mr_iid: mr.iid,
          duration_ms: elapsedSince(commitsStartedAt),
          error: errorMessage(error),
        });
        throw error;
      }

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

      const expertReports: ExpertReport[] = [];
      const expertReportPaths: string[] = [];
      for (const [index, expert] of experts.entries()) {
        const artifactDir = path.join(
          this.paths.agentOutputs,
          runId,
          `${String(index + 1).padStart(2, "0")}-${expert}`,
        );
        assertPathWithin(this.paths.agentOutputs, artifactDir);
        expertReports.push(
          await this.runExpert(
            runId,
            repoId,
            mr.iid,
            expert,
            worktreePath,
            expertInputPath,
            artifactDir,
            signal,
          ),
        );
        expertReportPaths.push(path.join(artifactDir, "report.md"));
      }

      if (expertReports.length !== experts.length) {
        throw new Error("Review run did not produce all expert Markdown reports.");
      }

      const latestState = await this.state.read();
      const findingHistory =
        latestState.repositories[repoId]?.merge_requests[mr.iid]?.finding_history ?? [];
      const judgeContext = judgeContextSchema.parse({
        ...expertInput,
        finding_history: findingHistory,
      });
      const judgeContextPath = path.join(runDir, "judge-context.json");
      await writeFile(
        judgeContextPath,
        `${JSON.stringify(judgeContext, null, 2)}\n`,
        "utf8",
      );
      const judgeArtifactDir = path.join(this.paths.agentOutputs, runId, "04-review-judge");
      assertPathWithin(this.paths.agentOutputs, judgeArtifactDir);
      const judge = await this.runJudge(
        runId,
        repoId,
        mr.iid,
        worktreePath,
        [judgeContextPath, ...expertReportPaths],
        judgeArtifactDir,
        signal,
      );
      terminal = await this.applyJudge(runId, repoId, mr, judge, signal);
    } catch (error) {
      terminal = { result: "failed", error: errorMessage(error) };
    } finally {
      const cleanupStartedAt = Date.now();
      await this.logger.write({
        level: "info",
        event: "cleanup_started",
        run_id: runId,
        repo_id: repoId,
        mr_iid: mr.iid,
      });
      try {
        await this.git.cleanup(repoId, mr.iid);
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
      try {
        assertPathWithin(this.paths.runs, runDir);
        await rm(runDir, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
      if (cleanupErrors.length === 0) {
        await this.logger.write({
          level: "info",
          event: "cleanup_finished",
          run_id: runId,
          repo_id: repoId,
          mr_iid: mr.iid,
          duration_ms: elapsedSince(cleanupStartedAt),
        });
      } else {
        await this.logger.write({
          level: "warn",
          event: "cleanup_failed",
          run_id: runId,
          repo_id: repoId,
          mr_iid: mr.iid,
          duration_ms: elapsedSince(cleanupStartedAt),
          error: cleanupErrors.join("; "),
        });
      }
    }

    const finalRecord = terminal ?? { result: "failed", error: "Review did not complete." };
    await this.logger.write({
      level: terminalLevel(finalRecord.result),
      event: "review_run_finished",
      run_id: runId,
      repo_id: repoId,
      mr_iid: mr.iid,
      updated_at: mr.updated_at,
      duration_ms: elapsedSince(runStartedAt),
      ...finalRecord,
    });
    return finalRecord;
  }
}
