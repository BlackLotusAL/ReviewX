import { expect, test } from "vitest";
import { projectShortName, projectTree, reviewQueue, nextPendingMr, mrAnchor } from "@/src/client/workspace-navigation";
import { createReviewPreviewData } from "@/src/preview/mr-fixtures";

test("groups shared nested directories without merging same-name projects", () => {
  const base = createReviewPreviewData().state.projects[0];
  const projects = ["a/b/one", "root", "a/b/two", "c/one"].map((name, index) => ({ ...base, id: String(index), name }));
  const tree = projectTree(projects);
  expect(tree.map(node => node.kind === "directory" ? node.name : node.project.name)).toEqual(["a", "root", "c"]);
  expect(tree[0]).toMatchObject({ children: [{ name: "b", children: [{ project: { id: "0" } }, { project: { id: "2" } }] }] });
  expect(projectShortName("a/b/one")).toBe("one");
  expect(projectShortName("root")).toBe("root");
});

test("queue uses global FIFO after active tasks and removes finished tasks", () => {
  const projects = createReviewPreviewData().state.projects;
  const queued = projects[0].mergeRequests.find(mr => mr.status === "queued")!;
  queued.queuePosition = 2;
  projects[1].mergeRequests.push({ ...queued, projectId: projects[1].id, iid: "999", queuePosition: 1 });
  const queue = reviewQueue(projects);
  expect(queue.map(({ mr }) => mr.status)).toEqual(["reviewing", "reviewing", "reviewing", "stopping", "publishing", "queued", "queued", "awaiting_confirmation", "publish_failed"]);
  expect(queue.filter(({ mr }) => mr.status === "queued").map(({ mr }) => mr.queuePosition)).toEqual([1, 2]);
  for (const { mr } of queue) mr.status = "completed";
  expect(reviewQueue(projects)).toEqual([]);
  expect(reviewQueue([])).toEqual([]);
});

test("pending navigation follows list order across projects and wraps around", () => {
  const projects = createReviewPreviewData().state.projects;
  const first = projects[0].mergeRequests[0];
  first.status = "awaiting_confirmation";
  const candidates = projects.flatMap(p => p.mergeRequests).filter(mr => ["awaiting_confirmation", "publish_failed"].includes(mr.status));
  expect(nextPendingMr(projects, null)).toBe(first);
  for (let i = 0; i < candidates.length; i++) {
    const current = candidates[i];
    expect(nextPendingMr(projects, mrAnchor(current.projectId, current.iid))).toBe(candidates[(i + 1) % candidates.length]);
  }
  first.status = "completed";
  expect(nextPendingMr(projects, mrAnchor(first.projectId, first.iid))).toBe(candidates[1]);
  expect(nextPendingMr(projects, "removed-mr")).toBe(candidates[1]);
  for (const mr of candidates.slice(2)) mr.status = "completed";
  expect(nextPendingMr(projects, mrAnchor(candidates[1].projectId, candidates[1].iid))).toBe(candidates[1]);
  candidates[1].status = "completed";
  expect(nextPendingMr(projects, null)).toBeNull();
  expect(nextPendingMr([], null)).toBeNull();
});
