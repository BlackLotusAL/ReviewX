import type { AttemptStatus, PersistentState, ReviewAttempt, SafeErrorView } from "@/src/shared/types";
import { conflictError, notFoundError, validationError } from "../errors";

const failedStatuses = new Set(["failed", "unknown", "not_attempted"]);

function settleFindingDecisions(attempt: ReviewAttempt, now: string): void {
  if (attempt.findings.some((finding) => finding.status === "pending")) {
    attempt.status = "awaiting_confirmation";
    attempt.error = undefined;
    return;
  }
  const failed = attempt.findings.find((finding) => failedStatuses.has(finding.status));
  attempt.status = failed ? "publish_failed" : "completed";
  attempt.completedAt = now;
  attempt.error = failed?.error ?? (failed ? attempt.error : undefined);
}

function findingIn(attempt: ReviewAttempt, ordinal: number) {
  const finding = attempt.findings.find(item => item.ordinal === ordinal);
  if (!finding) throw validationError(`Finding ${ordinal} 不存在。`);
  return finding;
}

function availableAttempt(state: PersistentState, attemptId: string, ordinal: number) {
  if (state.activePublishBatch) throw conflictError("PUBLICATION_BUSY", "已有评论正在发送。", "等待当前发送结束。");
  if (!Number.isInteger(ordinal) || ordinal <= 0) throw validationError("Finding 序号必须是正整数。");
  const attempt = state.attemptsById[attemptId];
  if (!attempt) throw notFoundError("找不到该 attempt。");
  return attempt;
}

function isLatest(state: PersistentState, attempt: ReviewAttempt): boolean {
  return state.attemptIdsByMr[`${attempt.projectId}:${attempt.mrIid}`]?.at(-1) === attempt.id;
}

export function checkDecision(state: PersistentState, attemptId: string, ordinal: number, decision: "dismissed" | "pending") {
  const attempt = availableAttempt(state, attemptId, ordinal);
  if (!isLatest(state, attempt) || !(["awaiting_confirmation", "completed", "publish_failed"] as AttemptStatus[]).includes(attempt.status)) {
    throw conflictError("ATTEMPT_NOT_ACTIONABLE", "该 attempt 当前不可处理。", "选择最新 attempt，或重新检视。");
  }
  const finding = findingIn(attempt, ordinal);
  if (decision === "dismissed" && finding.status !== "pending") throw validationError(`Finding ${ordinal} 不再是待处理状态。`);
  if (decision === "pending" && finding.status !== "dismissed") throw validationError(`Finding ${ordinal} 未被跳过。`);
  return { attempt, finding };
}

// Every mutation validates the transaction's draft again, even after a preflight check.
export function decide(state: PersistentState, attemptId: string, ordinal: number, decision: "dismissed" | "pending", now: string): void {
  const { attempt, finding } = checkDecision(state, attemptId, ordinal, decision);
  finding.status = decision;
  finding.dismissedAt = decision === "dismissed" ? now : undefined;
  settleFindingDecisions(attempt, now);
}

export function checkPublication(state: PersistentState, attemptId: string, ordinal: number, removingProjects: ReadonlySet<string>) {
  const attempt = availableAttempt(state, attemptId, ordinal);
  if (!state.registeredProjectIds.includes(attempt.projectId) || removingProjects.has(attempt.projectId)) {
    throw conflictError("PROJECT_NOT_AVAILABLE", "该 attempt 所属 Project 当前不可发送评论。", "重新添加 Project 或等待移除操作完成。");
  }
  if (!isLatest(state, attempt) || attempt.status !== "awaiting_confirmation") {
    throw conflictError("ATTEMPT_NOT_PUBLISHABLE", "该 attempt 当前不可发送。", "选择最新待处理 attempt，或重新检视。");
  }
  const finding = findingIn(attempt, ordinal);
  if (finding.status !== "pending") throw validationError(`Finding ${ordinal} 不再是待处理状态。`);
  return { attempt, finding };
}

export function beginPublication(state: PersistentState, attemptId: string, ordinal: number, batchId: string, now: string, removingProjects: ReadonlySet<string>): void {
  const { attempt, finding } = checkPublication(state, attemptId, ordinal, removingProjects);
  attempt.status = "publishing";
  attempt.publishBatches.push({ id: batchId, selectedOrdinals: [ordinal], currentOrdinal: ordinal, status: "running", startedAt: now });
  finding.batchId = batchId;
  state.activePublishBatch = { attemptId, batchId, currentOrdinal: ordinal };
}

export function isActivePublication(state: PersistentState, attemptId: string, batchId: string): boolean {
  return state.activePublishBatch?.attemptId === attemptId && state.activePublishBatch.batchId === batchId;
}

type PublicationResult = { kind: "success"; commentId: string; publishedAt: string } | { kind: "failed" | "unknown"; error: SafeErrorView };

export function finishPublication(state: PersistentState, attemptId: string, ordinal: number, batchId: string, result: PublicationResult, now: string): void {
  // An already-recorded failure must not be reclassified by the caller's catch path.
  if (!isActivePublication(state, attemptId, batchId)) return;
  const attempt = state.attemptsById[attemptId];
  const batch = attempt?.publishBatches.find(item => item.id === batchId);
  if (!attempt || !batch) throw new Error("Active publication batch disappeared.");
  const finding = findingIn(attempt, ordinal);
  if (result.kind === "success") {
    finding.status = "published";
    finding.publishedAt = result.publishedAt;
    finding.commentId = result.commentId;
    finding.error = undefined;
    batch.status = "completed";
  } else {
    finding.status = result.kind;
    finding.error = result.error;
    finding.batchId = batchId;
    batch.status = "failed";
    batch.error = result.error;
    attempt.error = result.error;
  }
  batch.completedAt = now;
  batch.currentOrdinal = undefined;
  settleFindingDecisions(attempt, now);
  state.activePublishBatch = null;
}

export function archive(attempt: ReviewAttempt, now: string): void {
  if ((["queued", "reviewing", "stopping", "publishing"] as AttemptStatus[]).includes(attempt.status)) {
    throw conflictError("MR_OPERATION_ACTIVE", "该 MR 已有活动 attempt。", "先等待或停止当前操作。");
  }
  attempt.archivedFromStatus = attempt.status;
  attempt.status = "archived";
  attempt.phase = undefined;
  attempt.archivedAt = now;
  for (const finding of attempt.findings) if (finding.status === "pending") finding.status = "archived";
}

function recoveryError(code: string, message: string): SafeErrorView {
  return { code, message, cause: "ReviewX 上次运行在操作完成前退出。", impact: "未完成的操作不会自动继续或补发。",
    nextStep: "核对当前状态后，由用户手动重新执行需要的操作。", technicalDetails: "Recovered interrupted operation during startup." };
}

export function recoverPublications(state: PersistentState, now: string): boolean {
  let changed = false;
  for (const attempt of Object.values(state.attemptsById)) {
    if (attempt.status !== "publishing") continue;
    const batch = attempt.publishBatches.find(item => item.status === "running");
    if (batch) {
      const current = batch.currentOrdinal ?? state.activePublishBatch?.currentOrdinal;
      for (const ordinal of batch.selectedOrdinals) {
        const finding = attempt.findings.find(item => item.ordinal === ordinal);
        if (!finding || finding.status !== "pending") continue;
        finding.batchId = batch.id;
        if (current !== undefined && ordinal === current) {
          finding.status = "unknown";
          finding.error = recoveryError("PUBLISH_RESULT_UNKNOWN", "评论进程中断，无法确认该 Finding 是否已发布。");
        } else finding.status = "not_attempted";
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
  if (state.activePublishBatch !== null) { state.activePublishBatch = null; changed = true; }
  return changed;
}
