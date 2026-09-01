import { randomUUID } from "node:crypto";
import { relative, sep } from "node:path";
import type {
  AppStateView,
  AttemptStatus,
  AttemptView,
  MergeRequestSnapshot,
  MrDetailView,
  MrRowView,
  PersistentState,
  ProjectView,
  ReviewAttempt,
  ReviewPhase,
  SafeErrorView,
} from "@/src/shared/types";
import { CodeHubClient, type CodeHubPort } from "./codehub";
import { AppError, conflictError, isAppError, notFoundError, unexpectedError, validationError } from "./errors";
import { GitPreparer, type GitPreparerPort, type PreparedReview } from "./git";
import { Logger, createLogFile } from "./logger";
import { OpenCodeReviewer, type ReviewerPort } from "./opencode";
import { ensureDataPaths, resolveDataPaths, type DataPaths } from "./paths";
import { readContainedFile, ReportStore } from "./report-store";
import { StateStore } from "./state-store";

const ACTIVE_REVIEW_STATUSES: AttemptStatus[] = ["queued", "reviewing", "stopping"];

function mrKey(projectId: string, mrIid: string): string {
  return `${projectId}:${mrIid}`;
}

function ensurePositiveId(value: string, label: string): void {
  if (!/^[1-9]\d*$/u.test(value)) throw validationError(`${label} 必须是正整数。`);
}

function assertOpen(mr: MergeRequestSnapshot): void {
  if (mr.state.toLowerCase() !== "open") throw new AppError({
    code: "MR_NOT_OPEN",
    message: `MR !${mr.iid} 已不再是 open 状态。`,
    reason: `CodeHub mr view 返回状态 ${mr.state}。`,
    impact: "Git 和 OpenCode 未启动，本次 attempt 失败。",
    nextStep: "手动刷新 MR 列表后选择仍然 open 的 MR。",
    technical: "MR state was not open at review time.",
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
}

export class ReviewXRuntime {
  #state!: PersistentState;
  #viewRevision = 0;
  #fatalError: SafeErrorView | null = null;
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
      this.#fatalError = dependencies.logger.safeError(error);
      this.#viewRevision += 1;
      if (this.#state) void this.#recordDiagnostic("Session logging", {}, error);
    });
  }

  async initialize(): Promise<this> {
    this.#state = await this.dependencies.store.initialize(this.#now().toISOString());
    this.#viewRevision = this.#state.revision;
    this.#info({}, "ReviewX state loaded and interrupted operations recovered.");
    this.#assertOperational();
    this.#kickReviewWorker();
    return this;
  }

  snapshot(): AppStateView {
    const projects: ProjectView[] = this.#state.registeredProjectIds.map((projectId) => {
      const project = this.#state.projectsById[projectId];
      if (!project) throw new Error(`Registered Project ${projectId} has no record.`);
      const snapshot = this.#state.snapshotsByProjectId[projectId];
      return {
        id: project.id,
        name: project.name,
        removing: this.#removingProjects.has(projectId),
        refreshedAt: snapshot?.refreshedAt,
        mergeRequests: (snapshot?.mergeRequests ?? []).map((mr) => this.#mrRow(mr)),
      };
    });
    return {
      revision: this.#viewRevision,
      refreshOperation: structuredClone(this.#state.refreshOperation),
      publicationBusy: this.#state.activePublishBatch !== null,
      publicationProjectId: this.#state.activePublishBatch
        ? this.#state.attemptsById[this.#state.activePublishBatch.attemptId]?.projectId
        : undefined,
      fatalError: this.#fatalError ? structuredClone(this.#fatalError) : null,
      projects,
      currentLogUrl: "/api/logs/current",
    };
  }

  #mrRow(mr: MergeRequestSnapshot): MrRowView {
    const ids = this.#state.attemptIdsByMr[mrKey(mr.projectId, mr.iid)] ?? [];
    const latestId = ids.at(-1);
    const latest = latestId ? this.#state.attemptsById[latestId] : undefined;
    if (!latest) return { ...mr, status: "unreviewed", primaryAction: "start" };
    const action = (["queued", "reviewing"] as AttemptStatus[]).includes(latest.status)
      ? "stop"
      : (["stopping", "publishing"] as AttemptStatus[]).includes(latest.status)
        ? null
        : "rereview";
    const queueIndex = this.#state.reviewQueue.indexOf(latest.id);
    return {
      ...mr,
      status: latest.status,
      phase: latest.phase,
      queuePosition: queueIndex >= 0 ? queueIndex + 1 : undefined,
      latestAttemptId: latest.id,
      latestAttemptUpdatedAt: latest.updatedAt,
      primaryAction: action,
      error: latest.error,
    };
  }

  async getMrDetail(projectId: string, mrIid: string): Promise<MrDetailView> {
    ensurePositiveId(projectId, "Project ID");
    ensurePositiveId(mrIid, "MR IID");
    const project = this.#state.projectsById[projectId];
    if (!project) throw notFoundError("找不到该 Project 的历史记录。");
    const attempts = (this.#state.attemptIdsByMr[mrKey(projectId, mrIid)] ?? [])
      .map((id) => this.#state.attemptsById[id])
      .filter((attempt): attempt is ReviewAttempt => Boolean(attempt));
    const current = this.#state.snapshotsByProjectId[projectId]?.mergeRequests.find((mr) => mr.iid === mrIid);
    const latest = attempts.at(-1);
    const mergeRequest = current ?? (latest?.updatedAt && latest.sourceBranch && latest.targetBranch ? {
      projectId,
      iid: mrIid,
      title: latest.mrTitle,
      state: "historical",
      updatedAt: latest.updatedAt,
      sourceBranch: latest.sourceBranch,
      targetBranch: latest.targetBranch,
    } : undefined);
    if (!mergeRequest) throw notFoundError("找不到该 MR 的快照或 attempt 历史。");
    const views: AttemptView[] = [...attempts].reverse().map((attempt) => {
      const { reportPath, ...view } = structuredClone(attempt);
      return { ...view, reportUrl: reportPath ? `/api/reports/${encodeURIComponent(attempt.id)}` : undefined };
    });
    return {
      project: { id: project.id, name: project.name, registered: this.#state.registeredProjectIds.includes(projectId) },
      mergeRequest: structuredClone(mergeRequest),
      attempts: views,
    };
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
      throw conflictError("PROJECT_PUBLISHING", "该 Project 正在发布评论，暂时不能移除。", "等待当前发布批次结束后重试。");
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
          throw conflictError("PROJECT_PUBLISHING", "该 Project 正在发布评论，暂时不能移除。", "等待当前发布批次结束后重试。");
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
    const key = mrKey(projectId, mrIid);
    const now = this.#now().toISOString();
    const attemptId = this.#id();
    this.#info({ projectId, projectName: project.name, mrIid, mrTitle: mr.title, attemptId }, "Appending a review attempt to the global FIFO queue.");
    this.#assertOperational();
    await this.#mutate((draft) => {
      const ids = draft.attemptIdsByMr[key] ?? [];
      const previousId = ids.at(-1);
      const previous = previousId ? draft.attemptsById[previousId] : undefined;
      if (previous && (ACTIVE_REVIEW_STATUSES.includes(previous.status) || previous.status === "publishing")) {
        throw conflictError("MR_OPERATION_ACTIVE", "该 MR 已有活动 attempt。", "先等待或停止当前操作。");
      }
      if (previous) {
        previous.archivedFromStatus = previous.status;
        previous.status = "archived";
        previous.phase = undefined;
        previous.archivedAt = now;
        for (const finding of previous.findings) if (finding.status === "pending") finding.status = "archived";
      }
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
        publishBatches: [],
      };
      draft.attemptsById[attemptId] = attempt;
      draft.attemptIdsByMr[key] = [...ids, attemptId];
      draft.reviewQueue.push(attemptId);
    });
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
    if (this.#reviewWorker) return;
    this.#reviewWorker = (async () => {
      let failed = false;
      try {
        await this.#reviewLoop();
      } catch (error) {
        failed = true;
        const appError = this.#error(error, "检视 worker");
        await this.#mutate((draft) => {
          const stoppedAt = this.#now().toISOString();
          for (const queuedId of draft.reviewQueue) {
            const queued = draft.attemptsById[queuedId];
            if (queued?.status === "queued") {
              queued.status = "stopped";
              queued.phase = undefined;
              queued.stoppedAt = stoppedAt;
            }
          }
          draft.reviewQueue = [];
          draft.activeReviewAttemptId = null;
        }).catch(() => undefined);
        this.#activeReviewController?.abort(new Error("Review worker failed."));
        this.#activeReviewController = null;
        this.#resolveActiveAttemptDone?.();
        this.#resolveActiveAttemptDone = null;
        this.#activeAttemptDone = null;
        await this.#recordDiagnostic("Review worker", {}, appError);
        this.#logError({}, appError);
      } finally {
        this.#reviewWorker = null;
        if (!failed && this.#state.reviewQueue.length > 0 && this.#state.activeReviewAttemptId === null) this.#kickReviewWorker();
      }
    })();
  }

  async #reviewLoop(): Promise<void> {
    while (this.#state.reviewQueue.length > 0 && this.#state.activeReviewAttemptId === null) {
      let attemptId: string | undefined;
      const controller = new AbortController();
      this.#activeReviewController = controller;
      this.#activeAttemptDone = new Promise<void>((resolve) => { this.#resolveActiveAttemptDone = resolve; });
      try {
        await this.#mutate((draft) => {
          if (this.#fatalError) {
            const stoppedAt = this.#now().toISOString();
            for (const queuedId of draft.reviewQueue) {
              const queued = draft.attemptsById[queuedId];
              if (queued?.status === "queued") {
                queued.status = "stopped";
                queued.phase = undefined;
                queued.stoppedAt = stoppedAt;
              }
            }
            draft.reviewQueue = [];
            return;
          }
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
        if (controller.signal.aborted || ["GIT_CANCELLED", "OPENCODE_CANCELLED"].includes(appError.code)) {
          await this.#mutate((draft) => {
            const target = draft.attemptsById[attemptId!];
            if (!target) return;
            target.status = "stopped";
            target.phase = undefined;
            target.stoppedAt = this.#now().toISOString();
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
              target.error = this.dependencies.logger.safeError(appError);
              for (const finding of target.findings) if (finding.status === "pending") finding.status = "archived";
            }
            for (const queuedId of draft.reviewQueue) {
              const queued = draft.attemptsById[queuedId];
              if (queued?.status === "queued") {
                queued.status = "stopped";
                queued.phase = undefined;
                queued.stoppedAt = this.#now().toISOString();
              }
            }
            draft.reviewQueue = [];
          }).catch(() => undefined);
          await this.#recordDiagnostic("MR review", this.#context(attempt), appError);
          this.#logError(this.#context(attempt), appError);
        }
      } finally {
        await this.#mutate((draft) => {
          if (draft.activeReviewAttemptId === attemptId) draft.activeReviewAttemptId = null;
        }).catch(() => undefined);
        this.#activeReviewController = null;
        this.#resolveActiveAttemptDone?.();
        this.#resolveActiveAttemptDone = null;
        this.#activeAttemptDone = null;
      }
    }
  }

  async #runReview(attemptId: string, signal: AbortSignal): Promise<void> {
    const initialAttempt = this.#state.attemptsById[attemptId];
    if (!initialAttempt) throw new Error(`Missing attempt ${attemptId}.`);
    const project = this.#state.projectsById[initialAttempt.projectId];
    if (!project) throw new Error(`Missing Project ${initialAttempt.projectId}.`);
    this.#info(this.#context(initialAttempt), "Loading the current MR details for this attempt.");
    this.#assertOperational();
    const first = await this.dependencies.codeHub.viewMr(initialAttempt.projectId, initialAttempt.mrIid, initialAttempt.mrTitle, signal);
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
    let resultSaved = false;
    try {
      prepared = await this.dependencies.git.prepare(project, first, signal);
      await this.#phase(attemptId, "verifying_mr", (attempt) => {
        attempt.sourceSha = prepared!.sourceSha;
        attempt.targetSha = prepared!.targetSha;
      });
      const verified = await this.dependencies.codeHub.viewMr(initialAttempt.projectId, initialAttempt.mrIid, first.title, signal);
      assertOpen(verified);
      if (
        verified.updatedAt !== first.updatedAt ||
        verified.sourceBranch !== first.sourceBranch ||
        verified.targetBranch !== first.targetBranch
      ) {
        throw new AppError({
          code: "MR_CHANGED_DURING_PREPARATION",
          message: "MR 在 Git 准备期间发生变化。",
          reason: "updated_at、源分支或目标分支与 attempt 开始时不一致。",
          impact: "OpenCode 未启动，本次 attempt 不保存报告。",
          nextStep: "手动刷新 MR 后重新检视。",
          technical: "MR identity fields changed between the two required mr view calls.",
        });
      }
      await this.#phase(attemptId, "running_opencode");
      this.#info(this.#context(initialAttempt), "Running one read-only OpenCode review invocation.");
      this.#assertOperational();
      const result = await this.dependencies.reviewer.review(initialAttempt.projectId, first, prepared, signal);
      if (signal.aborted) throw new AppError({
        code: "OPENCODE_CANCELLED",
        message: "OpenCode 检视已停止。",
        reason: "收到停止请求。",
        impact: "本次 attempt 不保存可发布结果。",
        nextStep: "如仍需检视，请手动重新检视。",
        technical: "Abort signal observed after OpenCode completion.",
      });
      await this.#phase(attemptId, "saving_report");
      const reportPath = await this.dependencies.reports.save(this.#state.attemptsById[attemptId], first, prepared, result);
      await this.#mutate((draft) => {
        const attempt = draft.attemptsById[attemptId];
        if (!attempt) throw new Error(`Missing attempt ${attemptId}.`);
        attempt.reportPath = reportPath;
        attempt.result = result.findings.length === 0 ? "pass" : "findings";
        attempt.findings = result.findings.map((finding, index) => ({
          ordinal: index + 1,
          severity: finding.severity,
          body: finding.body,
          status: "pending",
        }));
        attempt.phase = "cleaning_up";
      });
      resultSaved = true;
    } finally {
      if (prepared) await prepared.cleanup();
    }
    if (!resultSaved) return;
    if (signal.aborted) throw new AppError({
      code: "REVIEW_CANCELLED",
      message: "检视在完成前被停止。",
      reason: "清理阶段收到停止请求。",
      impact: "已写入的报告不会作为可发布结果展示。",
      nextStep: "如仍需检视，请手动重新检视。",
      technical: "Abort signal observed before publishing review state.",
    });
    await this.#mutate((draft) => {
      const attempt = draft.attemptsById[attemptId];
      if (!attempt) throw new Error(`Missing attempt ${attemptId}.`);
      attempt.status = attempt.findings.length === 0 ? "completed" : "awaiting_confirmation";
      attempt.phase = undefined;
      attempt.completedAt = this.#now().toISOString();
    });
    const completed = this.#state.attemptsById[attemptId];
    this.#info(this.#context(completed), completed.findings.length === 0
      ? "Review completed with PASS; report saved and no comments created."
      : `Review completed with ${completed.findings.length} Finding${completed.findings.length === 1 ? "" : "s"}; awaiting explicit publication selection.`);
  }

  async #phase(attemptId: string, phase: ReviewPhase, update?: (attempt: ReviewAttempt) => void): Promise<void> {
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

  async publishFindings(attemptId: string, ordinals: number[]): Promise<AppStateView> {
    this.#assertOperational();
    if (this.#state.activePublishBatch) throw conflictError("PUBLICATION_BUSY", "已有评论发布批次正在执行。", "等待当前批次结束。");
    if (!Array.isArray(ordinals) || ordinals.length === 0 || ordinals.some((value) => !Number.isInteger(value) || value <= 0)) {
      throw validationError("至少选择一个合法 Finding。");
    }
    const unique = [...new Set(ordinals)];
    if (unique.length !== ordinals.length) throw validationError("Finding 选择中不能包含重复序号。");
    const attempt = this.#state.attemptsById[attemptId];
    if (!attempt) throw notFoundError("找不到该 attempt。");
    if (!this.#state.registeredProjectIds.includes(attempt.projectId) || this.#removingProjects.has(attempt.projectId)) {
      throw conflictError("PROJECT_NOT_AVAILABLE", "该 attempt 所属 Project 当前不可发布。", "重新添加 Project 或等待移除操作完成。");
    }
    const ids = this.#state.attemptIdsByMr[mrKey(attempt.projectId, attempt.mrIid)] ?? [];
    if (ids.at(-1) !== attemptId || attempt.status !== "awaiting_confirmation") {
      throw conflictError("ATTEMPT_NOT_PUBLISHABLE", "该 attempt 当前不可发布。", "选择最新待确认 attempt，或重新检视。");
    }
    const selected = unique.map((ordinal) => {
      const finding = attempt.findings.find((item) => item.ordinal === ordinal);
      if (!finding || finding.status !== "pending") throw validationError(`Finding ${ordinal} 不存在或不再是 pending。`);
      return finding;
    }).sort((left, right) => left.ordinal - right.ordinal);
    const batchId = this.#id();
    const startedAt = this.#now().toISOString();
    this.#info(this.#context(attempt), `Preparing to publish ${selected.length} selected Finding${selected.length === 1 ? "" : "s"} in reviewer order.`);
    this.#assertOperational();
    await this.#mutate((draft) => {
      if (draft.activePublishBatch) throw conflictError("PUBLICATION_BUSY", "已有评论发布批次正在执行。", "等待当前批次结束。");
      const target = draft.attemptsById[attemptId];
      if (!target || target.status !== "awaiting_confirmation") throw conflictError("ATTEMPT_NOT_PUBLISHABLE", "该 attempt 当前不可发布。", "刷新页面后重试。");
      if (!draft.registeredProjectIds.includes(target.projectId) || this.#removingProjects.has(target.projectId)) {
        throw conflictError("PROJECT_NOT_AVAILABLE", "该 attempt 所属 Project 当前不可发布。", "重新添加 Project 或等待移除操作完成。");
      }
      target.status = "publishing";
      target.publishBatches.push({ id: batchId, selectedOrdinals: selected.map((finding) => finding.ordinal), status: "running", startedAt });
      draft.activePublishBatch = { attemptId, batchId };
    });
    let currentOrdinal: number | undefined;
    try {
      for (let index = 0; index < selected.length; index += 1) {
        const ordinal = selected[index].ordinal;
        currentOrdinal = ordinal;
        await this.#mutate((draft) => {
          const target = draft.attemptsById[attemptId];
          const batch = target?.publishBatches.find((item) => item.id === batchId);
          if (!target || !batch || !draft.activePublishBatch) throw new Error("Active publication batch disappeared.");
          batch.currentOrdinal = ordinal;
          draft.activePublishBatch.currentOrdinal = ordinal;
          const finding = target.findings.find((item) => item.ordinal === ordinal);
          if (finding) finding.batchId = batchId;
        });
        const current = this.#state.attemptsById[attemptId].findings.find((finding) => finding.ordinal === ordinal)!;
        const outcome = await this.dependencies.codeHub.createComment(attempt.projectId, attempt.mrIid, current.body, current.severity);
        if (outcome.kind === "success") {
          await this.#mutate((draft) => {
            const finding = draft.attemptsById[attemptId]?.findings.find((item) => item.ordinal === ordinal);
            if (!finding) throw new Error(`Missing Finding ${ordinal}.`);
            finding.status = "published";
            finding.publishedAt = this.#now().toISOString();
            finding.commentId = outcome.comment.comment_id;
            finding.error = undefined;
          });
          this.#info({ ...this.#context(attempt), findingOrdinal: ordinal }, "Finding comment published and persisted.");
          continue;
        }
        const failureView = this.dependencies.logger.safeError(outcome.error);
        await this.#mutate((draft) => {
          const target = draft.attemptsById[attemptId];
          if (!target) throw new Error(`Missing attempt ${attemptId}.`);
          const currentFinding = target.findings.find((item) => item.ordinal === ordinal);
          if (currentFinding) {
            currentFinding.status = outcome.kind === "unknown" ? "unknown" : "failed";
            currentFinding.error = failureView;
            currentFinding.batchId = batchId;
          }
          for (const later of selected.slice(index + 1)) {
            const finding = target.findings.find((item) => item.ordinal === later.ordinal);
            if (finding?.status === "pending") {
              finding.status = "not_attempted";
              finding.batchId = batchId;
            }
          }
          const batch = target.publishBatches.find((item) => item.id === batchId);
          if (batch) {
            batch.status = "failed";
            batch.completedAt = this.#now().toISOString();
            batch.error = failureView;
          }
          target.status = "publish_failed";
          target.completedAt = this.#now().toISOString();
          target.error = failureView;
          draft.activePublishBatch = null;
        });
        throw outcome.error;
      }
      await this.#mutate((draft) => {
        const target = draft.attemptsById[attemptId];
        if (!target) throw new Error(`Missing attempt ${attemptId}.`);
        const batch = target.publishBatches.find((item) => item.id === batchId);
        if (batch) {
          batch.status = "completed";
          batch.completedAt = this.#now().toISOString();
          batch.currentOrdinal = undefined;
        }
        target.status = target.findings.some((finding) => finding.status === "pending") ? "awaiting_confirmation" : "completed";
        target.completedAt = this.#now().toISOString();
        target.error = undefined;
        draft.activePublishBatch = null;
      });
    } catch (error) {
      const appError = this.#error(error, "Finding 发布");
      await this.#recordDiagnostic("Finding publication", { ...this.#context(attempt), findingOrdinal: currentOrdinal }, appError);
      this.#logError({ ...this.#context(attempt), findingOrdinal: currentOrdinal }, appError);
      throw appError;
    }
    this.#info(this.#context(attempt), "Selected Finding publication batch completed.");
    return this.snapshot();
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
    const updated = await this.dependencies.store.mutate(operation);
    if (updated.revision >= this.#state.revision) {
      this.#state = updated;
      this.#viewRevision = Math.max(this.#viewRevision + 1, updated.revision);
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
      // Logger failure handler enters the runtime fatal state.
    }
  }

  #logError(context: Parameters<Logger["error"]>[0], error: AppError): void {
    try {
      this.dependencies.logger.error(context, error);
    } catch {
      // Logger failure handler enters the runtime fatal state.
    }
  }
}

const runtimeSymbol = Symbol.for("reviewx.runtime.promise");
type RuntimeGlobal = typeof globalThis & { [runtimeSymbol]?: Promise<ReviewXRuntime> };

export async function initializeRuntime(paths: DataPaths, logger: Logger): Promise<ReviewXRuntime> {
  const target = globalThis as RuntimeGlobal;
  target[runtimeSymbol] ??= new ReviewXRuntime({
    paths,
    logger,
    store: new StateStore(paths),
    codeHub: new CodeHubClient(process.env),
    git: new GitPreparer(paths, process.env),
    reviewer: new OpenCodeReviewer(process.env),
    reports: new ReportStore(paths),
  }).initialize();
  return target[runtimeSymbol];
}

export async function getRuntime(): Promise<ReviewXRuntime> {
  const target = globalThis as RuntimeGlobal;
  if (!target[runtimeSymbol]) {
    const paths = resolveDataPaths();
    ensureDataPaths(paths);
    const logFile = process.env.REVIEWX_LOG_FILE || createLogFile(paths);
    target[runtimeSymbol] = initializeRuntime(paths, new Logger(logFile, process.env));
  }
  return target[runtimeSymbol];
}

export function installRuntimeForTests(runtime: ReviewXRuntime): void {
  (globalThis as RuntimeGlobal)[runtimeSymbol] = Promise.resolve(runtime);
}
