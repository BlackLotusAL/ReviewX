import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  attemptStatusValues,
  findingStatusValues,
  reviewPhaseValues,
  severityValues,
  type PersistentState,
  type SafeErrorView,
} from "@/src/shared/types";
import { AppError } from "./errors";
import { withFileLock } from "./file-lock";
import { settleFindingDecisions } from "./finding-state";
import type { DataPaths } from "./paths";
import { credentialFreeHttpsUrlSchema } from "./schemas";

const positiveId = z.string().regex(/^[1-9]\d*$/u);
const errorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  cause: z.string(),
  impact: z.string(),
  nextStep: z.string(),
  technicalDetails: z.string(),
  stderr: z.string().optional(),
  stack: z.string().optional(),
});
const projectSchema = z.strictObject({
  id: positiveId,
  name: z.string().min(1),
  cloneUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }, "clone URL must be credential-free HTTPS"),
  addedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
const mrSchema = z.strictObject({
  projectId: positiveId,
  iid: positiveId,
  title: z.string().min(1),
  state: z.string().min(1),
  updatedAt: z.string().min(1),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  webUrl: credentialFreeHttpsUrlSchema.optional(),
});
const snapshotSchema = z.strictObject({
  refreshedAt: z.string().min(1),
  mergeRequests: z.array(mrSchema),
});
const findingSchema = z.strictObject({
  ordinal: z.number().int().positive(),
  severity: z.enum(severityValues),
  body: z.string().min(1),
  status: z.enum(findingStatusValues),
  batchId: z.string().min(1).optional(),
  publishedAt: z.string().min(1).optional(),
  dismissedAt: z.string().min(1).optional(),
  commentId: z.string().min(1).optional(),
  error: errorSchema.optional(),
});
const batchSchema = z.strictObject({
  id: z.string().min(1),
  selectedOrdinals: z.array(z.number().int().positive()),
  currentOrdinal: z.number().int().positive().optional(),
  status: z.enum(["running", "completed", "failed"]),
  startedAt: z.string().min(1),
  completedAt: z.string().min(1).optional(),
  error: errorSchema.optional(),
});
const attemptSchema = z.strictObject({
  id: z.string().min(1),
  projectId: positiveId,
  mrIid: positiveId,
  mrTitle: z.string().min(1),
  requestedUpdatedAt: z.string().min(1),
  updatedAt: z.string().min(1).optional(),
  sourceBranch: z.string().min(1).optional(),
  targetBranch: z.string().min(1).optional(),
  sourceSha: z.string().min(1).optional(),
  targetSha: z.string().min(1).optional(),
  status: z.enum(attemptStatusValues),
  phase: z.enum(reviewPhaseValues).optional(),
  createdAt: z.string().min(1),
  startedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional(),
  stoppedAt: z.string().min(1).optional(),
  archivedAt: z.string().min(1).optional(),
  archivedFromStatus: z.enum(attemptStatusValues).optional(),
  reportPath: z.string().min(1).optional(),
  result: z.enum(["pass", "findings"]).optional(),
  findings: z.array(findingSchema),
  publishBatches: z.array(batchSchema),
  error: errorSchema.optional(),
});
const refreshSchema = z.strictObject({
  status: z.enum(["idle", "refreshing", "failed"]),
  startedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional(),
  currentProjectId: positiveId.optional(),
  error: errorSchema.optional(),
});
const diagnosticSchema = z.strictObject({
  id: z.string().min(1),
  at: z.string().min(1),
  operation: z.string().min(1),
  context: z.strictObject({
    projectId: positiveId.optional(),
    mrIid: positiveId.optional(),
    attemptId: z.string().min(1).optional(),
    findingOrdinal: z.number().int().positive().optional(),
  }),
  error: errorSchema,
});
const persistentStateSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  registeredProjectIds: z.array(positiveId),
  projectsById: z.record(z.string(), projectSchema),
  snapshotsByProjectId: z.record(z.string(), snapshotSchema),
  attemptsById: z.record(z.string(), attemptSchema),
  attemptIdsByMr: z.record(z.string(), z.array(z.string().min(1))),
  reviewQueue: z.array(z.string().min(1)),
  activeReviewAttemptId: z.string().min(1).nullable(),
  activePublishBatch: z.strictObject({
    attemptId: z.string().min(1),
    batchId: z.string().min(1),
    currentOrdinal: z.number().int().positive().optional(),
  }).nullable(),
  refreshOperation: refreshSchema,
  diagnostics: z.array(diagnosticSchema),
});

export function emptyState(): PersistentState {
  return {
    version: 1,
    revision: 0,
    registeredProjectIds: [],
    projectsById: {},
    snapshotsByProjectId: {},
    attemptsById: {},
    attemptIdsByMr: {},
    reviewQueue: [],
    activeReviewAttemptId: null,
    activePublishBatch: null,
    refreshOperation: { status: "idle" },
    diagnostics: [],
  };
}

function recoveryError(code: string, message: string): SafeErrorView {
  return {
    code,
    message,
    cause: "ReviewX 上次运行在操作完成前退出。",
    impact: "未完成的操作不会自动继续或补发。",
    nextStep: "核对当前状态后，由用户手动重新执行需要的操作。",
    technicalDetails: "Recovered interrupted operation during startup.",
  };
}

function recoverInterrupted(state: PersistentState, now: string): boolean {
  let changed = false;
  for (const attempt of Object.values(state.attemptsById)) {
    if (["queued", "reviewing", "stopping"].includes(attempt.status)) {
      attempt.status = "stopped";
      attempt.phase = undefined;
      attempt.stoppedAt = now;
      attempt.error = undefined;
      changed = true;
    }
    if (attempt.status === "publishing") {
      const batch = attempt.publishBatches.find((candidate) => candidate.status === "running");
      if (batch) {
        const current = batch.currentOrdinal ?? state.activePublishBatch?.currentOrdinal;
        for (const ordinal of batch.selectedOrdinals) {
          const finding = attempt.findings.find((candidate) => candidate.ordinal === ordinal);
          if (!finding || finding.status !== "pending") continue;
          finding.batchId = batch.id;
          if (current !== undefined && ordinal === current) {
            finding.status = "unknown";
            finding.error = recoveryError("PUBLISH_RESULT_UNKNOWN", "评论进程中断，无法确认该 Finding 是否已发布。");
          } else {
            finding.status = "not_attempted";
          }
        }
        batch.status = "failed";
        batch.completedAt = now;
        batch.error = recoveryError("PUBLISH_INTERRUPTED", "发布批次在完成前中断。");
      }
      attempt.phase = undefined;
      attempt.error = recoveryError("PUBLISH_INTERRUPTED", "发布批次在完成前中断。");
      settleFindingDecisions(attempt, now);
      changed = true;
    }
  }
  if (state.reviewQueue.length > 0 || state.activeReviewAttemptId !== null) {
    state.reviewQueue = [];
    state.activeReviewAttemptId = null;
    changed = true;
  }
  if (state.activePublishBatch !== null) {
    state.activePublishBatch = null;
    changed = true;
  }
  if (state.refreshOperation.status === "refreshing") {
    state.refreshOperation = {
      status: "failed",
      completedAt: now,
      error: recoveryError("REFRESH_INTERRUPTED", "MR 刷新在完成前中断。"),
    };
    changed = true;
  }
  return changed;
}

export class StateStore {
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly paths: DataPaths) {}

  async initialize(now = new Date().toISOString()): Promise<PersistentState> {
    return this.#serialize(async () => withFileLock(this.paths.stateLockFile, async () => {
      const loaded = await this.#load();
      const changed = recoverInterrupted(loaded, now);
      if (changed) loaded.revision += 1;
      if (changed || !(await this.#exists())) await this.#save(loaded);
      return loaded;
    }));
  }

  async read(): Promise<PersistentState> {
    return this.#load();
  }

  async mutate(operation: (draft: PersistentState) => void | Promise<void>): Promise<PersistentState> {
    return this.#serialize(async () => withFileLock(this.paths.stateLockFile, async () => {
      const current = await this.#load();
      const draft = structuredClone(current);
      await operation(draft);
      draft.revision = current.revision + 1;
      const parsed = persistentStateSchema.safeParse(draft);
      if (!parsed.success) {
        throw new AppError({
          code: "STATE_VALIDATION_ERROR",
          message: "ReviewX 拒绝保存无效状态。",
          reason: "内部状态不符合持久化结构。",
          impact: "本次状态变更未写入磁盘。",
          nextStep: "查看日志并修复 ReviewX 后重试。",
          technical: parsed.error.message,
        });
      }
      await this.#save(parsed.data);
      return parsed.data;
    }));
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #exists(): Promise<boolean> {
    try {
      await readFile(this.paths.stateFile);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async #load(): Promise<PersistentState> {
    let text: string;
    try {
      text = await readFile(this.paths.stateFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw new AppError({
        code: "STATE_READ_ERROR",
        message: "ReviewX 无法读取本地状态。",
        reason: "状态文件不可读。",
        impact: "ReviewX 无法安全继续。",
        nextStep: "检查 state.json 权限与磁盘状态后重启。",
        technical: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
    try {
      return persistentStateSchema.parse(JSON.parse(text) as unknown);
    } catch (error) {
      throw new AppError({
        code: "STATE_PARSE_ERROR",
        message: "ReviewX 无法解析本地状态。",
        reason: "state.json 已损坏或版本不受支持。",
        impact: "ReviewX 无法安全继续，也不会覆盖现有状态。",
        nextStep: "备份并人工修复 state.json 后重启。",
        technical: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  }

  async #save(state: PersistentState): Promise<void> {
    await mkdir(dirname(this.paths.stateFile), { recursive: true });
    const temporary = `${this.paths.stateFile}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.paths.stateFile);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new AppError({
        code: "STATE_WRITE_ERROR",
        message: "ReviewX 无法保存本地状态。",
        reason: "原子状态替换失败。",
        impact: "本次状态变更未确认，任何外部写入不会自动重试。",
        nextStep: "检查磁盘空间和 ReviewX 数据目录权限后重试。",
        technical: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  }
}
