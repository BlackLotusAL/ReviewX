export const severityValues = ["fatal", "major", "minor", "suggestion"] as const;
export type Severity = (typeof severityValues)[number];

export const attemptStatusValues = [
  "queued",
  "reviewing",
  "stopping",
  "stopped",
  "review_failed",
  "awaiting_confirmation",
  "publishing",
  "completed",
  "publish_failed",
  "archived",
] as const;
export type AttemptStatus = (typeof attemptStatusValues)[number];

export const findingStatusValues = [
  "pending",
  "published",
  "dismissed",
  "failed",
  "unknown",
  "not_attempted",
  "archived",
] as const;
export type FindingStatus = (typeof findingStatusValues)[number];

export const reviewPhaseValues = [
  "queued",
  "loading_mr",
  "preparing_git",
  "verifying_mr",
  "running_opencode",
  "saving_report",
  "cleaning_up",
] as const;
export type ReviewPhase = (typeof reviewPhaseValues)[number];

export interface SafeErrorView {
  code: string;
  message: string;
  cause: string;
  impact: string;
  nextStep: string;
  technicalDetails: string;
  stderr?: string;
  stack?: string;
}

export interface DiagnosticRecord {
  id: string;
  at: string;
  operation: string;
  context: {
    projectId?: string;
    mrIid?: string;
    attemptId?: string;
    findingOrdinal?: number;
  };
  error: SafeErrorView;
}

export interface ProjectRecord {
  id: string;
  name: string;
  cloneUrl: string;
  addedAt: string;
  updatedAt: string;
}

export interface MergeRequestSnapshot {
  projectId: string;
  iid: string;
  title: string;
  state: string;
  updatedAt: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl?: string;
}

export interface ProjectSnapshot {
  refreshedAt: string;
  mergeRequests: MergeRequestSnapshot[];
}

export interface StoredFinding {
  ordinal: number;
  severity: Severity;
  body: string;
  status: FindingStatus;
  batchId?: string;
  publishedAt?: string;
  dismissedAt?: string;
  commentId?: string;
  error?: SafeErrorView;
}

export interface PublishBatch {
  id: string;
  selectedOrdinals: number[];
  currentOrdinal?: number;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  error?: SafeErrorView;
}

export interface ReviewAttempt {
  id: string;
  projectId: string;
  mrIid: string;
  mrTitle: string;
  requestedUpdatedAt: string;
  updatedAt?: string;
  sourceBranch?: string;
  targetBranch?: string;
  sourceSha?: string;
  targetSha?: string;
  status: AttemptStatus;
  phase?: ReviewPhase;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  stoppedAt?: string;
  archivedAt?: string;
  archivedFromStatus?: AttemptStatus;
  reportPath?: string;
  result?: "pass" | "findings";
  findings: StoredFinding[];
  publishBatches: PublishBatch[];
  error?: SafeErrorView;
}

export interface RefreshOperation {
  status: "idle" | "refreshing" | "failed";
  startedAt?: string;
  completedAt?: string;
  currentProjectId?: string;
  error?: SafeErrorView;
}

export interface ActivePublishBatchRef {
  attemptId: string;
  batchId: string;
  currentOrdinal?: number;
}

export interface PersistentState {
  version: 1;
  revision: number;
  registeredProjectIds: string[];
  projectsById: Record<string, ProjectRecord>;
  snapshotsByProjectId: Record<string, ProjectSnapshot>;
  attemptsById: Record<string, ReviewAttempt>;
  attemptIdsByMr: Record<string, string[]>;
  reviewQueue: string[];
  activeReviewAttemptId: string | null;
  activePublishBatch: ActivePublishBatchRef | null;
  refreshOperation: RefreshOperation;
  diagnostics: DiagnosticRecord[];
}

export type MrDisplayStatus = "unreviewed" | AttemptStatus;
export type MrPrimaryAction = "start" | "stop" | "rereview" | null;

export interface MrRowView extends MergeRequestSnapshot {
  status: MrDisplayStatus;
  phase?: ReviewPhase;
  queuePosition?: number;
  latestAttemptId?: string;
  latestAttemptUpdatedAt?: string;
  primaryAction: MrPrimaryAction;
  error?: SafeErrorView;
}

export interface ProjectView {
  id: string;
  name: string;
  removing: boolean;
  refreshedAt?: string;
  mergeRequests: MrRowView[];
}

export interface AppStateView {
  revision: number;
  refreshOperation: RefreshOperation;
  publicationBusy: boolean;
  publicationProjectId?: string;
  fatalError: SafeErrorView | null;
  projects: ProjectView[];
  currentLogUrl: string;
}

export interface AttemptView extends Omit<ReviewAttempt, "reportPath"> {
  reportUrl?: string;
}

export interface MrDetailView {
  project: { id: string; name: string; registered: boolean };
  mergeRequest: MergeRequestSnapshot;
  attempts: AttemptView[];
}

export interface ReviewerFinding {
  severity: Severity;
  body: string;
}

export interface ReviewerResult {
  findings: ReviewerFinding[];
}
