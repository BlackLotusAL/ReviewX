import { mkdir, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AppError } from "@/src/server/errors";
import type { AttemptView, ReviewerResult } from "@/src/shared/types";
import {
  configureMr,
  createRuntimeHarness,
  registerAndRefresh,
  waitUntil,
  type RuntimeHarness,
} from "../helpers/runtime";

function reviewerResult(...bodies: string[]): ReviewerResult {
  const severities = ["fatal", "major", "minor", "suggestion"] as const;
  return { findings: bodies.map((body, index) => ({ severity: severities[index % severities.length], body })) };
}

function failure(code: string, message = code): AppError {
  return new AppError({
    code,
    message,
    reason: `${message} reason`,
    impact: `${message} impact`,
    nextStep: `${message} next`,
    technical: `${message} technical`,
  });
}

async function attempts(harness: RuntimeHarness, projectId: string, mrIid: string): Promise<AttemptView[]> {
  return (await harness.runtime.getMrDetail(projectId, mrIid)).attempts;
}

async function latest(harness: RuntimeHarness, projectId: string, mrIid: string): Promise<AttemptView> {
  const attempt = (await attempts(harness, projectId, mrIid))[0];
  if (!attempt) throw new Error(`Missing attempt ${projectId}:${mrIid}`);
  return attempt;
}

describe("ReviewX runtime workflows", () => {
  it("manages Project history and performs ordered, partial manual refreshes without automation", async () => {
    const harness = await createRuntimeHarness();
    try {
      configureMr(harness, "101", "1", "First MR");
      configureMr(harness, "202", "2", "Second MR");
      await registerAndRefresh(harness, ["101", "202"]);

      expect(harness.runtime.snapshot().projects.map((project) => project.id)).toEqual(["101", "202"]);
      expect(harness.codeHub.calls).toEqual([
        ["repo", "view", "101"],
        ["repo", "view", "202"],
        ["mr", "list", "101"],
        ["mr", "view", "101", "1"],
        ["mr", "list", "202"],
        ["mr", "view", "202", "2"],
      ]);
      expect(harness.git.order).toEqual([]);
      expect(harness.reviewer.order).toEqual([]);
      expect(harness.codeHub.comments).toEqual([]);

      const replacement = {
        projectId: "101", iid: "3", title: "Replacement", state: "open",
        updatedAt: "2026-09-02T00:00:00Z", sourceBranch: "feature-3", targetBranch: "main",
      };
      harness.codeHub.lists.set("101", [{ iid: "3", title: "Replacement" }]);
      harness.codeHub.viewSequences.set("101:3", [replacement]);
      harness.codeHub.listFailures.set("202", new Error("simulated list failure"));
      await expect(harness.runtime.refreshMrs()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

      const afterPartial = harness.runtime.snapshot();
      expect(afterPartial.refreshOperation.status).toBe("failed");
      expect(afterPartial.projects[0].mergeRequests.map((mr) => mr.iid)).toEqual(["3"]);
      expect(afterPartial.projects[1].mergeRequests.map((mr) => mr.iid)).toEqual(["2"]);

      const callCount = harness.codeHub.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(harness.codeHub.calls).toHaveLength(callCount);

      await harness.runtime.removeProject("101");
      expect(harness.runtime.snapshot().projects.map((project) => project.id)).toEqual(["202"]);
      const historical = await harness.runtime.getMrDetail("101", "3");
      expect(historical.project.registered).toBe(false);
      await harness.runtime.addProject("101");
      expect(harness.runtime.snapshot().projects.map((project) => project.id)).toEqual(["202", "101"]);
      expect(harness.runtime.snapshot().projects[1].mergeRequests.map((mr) => mr.iid)).toEqual(["3"]);
      await expect(harness.runtime.addProject("101")).rejects.toMatchObject({ code: "PROJECT_ALREADY_EXISTS" });
      await expect(harness.runtime.addProject("0")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(harness.runtime.removeProject("999")).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await harness.cleanup();
    }
  });

  it("accepts CodeHub opened states and rejects terminal states before Git or OpenCode", async () => {
    const harness = await createRuntimeHarness();
    try {
      configureMr(harness, "101", "1", "Opened MR");
      const laterClosed = configureMr(harness, "101", "2", "Later closed MR");
      await registerAndRefresh(harness, ["101"]);

      await harness.runtime.createReview("101", "1");
      await harness.runtime.waitForIdle();
      expect((await latest(harness, "101", "1")).status).toBe("completed");

      harness.codeHub.viewIndexes.set("101:2", 0);
      harness.codeHub.viewSequences.set("101:2", [{ ...laterClosed, state: "closed" }]);
      await harness.runtime.createReview("101", "2");
      await harness.runtime.waitForIdle();

      const rejected = await latest(harness, "101", "2");
      expect(rejected.status).toBe("review_failed");
      expect(rejected.error?.code).toBe("MR_NOT_OPEN");
      expect(harness.git.order).toEqual(["101:1"]);
      expect(harness.reviewer.order).toEqual(["1"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("runs one strict FIFO worker and supports queued and active stops while continuing later work", async () => {
    const harness = await createRuntimeHarness();
    try {
      configureMr(harness, "101", "1");
      configureMr(harness, "101", "2");
      configureMr(harness, "101", "3");
      await registerAndRefresh(harness, ["101"]);
      harness.reviewer.delayMs = 160;

      await harness.runtime.createReview("101", "1");
      await waitUntil(() => harness.reviewer.active === 1);
      await harness.runtime.createReview("101", "2");
      await harness.runtime.createReview("101", "3");
      const firstId = (await latest(harness, "101", "1")).id;
      const secondId = (await latest(harness, "101", "2")).id;

      expect(harness.runtime.snapshot().projects[0].mergeRequests.find((mr) => mr.iid === "2")?.queuePosition).toBe(1);
      expect(harness.runtime.snapshot().projects[0].mergeRequests.find((mr) => mr.iid === "3")?.queuePosition).toBe(2);
      await harness.runtime.stopAttempt(secondId);
      await harness.runtime.stopAttempt(firstId);
      await harness.runtime.waitForIdle();

      expect((await latest(harness, "101", "1")).status).toBe("stopped");
      expect((await latest(harness, "101", "2")).status).toBe("stopped");
      expect((await latest(harness, "101", "3")).status).toBe("completed");
      expect(harness.reviewer.order).toEqual(["1", "3"]);
      expect(harness.reviewer.maximumActive).toBe(1);
      expect(harness.git.cleanupCount).toBe(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("marks a failed review and stops every queued attempt without auto-continuing", async () => {
    const harness = await createRuntimeHarness();
    try {
      for (const iid of ["1", "2", "3"]) configureMr(harness, "101", iid);
      await registerAndRefresh(harness, ["101"]);
      harness.reviewer.delayMs = 120;
      harness.reviewer.failures.set("1", failure("FAKE_REVIEW_FAILURE"));
      await harness.runtime.createReview("101", "1");
      await waitUntil(() => harness.reviewer.active === 1);
      await harness.runtime.createReview("101", "2");
      await harness.runtime.createReview("101", "3");
      await harness.runtime.waitForIdle();

      expect((await latest(harness, "101", "1")).status).toBe("review_failed");
      expect((await latest(harness, "101", "2")).status).toBe("stopped");
      expect((await latest(harness, "101", "3")).status).toBe("stopped");
      expect(harness.reviewer.order).toEqual(["1"]);
      expect((await harness.store.read()).reviewQueue).toEqual([]);
      expect((await harness.store.read()).diagnostics.at(-1)).toMatchObject({ operation: "MR review", error: { code: "FAKE_REVIEW_FAILURE" } });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects an MR that changes after Git preparation before OpenCode or report creation", async () => {
    const harness = await createRuntimeHarness();
    try {
      const original = configureMr(harness, "101", "1");
      await registerAndRefresh(harness, ["101"]);
      const changed = { ...original, updatedAt: "2026-09-02T12:00:00Z" };
      harness.codeHub.viewIndexes.set("101:1", 0);
      harness.codeHub.viewSequences.set("101:1", [original, changed]);
      await harness.runtime.createReview("101", "1");
      await harness.runtime.waitForIdle();

      const attempt = await latest(harness, "101", "1");
      expect(attempt.status).toBe("review_failed");
      expect(attempt.error?.code).toBe("MR_CHANGED_DURING_PREPARATION");
      expect(attempt.reportUrl).toBeUndefined();
      expect(harness.reviewer.order).toEqual([]);
      expect(harness.git.cleanupCount).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("saves immutable reports and supports all-skipped completion, send, and undo per Finding", async () => {
    const harness = await createRuntimeHarness();
    try {
      configureMr(harness, "101", "1");
      await registerAndRefresh(harness, ["101"]);
      harness.reviewer.results.set("1", reviewerResult("first body", "second body", "third body"));
      await harness.runtime.createReview("101", "1");
      await harness.runtime.waitForIdle();

      const first = await latest(harness, "101", "1");
      expect(first.status).toBe("awaiting_confirmation");
      expect(first.findings.map((finding) => finding.status)).toEqual(["pending", "pending", "pending"]);
      expect(harness.codeHub.comments).toEqual([]);
      const firstReport = await harness.runtime.readReport(first.id);
      expect(firstReport).toContain("first body");
      await harness.runtime.removeProject("101");
      await expect(harness.runtime.publishFinding(first.id, 1)).rejects.toMatchObject({ code: "PROJECT_NOT_AVAILABLE" });
      await harness.runtime.addProject("101");
      const mrViewsBeforePublish = harness.codeHub.calls.filter((call) => call[0] === "mr" && call[1] === "view").length;

      await harness.runtime.decideFinding(first.id, 1, "dismissed");
      await harness.runtime.decideFinding(first.id, 2, "dismissed");
      await harness.runtime.decideFinding(first.id, 3, "dismissed");
      expect((await latest(harness, "101", "1")).status).toBe("completed");
      expect((await latest(harness, "101", "1")).findings.map((finding) => finding.status)).toEqual(["dismissed", "dismissed", "dismissed"]);
      expect(harness.codeHub.comments).toEqual([]);

      await harness.runtime.decideFinding(first.id, 1, "pending");
      expect((await latest(harness, "101", "1")).status).toBe("awaiting_confirmation");
      await harness.runtime.publishFinding(first.id, 1);
      expect(harness.codeHub.comments.map((comment) => comment.body)).toEqual(["first body"]);
      expect((await latest(harness, "101", "1")).status).toBe("completed");

      await harness.runtime.decideFinding(first.id, 2, "pending");
      await harness.runtime.publishFinding(first.id, 2);
      const decided = await latest(harness, "101", "1");
      expect(decided.status).toBe("completed");
      expect(decided.findings.map((finding) => finding.status)).toEqual(["published", "published", "dismissed"]);
      expect(decided.publishBatches.map((batch) => batch.selectedOrdinals)).toEqual([[1], [2]]);
      expect(harness.codeHub.calls.filter((call) => call[0] === "mr" && call[1] === "view")).toHaveLength(mrViewsBeforePublish);

      harness.reviewer.results.set("1", { findings: [] });
      await harness.runtime.createReview("101", "1");
      await harness.runtime.waitForIdle();
      const history = await attempts(harness, "101", "1");
      expect(history).toHaveLength(2);
      expect(history[0].status).toBe("completed");
      expect(history[0].result).toBe("pass");
      expect(history[1].status).toBe("archived");
      expect(history[1].findings.map((finding) => finding.status)).toEqual(["published", "published", "dismissed"]);
      expect(history[0].reportUrl).not.toBe(history[1].reportUrl);
      expect(await harness.runtime.readReport(history[0].id)).toContain("**PASS**");
      expect(await harness.runtime.readReport(history[1].id)).toBe(firstReport);
      expect(harness.codeHub.comments).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("allows one comment send alongside one review while keeping sends globally serial", async () => {
    const harness = await createRuntimeHarness();
    try {
      configureMr(harness, "101", "1");
      configureMr(harness, "101", "2");
      configureMr(harness, "202", "3");
      await registerAndRefresh(harness, ["101", "202"]);
      harness.reviewer.results.set("1", reviewerResult("one"));
      harness.reviewer.results.set("3", reviewerResult("other"));
      await harness.runtime.createReview("101", "1");
      await harness.runtime.createReview("202", "3");
      await harness.runtime.waitForIdle();
      const publishA = await latest(harness, "101", "1");
      const publishB = await latest(harness, "202", "3");

      harness.codeHub.commentDelayMs = 180;
      harness.reviewer.delayMs = 120;
      const publishing = harness.runtime.publishFinding(publishA.id, 1);
      await waitUntil(() => harness.codeHub.activeComments === 1);
      await expect(harness.runtime.publishFinding(publishB.id, 1)).rejects.toMatchObject({ code: "PUBLICATION_BUSY" });
      await expect(harness.runtime.decideFinding(publishB.id, 1, "dismissed")).rejects.toMatchObject({ code: "PUBLICATION_BUSY" });
      await expect(harness.runtime.removeProject("101")).rejects.toMatchObject({ code: "PROJECT_PUBLISHING" });
      await harness.runtime.createReview("101", "2");
      await waitUntil(() => harness.codeHub.activeComments === 1 && harness.reviewer.active === 1);
      await Promise.all([publishing, harness.runtime.waitForIdle()]);

      expect(harness.codeHub.maximumActiveComments).toBe(1);
      expect((await latest(harness, "101", "2")).status).toBe("completed");
      expect((await latest(harness, "101", "1")).status).toBe("completed");
      expect((await latest(harness, "202", "3")).status).toBe("awaiting_confirmation");
    } finally {
      await harness.cleanup();
    }
  });

  it("seals failed or unknown publication outcomes and does not disturb the review queue", async () => {
    const harness = await createRuntimeHarness();
    try {
      configureMr(harness, "101", "1");
      configureMr(harness, "101", "2");
      await registerAndRefresh(harness, ["101"]);
      harness.reviewer.results.set("1", reviewerResult("ok", "fails", "later"));
      await harness.runtime.createReview("101", "1");
      await harness.runtime.waitForIdle();
      const publishable = await latest(harness, "101", "1");

      harness.codeHub.commentOutcomes = [{ kind: "failed", error: failure("COMMENT_REJECTED") }];
      harness.codeHub.commentDelayMs = 90;
      harness.reviewer.delayMs = 120;
      const publishing = harness.runtime.publishFinding(publishable.id, 1);
      await waitUntil(() => harness.codeHub.activeComments === 1);
      await harness.runtime.createReview("101", "2");
      await expect(publishing).rejects.toMatchObject({ code: "COMMENT_REJECTED" });
      await harness.runtime.waitForIdle();

      const failed = await latest(harness, "101", "1");
      expect(failed.status).toBe("awaiting_confirmation");
      expect(failed.findings.map((finding) => finding.status)).toEqual(["failed", "pending", "pending"]);
      expect((await harness.store.read()).diagnostics.at(-1)).toMatchObject({ operation: "Finding publication", error: { code: "COMMENT_REJECTED" } });
      expect((await latest(harness, "101", "2")).status).toBe("completed");
      await expect(harness.runtime.publishFinding(failed.id, 1)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await harness.runtime.publishFinding(failed.id, 2);
      await harness.runtime.decideFinding(failed.id, 3, "dismissed");
      expect((await latest(harness, "101", "1")).status).toBe("publish_failed");
      expect((await latest(harness, "101", "1")).findings.map((finding) => finding.status)).toEqual(["failed", "published", "dismissed"]);

      harness.reviewer.results.set("1", reviewerResult("unknown", "never"));
      await harness.runtime.createReview("101", "1");
      await harness.runtime.waitForIdle();
      const second = await latest(harness, "101", "1");
      harness.codeHub.commentOutcomes = [{ kind: "unknown", error: failure("COMMENT_RESULT_UNKNOWN") }];
      await expect(harness.runtime.publishFinding(second.id, 1)).rejects.toMatchObject({ code: "COMMENT_RESULT_UNKNOWN" });
      expect((await latest(harness, "101", "1")).status).toBe("awaiting_confirmation");
      expect((await latest(harness, "101", "1")).findings.map((finding) => finding.status)).toEqual(["unknown", "pending"]);
      await harness.runtime.decideFinding(second.id, 2, "dismissed");
      expect((await latest(harness, "101", "1")).status).toBe("publish_failed");
    } finally {
      await harness.cleanup();
    }
  });

  it("removing a Project stops its active and queued reviews, preserves history, and continues other Projects", async () => {
    const harness = await createRuntimeHarness();
    try {
      configureMr(harness, "101", "1");
      configureMr(harness, "101", "2");
      configureMr(harness, "202", "3");
      await registerAndRefresh(harness, ["101", "202"]);
      harness.reviewer.delayMs = 160;
      await harness.runtime.createReview("101", "1");
      await waitUntil(() => harness.reviewer.active === 1);
      await harness.runtime.createReview("101", "2");
      await harness.runtime.createReview("202", "3");
      await harness.runtime.removeProject("101");
      await harness.runtime.waitForIdle();

      expect(harness.runtime.snapshot().projects.map((project) => project.id)).toEqual(["202"]);
      expect((await latest(harness, "101", "1")).status).toBe("stopped");
      expect((await latest(harness, "101", "2")).status).toBe("stopped");
      expect((await latest(harness, "202", "3")).status).toBe("completed");
      expect((await harness.runtime.getMrDetail("101", "1")).project.registered).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it("enters a fatal state on log write failure before starting new external work, while still allowing removal", async () => {
    const harness = await createRuntimeHarness();
    try {
      configureMr(harness, "101", "1");
      await registerAndRefresh(harness, ["101"]);
      await rm(harness.logger.filePath);
      await mkdir(harness.logger.filePath);

      await expect(harness.runtime.createReview("101", "1")).rejects.toMatchObject({ code: "LOG_WRITE_ERROR" });
      expect(harness.runtime.snapshot().fatalError?.code).toBe("LOG_WRITE_ERROR");
      expect(harness.reviewer.order).toEqual([]);
      expect((await attempts(harness, "101", "1"))).toEqual([]);
      await expect(harness.runtime.refreshMrs()).rejects.toMatchObject({ code: "LOG_WRITE_ERROR" });
      await waitUntil(async () => (await harness.store.read()).diagnostics.some((record) => record.operation === "Session logging"));

      await harness.runtime.removeProject("101");
      expect(harness.runtime.snapshot().projects).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });
});
