import type { AppStateView, AttemptStatus, AttemptView, MergeRequestSnapshot, MrDetailView, MrRowView, PersistentState, ProjectView, ReviewAttempt, SafeErrorView } from "@/src/shared/types";
import type { ReviewProgress } from "@/src/shared/review-contract";
import { notFoundError } from "../errors";

interface ViewInput {
  state: PersistentState;
  revision: number;
  removingProjects: ReadonlySet<string>;
  progress: ReadonlyMap<string, ReviewProgress>;
  fatalError: SafeErrorView | null;
}
function mrKey(projectId: string, mrIid: string): string { return `${projectId}:${mrIid}`; }

export function projectAppState(input: ViewInput): AppStateView {
  const projects: ProjectView[] = input.state.registeredProjectIds.map((projectId) => {
    const project = input.state.projectsById[projectId];
    if (!project) throw new Error(`Registered Project ${projectId} has no record.`);
    const snapshot = input.state.snapshotsByProjectId[projectId];
    return {
      id: project.id,
      name: project.name,
      webUrl: project.webUrl,
      removing: input.removingProjects.has(projectId),
      refreshedAt: snapshot?.refreshedAt,
      mergeRequests: (snapshot?.mergeRequests ?? []).map((mr) => projectMrRow(input, mr)),
    };
  });
  return {
    revision: input.revision,
    refreshOperation: structuredClone(input.state.refreshOperation),
    publicationBusy: input.state.activePublishBatch !== null,
    publicationProjectId: input.state.activePublishBatch
      ? input.state.attemptsById[input.state.activePublishBatch.attemptId]?.projectId
      : undefined,
    fatalError: input.fatalError ? structuredClone(input.fatalError) : null,
    projects,
    currentLogUrl: "/api/logs/current",
  };
}

export function projectMrRow(input: ViewInput, mr: MergeRequestSnapshot): MrRowView {
  const ids = input.state.attemptIdsByMr[mrKey(mr.projectId, mr.iid)] ?? [];
  const latestId = ids.at(-1);
  const latest = latestId ? input.state.attemptsById[latestId] : undefined;
  if (!latest) return { ...mr, status: "unreviewed", primaryAction: "start" };
  const action = (["queued", "reviewing"] as AttemptStatus[]).includes(latest.status)
    ? "stop"
    : (["stopping", "publishing"] as AttemptStatus[]).includes(latest.status)
      ? null
      : "rereview";
  const queueIndex = input.state.reviewQueue.indexOf(latest.id);
  return {
    ...mr,
    status: latest.status,
    phase: latest.phase,
    progress: input.progress.get(latest.id),
    queuePosition: queueIndex >= 0 ? queueIndex + 1 : undefined,
    latestAttemptId: latest.id,
    latestAttemptUpdatedAt: latest.updatedAt,
    reviewStartedAt: latest.startedAt,
    reviewFinishedAt: latest.reviewFinishedAt,
    primaryAction: action,
    error: latest.error,
  };
}

export function selectMrDetail(state: PersistentState, projectId: string, mrIid: string) {
  const project = state.projectsById[projectId];
  if (!project) throw notFoundError("找不到该 Project 的历史记录。");
  const attempts = (state.attemptIdsByMr[mrKey(projectId, mrIid)] ?? [])
    .map((id) => state.attemptsById[id])
    .filter((attempt): attempt is ReviewAttempt => Boolean(attempt));
  const current = state.snapshotsByProjectId[projectId]?.mergeRequests.find((mr) => mr.iid === mrIid);
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
  return { project, attempts, mergeRequest };
}

export function projectAttempt(attempt: ReviewAttempt, progress: ReviewProgress | undefined, execution: AttemptView["execution"]): AttemptView {
  const { reportPath, ...view } = structuredClone(attempt);
  return { ...view, progress, execution, reportUrl: reportPath ? `/api/reports/${encodeURIComponent(attempt.id)}` : undefined };
}

export function projectMrDetail(state: PersistentState, source: ReturnType<typeof selectMrDetail>, attempts: AttemptView[]): MrDetailView {
  return {
    project: { id: source.project.id, name: source.project.name, registered: state.registeredProjectIds.includes(source.project.id) },
    mergeRequest: structuredClone(source.mergeRequest),
    attempts,
  };
}
