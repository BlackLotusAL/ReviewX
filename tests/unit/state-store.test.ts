import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ReviewAttempt } from "@/src/shared/types";
import { FileLock } from "@/src/server/file-lock";
import { ensureDataPaths, resolveDataPaths } from "@/src/server/paths";
import { StateStore } from "@/src/server/state-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-state-test-"));
  roots.push(root);
  const paths = resolveDataPaths({ LOCALAPPDATA: root });
  ensureDataPaths(paths);
  const store = new StateStore(paths);
  await store.initialize("2026-09-02T00:00:00.000Z");
  return { paths, store };
}

function attempt(id: string, status: ReviewAttempt["status"]): ReviewAttempt {
  return {
    id,
    projectId: "1",
    mrIid: "10",
    mrTitle: "MR",
    requestedUpdatedAt: "v1",
    status,
    phase: status === "queued" ? "queued" : undefined,
    createdAt: "2026-09-02T00:00:00.000Z",
    findings: [],
    publishBatches: [],
  };
}

describe("atomic persistent state", () => {
  test("writes valid indented JSON atomically and fails immediately under a live lock", async () => {
    const { paths, store } = await setup();
    await store.mutate((draft) => { draft.registeredProjectIds.push("1"); draft.projectsById["1"] = {
      id: "1", name: "team/repo", cloneUrl: "https://example.com/team/repo.git", addedAt: "a", updatedAt: "b",
    }; });
    expect(JSON.parse(await readFile(paths.stateFile, "utf8")).registeredProjectIds).toEqual(["1"]);
    expect((await readdir(paths.root)).some((name) => name.includes(".tmp-"))).toBe(false);
    const lock = await FileLock.acquire(paths.stateLockFile);
    await expect(store.mutate(() => undefined)).rejects.toMatchObject({ code: "STATE_LOCKED" });
    await lock.release();
  });

  test("startup turns queued/reviewing/stopping into stopped and never resumes them", async () => {
    const { paths, store } = await setup();
    await store.mutate((draft) => {
      for (const [id, status] of [["q", "queued"], ["r", "reviewing"], ["s", "stopping"]] as const) draft.attemptsById[id] = attempt(id, status);
      draft.reviewQueue = ["q"];
      draft.activeReviewAttemptId = "r";
    });
    const recovered = await new StateStore(paths).initialize("2026-09-02T01:00:00.000Z");
    expect(Object.values(recovered.attemptsById).map((item) => item.status)).toEqual(["stopped", "stopped", "stopped"]);
    expect(recovered.reviewQueue).toEqual([]);
    expect(recovered.activeReviewAttemptId).toBeNull();
  });

  test("startup classifies interrupted publication as unknown and not_attempted", async () => {
    const { paths, store } = await setup();
    await store.mutate((draft) => {
      const active = attempt("p", "publishing");
      active.findings = [1, 2, 3].map((ordinal) => ({ ordinal, severity: "major", body: `body ${ordinal}`, status: "pending" }));
      active.publishBatches = [{ id: "batch", selectedOrdinals: [1, 2], currentOrdinal: 1, status: "running", startedAt: "now" }];
      draft.attemptsById.p = active;
      draft.activePublishBatch = { attemptId: "p", batchId: "batch", currentOrdinal: 1 };
    });
    const recovered = await new StateStore(paths).initialize("later");
    expect(recovered.attemptsById.p.status).toBe("awaiting_confirmation");
    expect(recovered.attemptsById.p.findings.map((finding) => finding.status)).toEqual(["unknown", "not_attempted", "pending"]);
    expect(recovered.activePublishBatch).toBeNull();
  });

  test("loads legacy MR snapshots without webUrl and persists dismissed Findings", async () => {
    const { paths, store } = await setup();
    await store.mutate((draft) => {
      draft.snapshotsByProjectId["1"] = {
        refreshedAt: "2026-09-02T00:00:00.000Z",
        mergeRequests: [{
          projectId: "1",
          iid: "10",
          title: "Legacy MR",
          state: "opened",
          updatedAt: "v1",
          sourceBranch: "feature",
          targetBranch: "main",
        }],
      };
      const completed = attempt("dismissed", "completed");
      completed.findings = [{
        ordinal: 1,
        severity: "minor",
        body: "No comment needed",
        status: "dismissed",
        dismissedAt: "2026-09-02T00:30:00.000Z",
      }];
      draft.attemptsById[completed.id] = completed;
    });

    const restored = await new StateStore(paths).initialize("2026-09-02T01:00:00.000Z");
    expect(restored.snapshotsByProjectId["1"].mergeRequests[0].webUrl).toBeUndefined();
    expect(restored.attemptsById.dismissed.findings[0]).toMatchObject({
      status: "dismissed",
      dismissedAt: "2026-09-02T00:30:00.000Z",
    });
  });
});
