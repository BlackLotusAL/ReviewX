import { projectAppState, projectAttempt, projectMrDetail, selectMrDetail } from "./review/views";
import { randomUUID } from "node:crypto";
import { relative, sep, join } from "node:path";
import type {
  AppStateView,
  AttemptStatus,
  MergeRequestSnapshot,
  MrDetailView,
  PersistentState,
  ReviewAttempt,
  ReviewPhase,
  SafeErrorView,
} from "@/src/shared/types";
import { isOpenMrState, type CodeHubPort } from "./integrations/codehub";
import { AppError, conflictError, isAppError, notFoundError, unexpectedError, validationError } from "./errors";
import * as findingState from "./review/finding-state";
import type { GitPreparerPort, PreparedReview } from "./integrations/git";
import type { Logger } from "./platform/logger";
import type { ReviewerPort } from "./integrations/opencode";
import type { DataPaths } from "./platform/paths";
import { readContainedFile, ReportStore } from "./storage/report-store";
import { freezeReviewRules } from "./review/rules";
import { REVIEW_LIMITS, reviewError } from "@/src/server/review/materials";
import type { FrozenRules, ReviewProgress } from "@/src/shared/review-contract";
import { StateStore } from "./storage/state-store";
import { checkWorkspaceProcesses } from "./platform/workspace-process";
import { ReviewTrace } from "./review/trace";
import { timedProgress } from "./review/progress";

const ACTIVE_REVIEW_STATUSES: AttemptStatus[] = ["queued", "reviewing", "stopping"];

function mrKey(projectId: string, mrIid: string): string {
  return `${projectId}:${mrIid}`;
}

function ensurePositiveId(value: string, label: string): void {
  if (!/^[1-9]\d*$/u.test(value)) throw validationError(`${label} 必须是正整数。`);
}

function assertOpen(mr: MergeRequestSnapshot): void {
  if (!isOpenMrState(mr.state)) throw new AppError({
    code: "MR_NOT_OPEN",
    message: `MR !${mr.iid} 已不再处于开放状态。`,
    reason: `CodeHub mr view 返回状态 ${mr.state}。`,
    impact: "当前刷新或 attempt 已停止；Git 和 OpenCode 不会启动。",
    nextStep: "手动刷新 MR 列表后选择状态为 open 或 opened 的 MR。",
    technical: "MR state was neither open nor opened when validated.",
  });
}

export interface RuntimeDependencies {
  paths: DataPaths;
  store: StateStore;
  logger: Logger;
  codeHub: CodeHubPort;
  git: GitPreparerPort;
  reviewer: ReviewerPort;
  reports: ReportStore;
  now?: () => Date;
  id?: () => string;
  rulesRoot?: string;
}

export class ReviewXRuntime {
  #state!: PersistentState;
  #viewRevision = 0;
  #rules = new Map<string, FrozenRules>();
  #progress = new Map<string, ReviewProgress>();
  #timings = new Map<string, { started: number; phase: string; since: number; values: Record<string, number> }>();
  #traces = new Map<string, ReviewTrace>();
  #fatalError: SafeErrorView | null = null;
  #warnings: string[] = [];
  #pendingCleanup: (() => Promise<void>) | null = null;
  #resuming = false;
  #removingProjects = new Set<string>();
  #refreshPromise: Promise<void> | null = null;
  #reviewWorker: Promise<void> | null = null;
  #activeReviewController: AbortController | null = null;
  #activeAttemptDone: Promise<void> | null = null;
  #resolveActiveAttemptDone: (() => void) | null = null;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(private readonly dependencies: RuntimeDependencies) {
    this.#now = dependencies.now ?? (() => new Date());
    this.#id = dependencies.id ?? randomUUID;
    dependencies.logger.setFailureHandler((error) => {
      this.#warnings.push(dependencies.logger.safeError(error).message);
      this.#viewRevision += 1;
      if (this.#state) void this.#recordDiagnostic("Session logging", {}, error);
    });
  }

  async initialize(): Promise<this> {
    this.#state = await this.dependencies.store.initialize(this.#now().toISOString());
    this.#viewRevision = this.#state.revision;
    this.#info({}, "ReviewX state loaded and interrupted operations recovered.");
    this.#assertOperational();
    try { await checkWorkspaceProcesses(this.dependencies.paths.workspaces); }
    catch (error) { await this.#pauseQueue(this.#error(error, "残留进程检查")); }
    for (const id of this.#state.reviewQueue) {
      const rules = this.#state.attemptsById[id]?.rules;
      if (rules) this.#rules.set(id, rules);
    }
    this.#kickReviewWorker();
    return this;
  }

  snapshot(): AppStateView {
    return { ...projectAppState({ state: this.#state, revision: this.#viewRevision, removingProjects: this.#removingProjects, progress: this.#progress, fatalError: this.#fatalError }), warnings: this.#warnings };
  }

  async getMrDetail(projectId: string, mrIid: string): Promise<MrDetailView> {
    ensurePositiveId(projectId, "Project ID");
    ensurePositiveId(mrIid, "MR IID");
    const source = selectMrDetail(this.#state, projectId, mrIid);
    const views = await Promise.all([...source.attempts].reverse().map(async (attempt) => {
      const execution = attempt.reportPath ? await this.dependencies.reports.execution(attempt.reportPath) : undefined;
      return projectAttempt(attempt, this.#progress.get(attempt.id), execution);
    }));
    return projectMrDetail(this.#state, source, views);
  }

  async readReport(attemptId: string): Promise<string> {
    const attempt = this.#state.attemptsById[attemptId];
    if (!attempt?.reportPath) throw notFoundError("找不到该 attempt 的报告。");
    return this.dependencies.reports.read(attempt.reportPath);
  }

  async readCurrentLog(): Promise<string> {
    const relativePath = relative(this.dependencies.paths.root, this.dependencies.logger.filePath).split(sep).join("/");
    return readContainedFile(this.dependencies.paths.root, relativePath);
  }

  async addProject(projectId: string): Promise<AppStateView> {
    this.#assertOperational();
    ensurePositiveId(projectId, "Project ID");
    if (this.#state.registeredProjectIds.includes(projectId)) throw conflictError("PROJECT_ALREADY_EXISTS", "该 Project 已登记。", "使用现有 Project 或先移除后重新添加。");
    try {
      this.#info({ projectId }, "Validating Project with CodeHub.");
      this.#assertOperational();
      const resolved = await this.dependencies.codeHub.viewRepo(projectId);
      const now = this.#now().toISOString();
      await this.#mutate((draft) => {
        if (draft.registeredProjectIds.includes(projectId)) throw conflictError("PROJECT_ALREADY_EXISTS", "该 Project 已登记。", "使用现有 Project。");
        const previous = draft.projectsById[projectId];
        draft.projectsById[projectId] = {
          id: projectId,
          name: resolved.name,
          cloneUrl: resolved.cloneUrl,
          webUrl: resolved.webUrl,
          addedAt: previous?.addedAt ?? now,
          updatedAt: now,
        };
        draft.registeredProjectIds.push(projectId);
      });
      this.#info({ projectId, projectName: resolved.name }, "Project registered; preserved history is visible again.");
      return this.snapshot();
    } catch (error) {
      const appError = this.#error(error, "Project 添加");
      await this.#recordDiagnostic("Project registration", { projectId }, appError);
      this.#logError({ projectId }, appError);
      throw appError;
    }
  }

  async removeProject(projectId: string): Promise<AppStateView> {
    ensurePositiveId(projectId, "Project ID");
    if (!this.#state.registeredProjectIds.includes(projectId)) throw notFoundError("该 Project 未登记。");
    const publishingAttempt = this.#state.activePublishBatch
      ? this.#state.attemptsById[this.#state.activePublishBatch.attemptId]
      : undefined;
    if (publishingAttempt?.projectId === projectId) {
      throw conflictError("PROJECT_PUBLISHING", "该 Project 正在发送评论，暂时不能移除。", "等待当前评论发送结束后重试。");
    }
    this.#removingProjects.add(projectId);
    this.#viewRevision += 1;
    try {
      const now = this.#now().toISOString();
      let activeAttemptId: string | null = null;
      await this.#mutate((draft) => {
        if (!draft.registeredProjectIds.includes(projectId)) throw notFoundError("该 Project 未登记。");
        const activePublication = draft.activePublishBatch
          ? draft.attemptsById[draft.activePublishBatch.attemptId]
          : undefined;
        if (activePublication?.projectId === projectId) {
          throw conflictError("PROJECT_PUBLISHING", "该 Project 正在发送评论，暂时不能移除。", "等待当前评论发送结束后重试。");
        }
        draft.reviewQueue = draft.reviewQueue.filter((attemptId) => {
          const attempt = draft.attemptsById[attemptId];
          if (attempt?.projectId !== projectId) return true;
          attempt.status = "stopped";
          attempt.phase = undefined;
          attempt.stoppedAt = now;
          return false;
        });
        activeAttemptId = draft.activeReviewAttemptId;
        if (activeAttemptId) {
          const active = draft.attemptsById[activeAttemptId];
          if (active?.projectId === projectId && ["reviewing", "stopping"].includes(active.status)) {
            if (active.status === "reviewing") {
              active.status = "stopping";
              active.phase = "cleaning_up";
            }
          } else {
            activeAttemptId = null;
          }
        }
      });
      if (activeAttemptId) {
        this.#activeReviewController?.abort(new Error("Project removal requested."));
        await this.#activeAttemptDone;
      }
      await this.#mutate((draft) => {
        const index = draft.registeredProjectIds.indexOf(projectId);
        if (index < 0) throw notFoundError("该 Project 未登记。");
        draft.registeredProjectIds.splice(index, 1);
      });
      this.#info({ projectId, projectName: this.#state.projectsById[projectId]?.name }, "Project removed; snapshots, attempts, reports, publication records, and logs were retained.");
      return this.snapshot();
    } catch (error) {
      const appError = this.#error(error, "Project 移除");
      await this.#recordDiagnostic("Project removal", { projectId }, appError);
      this.#logError({ projectId }, appError);
      throw appError;
    } finally {
      this.#removingProjects.delete(projectId);
      this.#viewRevision += 1;
    }
  }

  async refreshMrs(): Promise<AppStateView> {
    this.#assertOperational();
    if (this.#refreshPromise) throw conflictError("REFRESH_IN_PROGRESS", "MR 刷新已经在进行。", "等待当前刷新结束。");
    const operation = this.#runRefresh();
    this.#refreshPromise = operation;
    try {
      await operation;
      return this.snapshot();
    } finally {
      this.#refreshPromise = null;
    }
  }

  async #runRefresh(): Promise<void> {
    const startedAt = this.#now().toISOString();
    await this.#mutate((draft) => {
      draft.refreshOperation = { status: "refreshing", startedAt };
    });
    const projects = [...this.#state.registeredProjectIds];
    try {
      this.#info({}, `Refreshing open MRs for ${projects.length} registered Project${projects.length === 1 ? "" : "s"}.`);
      this.#assertOperational();
      for (const projectId of projects) {
        this.#assertOperational();
        await this.#mutate((draft) => {
          draft.refreshOperation.currentProjectId = projectId;
        });
        const project = this.#state.projectsById[projectId];
        if (!project) throw new Error(`Missing Project ${projectId}.`);
        const listed = await this.dependencies.codeHub.listOpenMrs(projectId);
        const seen = new Set<string>();
        const mergeRequests: MergeRequestSnapshot[] = [];
        for (const entry of listed) {
          if (seen.has(entry.iid)) throw new AppError({
            code: "DUPLICATE_MR_IID",
            message: "CodeHub MR 列表包含重复 IID。",
            reason: `Project ${projectId} 重复返回 MR !${entry.iid}。`,
            impact: "该 Project 保留上次成功刷新结果，后续 Project 未处理。",
            nextStep: "检查 CodeHub CLI 输出后重新刷新。",
            technical: "Duplicate MR IID in mr list output.",
          });
          seen.add(entry.iid);
          const details = await this.dependencies.codeHub.viewMr(projectId, entry.iid, entry.title);
          assertOpen(details);
          details.title = entry.title;
          mergeRequests.push(details);
        }
        const refreshedAt = this.#now().toISOString();
        await this.#mutate((draft) => {
          draft.snapshotsByProjectId[projectId] = { refreshedAt, mergeRequests };
        });
        this.#info({ projectId, projectName: project.name }, `Stored a complete open MR snapshot containing ${mergeRequests.length} item${mergeRequests.length === 1 ? "" : "s"}.`);
      }
      await this.#mutate((draft) => {
        draft.refreshOperation = { status: "idle", startedAt, completedAt: this.#now().toISOString() };
      });
      this.#info({}, "Manual MR refresh completed.");
    } catch (error) {
      const appError = this.#error(error, "MR 刷新");
      await this.#mutate((draft) => {
        draft.refreshOperation = {
          status: "failed",
          startedAt,
          completedAt: this.#now().toISOString(),
          error: this.dependencies.logger.safeError(appError),
        };
      }).catch(() => undefined);
      await this.#recordDiagnostic("MR refresh", { projectId: this.#state.refreshOperation.currentProjectId }, appError);
      this.#logError({ projectId: this.#state.refreshOperation.currentProjectId }, appError);
      throw appError;
    }
  }

  async createReview(projectId: string, mrIid: string): Promise<AppStateView> {
    this.#assertOperational();
    ensurePositiveId(projectId, "Project ID");
    ensurePositiveId(mrIid, "MR IID");
    const project = this.#state.projectsById[projectId];
    if (!project || !this.#state.registeredProjectIds.includes(projectId)) throw notFoundError("该 Project 未登记。");
    if (this.#removingProjects.has(projectId)) throw conflictError("PROJECT_REMOVING", "该 Project 正在停止任务并移除。", "等待移除完成后再操作。");
    const mr = this.#state.snapshotsByProjectId[projectId]?.mergeRequests.find((item) => item.iid === mrIid);
    if (!mr) throw notFoundError("当前 MR 快照中找不到该 MR，请先手动刷新。");
    const preflightStarted = Date.now();
    const frozen = await freezeReviewRules(this.dependencies.paths.root, undefined, undefined, process.env, this.dependencies.rulesRoot);
    // Queued attempts can share an identical immutable snapshot without retaining duplicate documents.
    const rules = [...this.#rules.values()].find(value => value.profileHash === frozen.profileHash && JSON.stringify(value.warnings) === JSON.stringify(frozen.warnings)) ?? frozen;
    this.#info({ projectId, mrIid }, `Rules preflight elapsedMs=${Date.now() - preflightStarted}.`);
    for (const warning of rules.warnings ?? []) this.#info({ projectId, mrIid }, warning);
    const key = mrKey(projectId, mrIid);
    const now = this.#now().toISOString();
    const attemptId = this.#id();
    this.#info({ projectId, projectName: project.name, mrIid, mrTitle: mr.title, attemptId }, "Appending a review attempt to the global FIFO queue.");
    this.#assertOperational();
    await this.#mutate((draft) => {
      if (!draft.registeredProjectIds.includes(projectId) || this.#removingProjects.has(projectId)) throw conflictError("PROJECT_REMOVING", "该 Project 已移除或正在移除。", "刷新页面后重新选择 Project。");
      const ids = draft.attemptIdsByMr[key] ?? [];
      const previousId = ids.at(-1);
      const previous = previousId ? draft.attemptsById[previousId] : undefined;
      if (previous) findingState.archive(previous, now);
      const attempt: ReviewAttempt = {
        id: attemptId,
        projectId,
        mrIid,
        mrTitle: mr.title,
        requestedUpdatedAt: mr.updatedAt,
        updatedAt: mr.updatedAt,
        sourceBranch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        status: "queued",
        phase: "queued",
        createdAt: now,
        findings: [],
        rules,
        publishBatches: [],
      };
      draft.attemptsById[attemptId] = attempt;
      draft.attemptIdsByMr[key] = [...ids, attemptId];
      draft.reviewQueue.push(attemptId);
      this.#rules.set(attemptId, rules);
    }).catch(error => { this.#rules.delete(attemptId); throw error; });
    const trace = new ReviewTrace(attemptId, join(this.dependencies.paths.logs, `review-${attemptId}.jsonl`));
    trace.emit("review.queued", { queuedAt: now, profileHash: rules.profileHash });
    this.#traces.set(attemptId, trace);
    this.#kickReviewWorker();
    return this.snapshot();
  }

  async stopAttempt(attemptId: string): Promise<AppStateView> {
    const attempt = this.#state.attemptsById[attemptId];
    if (!attempt) throw notFoundError("找不到该 attempt。");
    const now = this.#now().toISOString();
    let stoppedQueued = false;
    let requestedActiveStop = false;
    await this.#mutate((draft) => {
      const target = draft.attemptsById[attemptId];
      if (!target) throw notFoundError("找不到该 attempt。");
      if (target.status === "queued") {
        draft.reviewQueue = draft.reviewQueue.filter((id) => id !== attemptId);
        target.status = "stopped";
        target.phase = undefined;
        target.stoppedAt = now;
        stoppedQueued = true;
        return;
      }
      if (target.status === "reviewing") {
        target.status = "stopping";
        target.phase = "cleaning_up";
        requestedActiveStop = true;
        return;
      }
      throw conflictError("ATTEMPT_NOT_STOPPABLE", "该 attempt 当前不可停止。", "刷新页面并使用当前可用操作。");
    });
    if (stoppedQueued) {
      const trace = this.#traces.get(attemptId) ?? new ReviewTrace(attemptId, join(this.dependencies.paths.logs, `review-${attemptId}.jsonl`));
      trace.emit("review.finished", { outcome: "cancelled_while_queued" });
      await trace.flush(); this.#traces.delete(attemptId);
      this.#info(this.#context(attempt), "Queued review attempt stopped and removed from FIFO.");
      return this.snapshot();
    }
    if (requestedActiveStop) {
      this.#activeReviewController?.abort(new Error("User requested stop."));
      this.#info(this.#context(attempt), "Stop requested; the active child process tree is being terminated.");
      return this.snapshot();
    }
    throw new Error("Unreachable attempt stop state.");
  }

  #kickReviewWorker(): void {
    if (this.#reviewWorker || this.#state.queuePaused || this.#fatalError) return;
    this.#reviewWorker = (async () => {
      let failed = false;
      try {
        await this.#reviewLoop();
      } catch (error) {
        failed = true;
        const appError = this.#error(error, "检视 worker");
        await this.#pauseQueue(appError);
        this.#activeReviewController?.abort(new Error("Review worker failed."));
        this.#activeReviewController = null;
        this.#resolveActiveAttemptDone?.();
        this.#resolveActiveAttemptDone = null;
        this.#activeAttemptDone = null;
        await this.#recordDiagnostic("Review worker", {}, appError);
        this.#logError({}, appError);
      } finally {
        this.#reviewWorker = null;
        if (!failed && this.#state.reviewQueue.length > 0 && this.#state.activeReviewAttemptId === null && !this.#state.queuePaused && !this.#fatalError) this.#kickReviewWorker();
      }
    })();
  }

  async #reviewLoop(): Promise<void> {
    while (this.#state.reviewQueue.length > 0 && this.#state.activeReviewAttemptId === null && !this.#state.queuePaused && !this.#fatalError) {
      let attemptId: string | undefined;
      const controller = new AbortController();
      this.#activeReviewController = controller;
      this.#activeAttemptDone = new Promise<void>((resolve) => { this.#resolveActiveAttemptDone = resolve; });
      try {
        await this.#mutate((draft) => {
          if (this.#fatalError) return;
          attemptId = draft.reviewQueue.shift();
          if (!attemptId) return;
          const attempt = draft.attemptsById[attemptId];
          if (!attempt || attempt.status !== "queued") throw new Error(`Invalid queued attempt ${attemptId}.`);
          attempt.status = "reviewing";
          attempt.phase = "loading_mr";
          attempt.startedAt = this.#now().toISOString();
          draft.activeReviewAttemptId = attemptId;
        });
      } catch (error) {
        this.#activeReviewController = null;
        this.#resolveActiveAttemptDone?.();
        this.#resolveActiveAttemptDone = null;
        this.#activeAttemptDone = null;
        throw error;
      }
      if (!attemptId) {
        this.#activeReviewController = null;
        this.#resolveActiveAttemptDone?.();
        this.#resolveActiveAttemptDone = null;
        this.#activeAttemptDone = null;
        return;
      }
      const attempt = this.#state.attemptsById[attemptId];
      if (!attempt) throw new Error(`Missing active attempt ${attemptId}.`);
      try {
        await this.#runReview(attemptId, controller.signal);
      } catch (error) {
        const appError = this.#error(error, "MR 检视");
        if (["OPENCODE_CLEANUP_FAILED", "REPORT_WRITE_ERROR"].includes(appError.code) || appError.code.startsWith("STATE_")) await this.#pauseQueue(appError);
        if (controller.signal.aborted || ["GIT_CANCELLED", "OPENCODE_CANCELLED"].includes(appError.code)) {
          await this.#mutate((draft) => {
            const target = draft.attemptsById[attemptId!];
            if (!target) return;
            target.status = "stopped";
            target.phase = undefined;
            target.stoppedAt = this.#now().toISOString();
            target.reviewFinishedAt = target.stoppedAt;
            target.error = undefined;
            target.reportPath = undefined;
            target.result = undefined;
            target.findings = [];
          }).catch(() => undefined);
          this.#info(this.#context(attempt), "Review attempt stopped; no incomplete result is publishable.");
        } else {
          await this.#mutate((draft) => {
            const target = draft.attemptsById[attemptId!];
            if (target) {
              target.status = "review_failed";
              target.phase = undefined;
              target.completedAt = this.#now().toISOString();
              target.reviewFinishedAt = target.completedAt;
              target.error = this.dependencies.logger.safeError(appError);
              for (const finding of target.findings) if (finding.status === "pending") finding.status = "archived";
            }
          }).catch(() => undefined);
          await this.#recordDiagnostic("MR review", this.#context(attempt), appError);
          this.#logError(this.#context(attempt), appError);
        }
      } finally {
        await this.#mutate((draft) => {
          if (draft.activeReviewAttemptId === attemptId) draft.activeReviewAttemptId = null;
        }).catch(error => this.#pauseQueue(this.#error(error, "清除执行标记")));
        this.#activeReviewController = null;
        this.#resolveActiveAttemptDone?.();
        this.#resolveActiveAttemptDone = null;
        this.#activeAttemptDone = null;
      }
    }
  }

  async #runReview(attemptId: string, cancellation: AbortSignal): Promise<void> {
    const started = Date.now();
    const trace = this.#traces.get(attemptId) ?? new ReviewTrace(attemptId, join(this.dependencies.paths.logs, `review-${attemptId}.jsonl`));
    this.#traces.set(attemptId, trace);
    const attempt = this.#state.attemptsById[attemptId];
    trace.emit("review.started", { queuedAt: attempt.createdAt, queueMs: Math.max(0, Date.parse(attempt.startedAt!) - Date.parse(attempt.createdAt)), profileHash: attempt.rules?.profileHash });
    const softTimer = setTimeout(() => {
      const current = this.#progress.get(attemptId) ?? { activity: "正在准备检视材料", limitations: [] };
      this.#progress.set(attemptId, timedProgress(current, Date.now() - started));
      this.#viewRevision++;
      trace.emit("review.soft_target_exceeded");
    }, REVIEW_LIMITS.softTargetMs);
    softTimer.unref();
    let outcome = "complete";
    const budget = AbortSignal.timeout(REVIEW_LIMITS.timeoutMs);
    const signal = AbortSignal.any([cancellation, budget]);
    this.#timings.set(attemptId, { started, phase: "loading_mr", since: started, values: {} });
    try {
      await this.#executeReview(attemptId, signal);
    } catch (error) {
      outcome = cancellation.aborted ? "cancelled" : budget.aborted ? "timeout" : "failed";
      if (budget.aborted && !cancellation.aborted && !(isAppError(error) && error.code === "OPENCODE_CLEANUP_FAILED")) throw reviewError("REVIEW_TIMEOUT", "整轮检视超过时间预算。", { cause: error, technical: error instanceof Error ? error.stack : String(error) });
      throw error;
    } finally {
      clearTimeout(softTimer);
      const timing = this.#timings.get(attemptId)!;
      timing.values[timing.phase] = (timing.values[timing.phase] ?? 0) + Date.now() - timing.since;
      this.#info(this.#context(this.#state.attemptsById[attemptId]), `Review elapsedMs=${Date.now() - started}; cancelled=${cancellation.aborted}; timedOut=${budget.aborted}; phases=${JSON.stringify(timing.values)}.`);
      this.#timings.delete(attemptId);
      trace.closeSpans(outcome);
      trace.emit("review.finished", { outcome, durationMs: Date.now() - started, phases: timing.values, performance: trace.summary() });
      await trace.flush();
      if (trace.summary().traceWriteFailed) this.#warnings.push(`检视 ${attemptId} 的性能记录写入失败，检视结果不受影响。`);
      this.#traces.delete(attemptId);
    }
  }

  async #executeReview(attemptId: string, signal: AbortSignal): Promise<void> {
    const trace = this.#traces.get(attemptId)!;
    const initialAttempt = this.#state.attemptsById[attemptId];
    if (!initialAttempt) throw new Error(`Missing attempt ${attemptId}.`);
    const project = this.#state.projectsById[initialAttempt.projectId];
    if (!project) throw new Error(`Missing Project ${initialAttempt.projectId}.`);
    this.#info(this.#context(initialAttempt), "Loading the current MR details for this attempt.");
    this.#assertOperational();
    const endMr = trace.span("loading_mr");
    let first: MergeRequestSnapshot;
    try { first = await this.dependencies.codeHub.viewMr(initialAttempt.projectId, initialAttempt.mrIid, initialAttempt.mrTitle, signal); endMr(); }
    catch (error) { endMr("failed"); throw error; }
    assertOpen(first);
    await this.#phase(attemptId, "preparing_git", (attempt) => {
      attempt.mrTitle = first.title;
      attempt.updatedAt = first.updatedAt;
      attempt.sourceBranch = first.sourceBranch;
      attempt.targetBranch = first.targetBranch;
    });
    this.#info(this.#context(initialAttempt), "Preparing fixed source and target Git revisions.");
    this.#assertOperational();
    let prepared: PreparedReview | null = null;
    let result: import("@/src/shared/types").ReviewerResult | undefined;
    try {
      const endGit = trace.span("preparing_git");
      try { prepared = await this.dependencies.git.prepare(project, first, signal, trace); endGit(); }
      catch (error) { endGit("failed"); throw error; }
      trace.emit("review.scope", { scope: prepared.scope });
      const rules = this.#rules.get(attemptId);
      if (!rules) throw reviewError("REVIEW_RULE_ERROR", "缺少入队前冻结的用户补充规则。");
      await this.#phase(attemptId, "running_opencode", (attempt) => {
        attempt.sourceSha = prepared!.sourceSha;
        attempt.targetSha = prepared!.targetSha;
      });
      this.#info(this.#context(initialAttempt), "Running read-only OpenCode review workflow.");
      this.#assertOperational();
      result = await this.dependencies.reviewer.review(initialAttempt.projectId, first, prepared, signal, { attemptId, rules, trace, onProgress: (progress) => {
        this.#progress.set(attemptId, timedProgress(progress, Date.now() - this.#timings.get(attemptId)!.started)); this.#viewRevision += 1;
      } });
      if (signal.aborted) throw new AppError({
        code: "OPENCODE_CANCELLED",
        message: "OpenCode 检视已停止。",
        reason: "收到停止请求。",
        impact: "本次 attempt 不保存可发布结果。",
        nextStep: "如仍需检视，请手动重新检视。",
        technical: "Abort signal observed after OpenCode completion.",
      });
    } catch (error) {
      if (result?.cleanupPending) error = reviewError("OPENCODE_CLEANUP_FAILED", "停止检视后进程退出仍未确认。", { cause: error });
      if (prepared) {
        if (isAppError(error) && error.code === "OPENCODE_CLEANUP_FAILED") this.#pendingCleanup = prepared.cleanup;
        else {
          const endCleanup = trace.span("workspace_cleanup");
          await prepared.cleanup().then(() => endCleanup(), e => {
            endCleanup("failed");
            this.#warnings.push("工作区清理失败：" + String(e));
            const main = this.#error(error, "检视");
            throw new AppError({ code: main.code, message: main.message, reason: main.reason, impact: main.impact, nextStep: main.nextStep,
              technical: main.technical + "\nCleanup: " + String(e), cause: error });
          });
        }
      }
      throw error;
    }
    if (!result || !prepared) return;
    let endSave: ((outcome?: string) => void) | undefined;
    let reportPath: string;
    try {
      if (signal.aborted) throw reviewError("REVIEW_CANCELLED", "保存前收到停止请求。");
      await this.#phase(attemptId, "saving_report");
      result.execution.metrics = { ...result.execution.metrics, ...this.#timings.get(attemptId)?.values };
      endSave = trace.span("saving_report");
      reportPath = await this.dependencies.reports.save(this.#state.attemptsById[attemptId], first, prepared, result);
      endSave();
    }
    catch (error) {
      endSave?.("failed");
      if (result.cleanupPending) this.#pendingCleanup = prepared.cleanup;
      else { const endCleanup = trace.span("workspace_cleanup"); await prepared.cleanup().then(() => endCleanup(), () => endCleanup("failed")); }
      throw error;
    }
    const accepted = result;
    try { await this.#mutate((draft) => {
      const attempt = draft.attemptsById[attemptId];
      if (!attempt || signal.aborted || attempt.status !== "reviewing") throw reviewError("REVIEW_CANCELLED", "登记结果前收到停止请求；孤立文件不可发布。");
      attempt.reportPath = reportPath;
      attempt.result = accepted.submission.completion === "incomplete" ? "partial" : accepted.findings.length === 0 ? "pass" : "findings";
      attempt.findings = accepted.findings.map((finding, index) => ({ ordinal: index + 1, severity: finding.severity, body: finding.body, structured: finding.structured, status: "pending" }));
      attempt.warnings = [...accepted.execution.warnings];
      attempt.status = attempt.findings.length === 0 ? "completed" : "awaiting_confirmation";
      attempt.phase = undefined;
      attempt.completedAt = this.#now().toISOString();
      attempt.reviewFinishedAt = attempt.completedAt;
    }); } catch (error) {
      if (result.cleanupPending) this.#pendingCleanup = prepared.cleanup;
      else { const endCleanup = trace.span("workspace_cleanup"); await prepared.cleanup().then(() => endCleanup(), () => endCleanup("failed")); }
      throw error;
    }
    trace.emit("report.visible", { result: this.#state.attemptsById[attemptId].result });
    this.#timePhase(attemptId, "cleaning_up");
    if (result.cleanupPending) {
      this.#pendingCleanup = prepared.cleanup;
      await this.#pauseQueue(reviewError("OPENCODE_CLEANUP_FAILED", "进程退出未确认，结果已保存。"));
    } else {
      const endCleanup = trace.span("workspace_cleanup");
      try { await prepared.cleanup(); endCleanup(); }
      catch (error) {
        endCleanup("failed");
        const warning = "工作区清理失败，已保存结果仍可使用：" + String(error);
        this.#warnings.push(warning);
        await this.#mutate(draft => { draft.attemptsById[attemptId].warnings = [...(draft.attemptsById[attemptId].warnings ?? []), warning]; })
          .catch(error => this.#pauseQueue(this.#error(error, "保存清理警告")));
      }
    }
    const completed = this.#state.attemptsById[attemptId];
    this.#info(this.#context(completed), completed.result === "partial" ? `Review partially completed with ${completed.findings.length} verified Findings; report saved.` : completed.findings.length === 0
      ? "Review completed with PASS; report saved and no comments created."
      : `Review completed with ${completed.findings.length} Finding${completed.findings.length === 1 ? "" : "s"}; awaiting explicit publication selection.`);
  }

  async #phase(attemptId: string, phase: ReviewPhase, update?: (attempt: ReviewAttempt) => void): Promise<void> {
    this.#timePhase(attemptId, phase);
    await this.#mutate((draft) => {
      const attempt = draft.attemptsById[attemptId];
      if (!attempt) throw new Error(`Missing attempt ${attemptId}.`);
      if (attempt.status === "stopping") throw new AppError({
        code: "REVIEW_CANCELLED",
        message: "检视已停止。",
        reason: "attempt 已进入 stopping。",
        impact: "本次 attempt 不保存可发布结果。",
        nextStep: "如仍需检视，请手动重新检视。",
        technical: "Review phase transition observed stopping status.",
      });
      attempt.phase = phase;
      update?.(attempt);
    });
  }

  #timePhase(attemptId: string, phase: ReviewPhase): void {
    const timing = this.#timings.get(attemptId);
    if (timing) {
      const elapsed = Date.now() - timing.since;
      timing.values[timing.phase] = (timing.values[timing.phase] ?? 0) + elapsed;
      this.#info(this.#context(this.#state.attemptsById[attemptId]), `Phase ${timing.phase} elapsedMs=${elapsed}.`);
      timing.phase = phase; timing.since = Date.now();
    }
  }

  async decideFinding(attemptId: string, ordinal: number, decision: "dismissed" | "pending"): Promise<AppStateView> {
    this.#assertOperational();
    const { attempt } = findingState.checkDecision(this.#state, attemptId, ordinal, decision);
    const now = this.#now().toISOString();
    await this.#mutate(draft => findingState.decide(draft, attemptId, ordinal, decision, now));
    this.#info(
      { ...this.#context(attempt), findingOrdinal: ordinal },
      decision === "dismissed" ? "Finding marked as not to be published." : "Dismissed Finding restored to pending.",
    );
    return this.snapshot();
  }

  async publishFinding(attemptId: string, ordinal: number): Promise<AppStateView> {
    this.#assertOperational();
    const { attempt, finding: selected } = findingState.checkPublication(this.#state, attemptId, ordinal, this.#removingProjects);
    const batchId = this.#id();
    const startedAt = this.#now().toISOString();
    this.#info({ ...this.#context(attempt), findingOrdinal: ordinal }, "Preparing to publish one Finding.");
    this.#assertOperational();
    await this.#mutate(draft => findingState.beginPublication(draft, attemptId, ordinal, batchId, startedAt, this.#removingProjects));
    try {
      const outcome = await this.dependencies.codeHub.createComment(attempt.projectId, attempt.mrIid, selected.body, selected.severity);
      if (outcome.kind === "success") {
        await this.#mutate(draft => findingState.finishPublication(draft, attemptId, ordinal, batchId,
          { kind: "success", commentId: outcome.comment.comment_id, publishedAt: this.#now().toISOString() }, this.#now().toISOString()));
        this.#info({ ...this.#context(attempt), findingOrdinal: ordinal }, "Finding comment published and persisted.");
        return this.snapshot();
      }
      const error = this.dependencies.logger.safeError(outcome.error);
      await this.#mutate(draft => findingState.finishPublication(draft, attemptId, ordinal, batchId,
        { kind: outcome.kind === "unknown" ? "unknown" : "failed", error }, this.#now().toISOString()));
      throw outcome.error;
    } catch (error) {
      const appError = this.#error(error, "Finding 发送");
      if (findingState.isActivePublication(this.#state, attemptId, batchId)) {
        const failureView = this.dependencies.logger.safeError(appError);
        await this.#mutate(draft => findingState.finishPublication(draft, attemptId, ordinal, batchId,
          { kind: "unknown", error: failureView }, this.#now().toISOString())).catch(() => undefined);
      }
      await this.#recordDiagnostic("Finding publication", { ...this.#context(attempt), findingOrdinal: ordinal }, appError);
      this.#logError({ ...this.#context(attempt), findingOrdinal: ordinal }, appError);
      throw appError;
    }
  }

  async #pauseQueue(error: AppError): Promise<void> {
    const safe = this.dependencies.logger.safeError(error);
    // Pause in memory even when persistence itself is unavailable.
    this.#state.queuePaused = safe;
    this.#viewRevision++;
    await this.#mutate(draft => { draft.queuePaused = safe; }).catch(() => undefined);
  }

  async resumeQueue(): Promise<AppStateView> {
    if (!this.#state.queuePaused && !this.#fatalError) return this.snapshot();
    if (this.#resuming) throw conflictError("QUEUE_RESUMING", "正在重试清理。", "等待完成。");
    this.#resuming = true;
    try {
      await this.#reviewWorker;
      await this.dependencies.reviewer.retryCleanup?.();
      await checkWorkspaceProcesses(this.dependencies.paths.workspaces);
      await this.#pendingCleanup?.();
      this.#pendingCleanup = null;
      await this.#mutate(draft => {
        if (draft.activeReviewAttemptId) {
          const interrupted = draft.attemptsById[draft.activeReviewAttemptId];
          if (interrupted && ACTIVE_REVIEW_STATUSES.includes(interrupted.status)) {
            interrupted.status = "review_failed";
            interrupted.phase = undefined;
            interrupted.error = draft.queuePaused;
          }
        }
        draft.queuePaused = undefined; draft.activeReviewAttemptId = null;
      });
      this.#fatalError = null;
      this.#kickReviewWorker();
      return this.snapshot();
    } finally { this.#resuming = false; }
  }

  async shutdown(): Promise<void> {
    this.#activeReviewController?.abort(new Error("ReviewX is shutting down."));
    await this.#reviewWorker?.catch(() => undefined);
  }

  async waitForIdle(): Promise<void> {
    await this.#refreshPromise?.catch(() => undefined);
    await this.#reviewWorker?.catch(() => undefined);
  }

  #assertOperational(): void {
    if (this.#fatalError) throw new AppError({
      code: this.#fatalError.code,
      message: this.#fatalError.message,
      reason: this.#fatalError.cause,
      impact: this.#fatalError.impact,
      nextStep: this.#fatalError.nextStep,
      technical: this.#fatalError.technicalDetails,
      httpStatus: 503,
    });
  }

  async #mutate(operation: (draft: PersistentState) => void | Promise<void>): Promise<void> {
    let updated: PersistentState;
    try { updated = await this.dependencies.store.mutate(operation); }
    catch (error) {
      if (isAppError(error) && error.code.startsWith("STATE_")) this.#fatalError = this.dependencies.logger.safeError(error);
      throw error;
    }
    if (updated.revision >= this.#state.revision) {
      this.#state = updated;
      this.#viewRevision = Math.max(this.#viewRevision + 1, updated.revision);
      for (const id of this.#rules.keys()) {
        const status = updated.attemptsById[id]?.status;
        if (status && !ACTIVE_REVIEW_STATUSES.includes(status)) this.#rules.delete(id);
      }
    }
  }

  #context(attempt: ReviewAttempt) {
    const project = this.#state.projectsById[attempt.projectId];
    return {
      projectId: attempt.projectId,
      projectName: project?.name,
      mrIid: attempt.mrIid,
      mrTitle: attempt.mrTitle,
      attemptId: attempt.id,
    };
  }

  #error(error: unknown, operation: string): AppError {
    return isAppError(error) ? error : unexpectedError(error, operation);
  }

  async #recordDiagnostic(
    operation: string,
    context: Parameters<Logger["error"]>[0],
    error: AppError,
  ): Promise<void> {
    const recordContext = {
      ...(context.projectId ? { projectId: context.projectId } : {}),
      ...(context.mrIid ? { mrIid: context.mrIid } : {}),
      ...(context.attemptId ? { attemptId: context.attemptId } : {}),
      ...(context.findingOrdinal !== undefined ? { findingOrdinal: context.findingOrdinal } : {}),
    };
    await this.#mutate((draft) => {
      draft.diagnostics.push({
        id: this.#id(),
        at: this.#now().toISOString(),
        operation,
        context: recordContext,
        error: this.dependencies.logger.safeError(error),
      });
    }).catch(() => undefined);
  }

  #info(context: Parameters<Logger["info"]>[0], message: string): void {
    try {
      this.dependencies.logger.info(context, message);
    } catch {
      // Logger failure is exposed as a warning without invalidating review results.
    }
  }

  #logError(context: Parameters<Logger["error"]>[0], error: AppError): void {
    try {
      this.dependencies.logger.error(context, error);
    } catch {
      // Logger failure is exposed as a warning without invalidating review results.
    }
  }
}
