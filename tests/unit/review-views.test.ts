import { expect, test } from "vitest";
import { emptyState } from "@/src/server/storage/state-store";
import { projectAppState, projectAttempt, projectMrDetail, selectMrDetail } from "@/src/server/review/views";
import type { ReviewAttempt } from "@/src/shared/types";

function fixture() {
  const state = emptyState();
  state.projectsById["1"] = { id: "1", name: "team/repo", webUrl: "https://example.test/repo", cloneUrl: "https://example.test/repo.git", addedAt: "a", updatedAt: "b" };
  const attempt: ReviewAttempt = {
    id: "a/1", projectId: "1", mrIid: "2", mrTitle: "Historical MR", requestedUpdatedAt: "v1",
    updatedAt: "v1", sourceBranch: "feature", targetBranch: "main", status: "completed", createdAt: "now",
    reportPath: "reports/private/report.md", findings: [{ ordinal: 1, severity: "major", body: "original", status: "pending" }], publishBatches: [],
  };
  state.attemptsById[attempt.id] = attempt;
  state.attemptIdsByMr["1:2"] = [attempt.id];
  return { state, attempt };
}

test("historical detail remains readable after removing registration and hides storage paths", () => {
  const { state, attempt } = fixture();
  const before = structuredClone(state);
  const source = selectMrDetail(state, "1", "2");
  const view = projectMrDetail(state, source, [projectAttempt(attempt, undefined, undefined)]);
  expect(view.project.registered).toBe(false);
  expect(view.mergeRequest).toMatchObject({ state: "historical", sourceBranch: "feature", title: "Historical MR" });
  expect(view.attempts[0]).not.toHaveProperty("reportPath");
  expect(view.attempts[0].reportUrl).toBe("/api/reports/a%2F1");
  view.attempts[0].findings[0].body = "display changed";
  view.mergeRequest.title = "display title";
  expect(state).toEqual(before);
});

test("snapshot combines transient progress and publication state without modifying persisted state", () => {
  const { state, attempt } = fixture();
  state.registeredProjectIds = ["1"];
  state.snapshotsByProjectId["1"] = { refreshedAt: "now", mergeRequests: [{ projectId: "1", iid: "2", title: "MR", state: "open", updatedAt: "v1", sourceBranch: "feature", targetBranch: "main" }] };
  state.reviewQueue = [attempt.id];
  attempt.status = "queued";
  state.activePublishBatch = { attemptId: attempt.id, batchId: "batch" };
  const progress = { toolCount: 3, deliveredMaterials: 2, requiredMaterials: 4, limitations: [] };
  const before = structuredClone(state);
  const view = projectAppState({ state, revision: 42, removingProjects: new Set(["1"]), progress: new Map([[attempt.id, progress]]), fatalError: null });
  expect(view).toMatchObject({ revision: 42, publicationBusy: true, publicationProjectId: "1" });
  expect(view.projects[0]).toMatchObject({ removing: true, mergeRequests: [{ primaryAction: "stop", queuePosition: 1, progress }] });
  expect(state).toEqual(before);
});
