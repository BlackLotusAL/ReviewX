import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/src/server/errors";
import { ReviewXRuntime } from "@/src/server/runtime";
import { resolveDataPaths } from "@/src/server/platform/paths";
import { ReportStore } from "@/src/server/storage/report-store";
import type { AttemptView, ReviewerResult } from "@/src/shared/types";
import {
  configureMr,
  createRuntimeHarness,
  fakeResult,
  registerAndRefresh,
  waitUntil,
  type RuntimeHarness,
} from "../helpers/runtime";

function reviewerResult(...bodies: string[]): Pick<ReviewerResult, "findings"> {
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
  it("keeps saved findings when cleanup warning persistence fails, then resumes FIFO once", async () => {
    const harness = await createRuntimeHarness();
    try {
      for (const iid of ["1", "2"]) configureMr(harness, "101", iid);
      await registerAndRefresh(harness, ["101"]);
      harness.reviewer.delayMs = 80;
      harness.reviewer.results.set("1", reviewerResult("saved finding"));
      const prepare = harness.git.prepare.bind(harness.git);
      let writesFail = false;
      const mutate = harness.store.mutate.bind(harness.store);
      vi.spyOn(harness.store, "mutate").mockImplementation(async operation => {
        if (writesFail) throw failure("STATE_WRITE_ERROR");
        return mutate(operation);
      });
      vi.spyOn(harness.git, "prepare").mockImplementation(async (...args) => {
        const prepared = await prepare(...args);
        if (args[1].iid === "1") prepared.cleanup = async () => { writesFail = true; throw new Error("locked directory"); };
        return prepared;
      });
      await harness.runtime.createReview("101", "1");
      await harness.runtime.createReview("101", "2");
      await harness.runtime.waitForIdle();
      expect((await latest(harness, "101", "1")).status).toBe("awaiting_confirmation");
      expect(await harness.runtime.readReport((await latest(harness, "101", "1")).id)).toContain("saved finding");
      expect(harness.runtime.snapshot().queuePaused?.code).toBe("STATE_WRITE_ERROR");
      expect((await latest(harness, "101", "2")).status).toBe("queued");
      writesFail = false;
      await harness.runtime.resumeQueue(); await harness.runtime.waitForIdle();
      await harness.runtime.resumeQueue(); await harness.runtime.waitForIdle();
      expect(harness.reviewer.order).toEqual(["1", "2"]);
      expect((await latest(harness, "101", "1")).status).toBe("awaiting_confirmation");
    } finally { await harness.cleanup(); }
  });

  it("saves partial output and pauses on uncertain process exit without replaying generation", async () => {
    const harness = await createRuntimeHarness();
    try {
      for (const iid of ["1", "2"]) configureMr(harness, "101", iid);
      await registerAndRefresh(harness, ["101"]);
      const result = fakeResult([]);
      result.cleanupPending = true;
      result.submission.completion = "incomplete";
      result.submission.limitations = ["缺少部分上下文"];
      vi.spyOn(harness.reviewer, "review").mockResolvedValueOnce(result);
      await harness.runtime.createReview("101", "1");
      await harness.runtime.createReview("101", "2");
      await harness.runtime.waitForIdle();
      expect((await latest(harness, "101", "1"))).toMatchObject({ status: "completed", result: "partial" });
      expect(harness.runtime.snapshot().queuePaused?.code).toBe("OPENCODE_CLEANUP_FAILED");
      expect(harness.git.cleanupCount).toBe(0);
      await harness.runtime.resumeQueue(); await harness.runtime.waitForIdle();
      expect(harness.git.cleanupCount).toBe(2);
      expect(harness.reviewer.review).toHaveBeenCalledTimes(2);
      expect((await latest(harness, "101", "2")).status).toBe("completed");
    } finally { await harness.cleanup(); }
  });
  it("rejects invalid guidance before archiving or enqueueing, without stopping other reviews", async () => {
    const harness = await createRuntimeHarness();
    let release!: () => void, held = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      for (const iid of ["1", "2", "3"]) configureMr(harness, "101", iid);
      await registerAndRefresh(harness, ["101"]);
      await harness.runtime.createReview("101", "1"); await harness.runtime.waitForIdle();
      const original = await latest(harness, "101", "1");
      const review = harness.reviewer.review.bind(harness.reviewer);
      harness.reviewer.review = async (...args) => {
        if (args[1].iid === "2") { held = true; await gate; }
        return review(...args);
      };
      await harness.runtime.createReview("101", "2"); await harness.runtime.createReview("101", "3");
      await waitUntil(() => held);
      await mkdir(join(harness.root, "user-rules"));
      await writeFile(join(harness.root, "user-rules", "broken.md"), Buffer.from([0]));
      const mrCalls = harness.codeHub.calls.length;
      await expect(harness.runtime.createReview("101", "1")).rejects.toMatchObject({ code: "REVIEW_RULE_ERROR", httpStatus: 400 });
      expect((await attempts(harness, "101", "1"))).toHaveLength(1);
      expect(await latest(harness, "101", "1")).toMatchObject({ id: original.id, status: "completed" });
      expect(harness.codeHub.calls.length).toBe(mrCalls);
      release();
      await harness.runtime.waitForIdle();
      expect((await latest(harness, "101", "2")).status).toBe("completed");
      expect((await latest(harness, "101", "3")).status).toBe("completed");
    } finally { release(); await harness.cleanup(); }
  });
  it("freezes guidance at enqueue time, including queued tasks, and picks up edits only for new tasks", async () => {
    const harness = await createRuntimeHarness();
    try {
      for (const iid of ["1", "2", "3"]) configureMr(harness, "101", iid);
      await registerAndRefresh(harness, ["101"]);
      await mkdir(join(harness.root, "user-rules"));
      const file = join(harness.root, "user-rules", "business.md");
      await writeFile(file, "Original business fact");
      const seen: Record<string, string[]> = {}, review = harness.reviewer.review.bind(harness.reviewer);
      harness.reviewer.review = async (...args) => {
        seen[args[1].iid] = args[4].rules.resources.map(r => r.body);
        return review(...args);
      };
      harness.reviewer.delayMs = 150;
      await harness.runtime.createReview("101", "1"); await harness.runtime.createReview("101", "2");
      await writeFile(file, "New business fact");
      await harness.runtime.createReview("101", "3");
      await rm(file);
      await harness.runtime.waitForIdle();
      expect(seen).toEqual({ "1": ["Original business fact"], "2": ["Original business fact"], "3": ["New business fact"] });
    } finally { await harness.cleanup(); }
  });
  it("the whole-attempt deadline also interrupts Git preparation", async () => {
    const harness = await createRuntimeHarness();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    try {
      configureMr(harness, "101", "1"); await registerAndRefresh(harness, ["101"]);
      vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(ms === 60 * 60_000 ? 50 : ms));
      harness.git.delayMs = 500;
      await harness.runtime.createReview("101", "1"); await harness.runtime.waitForIdle();
      expect((await latest(harness, "101", "1")).error?.code).toBe("REVIEW_TIMEOUT");
      expect(harness.reviewer.order).toEqual([]);
    } finally { vi.restoreAllMocks(); await harness.cleanup(); }
  });
  it("preserves the primary review error when workspace cleanup also fails", async () => {
    const harness = await createRuntimeHarness();
    try {
      configureMr(harness, "101", "1"); await registerAndRefresh(harness, ["101"]);
      const prepare = harness.git.prepare.bind(harness.git);
      harness.git.prepare = async (...args) => ({ ...await prepare(...args), cleanup: async () => { throw new Error("cleanup unavailable"); } });
      harness.reviewer.failures.set("1", failure("PRIMARY_REVIEW_FAILURE"));
      await harness.runtime.createReview("101", "1"); await harness.runtime.waitForIdle();
      const attempt = await latest(harness, "101", "1");
      expect(attempt.error).toMatchObject({ code: "PRIMARY_REVIEW_FAILURE", technicalDetails: expect.stringContaining("cleanup unavailable") });
      expect(attempt.reportUrl).toBeUndefined();
    } finally { await harness.cleanup(); }
  });
  it.each([0, 2])("keeps partial outcome through publication and persistence (%i findings)", async count => {
    const harness = await createRuntimeHarness();
    try {
      configureMr(harness, "101", "1"); await registerAndRefresh(harness, ["101"]);
      harness.reviewer.results.set("1", reviewerResult(...Array.from({ length: count }, (_, i) => `Verified ${i}`)));
      const review = harness.reviewer.review.bind(harness.reviewer);
      harness.reviewer.review = async (...args) => {
        const result = await review(...args); result.submission.completion = "incomplete";
        result.submission.limitations = ["Missing context"]; result.execution.progress.limitations = ["阻塞原因：Missing context"];
        return result;
      };
      await harness.runtime.createReview("101", "1"); await harness.runtime.waitForIdle();
      const first = await latest(harness, "101", "1");
      expect(first.result).toBe("partial");
      expect(first.progress?.limitations).toContain("阻塞原因：Missing context");
      if (count) {
        await harness.runtime.decideFinding(first.id, 1, "dismissed");
        await harness.runtime.publishFinding(first.id, 2);
      }
      expect((await latest(harness, "101", "1"))).toMatchObject({ result: "partial", status: "completed" });
      expect((await harness.store.read()).attemptsById[first.id].result).toBe("partial");
      expect(harness.runtime.snapshot().projects[0].mergeRequests[0].result).toBe("partial");
      await harness.runtime.createReview("101", "1"); await harness.runtime.waitForIdle();
      expect((await latest(harness, "101", "1")).id).not.toBe(first.id);
      await harness.runtime.shutdown();
      const paths = resolveDataPaths({ LOCALAPPDATA: harness.root });
      const restarted = await new ReviewXRuntime({ paths, store: harness.store, logger: harness.logger, codeHub: harness.codeHub,
        git: harness.git, reviewer: harness.reviewer, reports: new ReportStore(paths) }).initialize();
      try {
        const restored = (await restarted.getMrDetail("101", "1")).attempts[0];
        expect(restored.result).toBe("partial");
        expect(restored.progress?.limitations).toContain("阻塞原因：Missing context");
      } finally { await restarted.shutdown(); }
    } finally { await harness.cleanup(); }
  });
  it("preserves review timing through decisions, publication, persistence and a fresh attempt", async () => {
    const harness = await createRuntimeHarness();
    try {
      configureMr(harness, "101", "1");
      await registerAndRefresh(harness, ["101"]);
      harness.reviewer.results.set("1", reviewerResult("first", "second"));
      await harness.runtime.createReview("101", "1");
      await harness.runtime.waitForIdle();
      const first = await latest(harness, "101", "1");
      expect(first.reviewFinishedAt).toBe(first.completedAt);
      expect(Date.parse(first.reviewFinishedAt!)).toBeGreaterThan(Date.parse(first.startedAt!));
      await harness.runtime.decideFinding(first.id, 1, "dismissed");
      await harness.runtime.publishFinding(first.id, 2);
      const processed = await latest(harness, "101", "1");
      expect(processed.completedAt).not.toBe(first.completedAt);
      expect(processed.reviewFinishedAt).toBe(first.reviewFinishedAt);
      expect(harness.runtime.snapshot().projects[0].mergeRequests[0]).toMatchObject({ reviewStartedAt: first.startedAt, reviewFinishedAt: first.reviewFinishedAt });
      expect((await harness.store.read()).attemptsById[first.id].reviewFinishedAt).toBe(first.reviewFinishedAt);
      harness.reviewer.delayMs = 500;
      await harness.runtime.createReview("101", "1");
      await waitUntil(() => harness.runtime.snapshot().projects[0].mergeRequests[0].status === "reviewing");
      const next = await latest(harness, "101", "1");
      expect(next.id).not.toBe(first.id);
      expect(next.reviewFinishedAt).toBeUndefined();
      expect(next.startedAt).not.toBe(first.startedAt);
      await harness.runtime.stopAttempt(next.id);
      await harness.runtime.waitForIdle();
      const stopped = await latest(harness, "101", "1");
      expect(stopped.reviewFinishedAt).toBe(stopped.stoppedAt);
      expect(stopped.reviewFinishedAt).toBeDefined();
      expect((await attempts(harness, "101", "1"))[1].reviewFinishedAt).toBe(first.reviewFinishedAt);
    } finally { await harness.cleanup(); }
  });
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

  it("marks a failed review and continues other queued attempts", async () => {
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
      expect((await latest(harness, "101", "2")).status).toBe("completed");
      expect((await latest(harness, "101", "3")).status).toBe("completed");
      expect(harness.reviewer.order).toEqual(["1", "2", "3"]);
      expect((await harness.store.read()).reviewQueue).toEqual([]);
      expect((await harness.store.read()).diagnostics.at(-1)).toMatchObject({ operation: "MR review", error: { code: "FAKE_REVIEW_FAILURE" } });
    } finally {
      await harness.cleanup();
    }
  });

  it("loads MR once and reviews the fixed snapshot without checking later metadata", async () => {
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
      expect(attempt.status).toBe("completed");
      expect(attempt.error).toBeUndefined();
      expect(harness.codeHub.viewIndexes.get("101:1")).toBe(1);
      expect(attempt.reviewFinishedAt).toBeDefined();
      expect(attempt.reviewFinishedAt).toBe(attempt.completedAt);
      expect(harness.runtime.snapshot().projects[0].mergeRequests[0].reviewFinishedAt).toBe(attempt.reviewFinishedAt);
      expect(attempt.reportUrl).toBeDefined();
      expect(harness.reviewer.order).toEqual(["1"]);
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

  it("log failure is a warning and does not prevent review", async () => {
    const harness = await createRuntimeHarness();
    try {
      configureMr(harness, "101", "1"); await registerAndRefresh(harness, ["101"]);
      await rm(harness.logger.filePath); await mkdir(harness.logger.filePath);
      await harness.runtime.createReview("101", "1"); await harness.runtime.waitForIdle();
      expect(harness.runtime.snapshot().fatalError).toBeNull();
      expect(harness.runtime.snapshot().warnings?.length).toBeGreaterThan(0);
      expect((await latest(harness, "101", "1")).status).toBe("completed");
    } finally { await harness.cleanup(); }
  });
});

it("persists project web URLs verbatim and never looks them up during refresh or polling", async () => {
  const harness = await createRuntimeHarness();
  try {
    const webUrl = "http://codehub.example/project/101/home?tab=files#readme";
    harness.codeHub.repos.set("101", { name: "team/repo", cloneUrl: "https://codehub.example/team/repo.git", webUrl });
    configureMr(harness, "101", "1");
    await harness.runtime.addProject("101");
    expect(harness.runtime.snapshot().projects[0].webUrl).toBe(webUrl);
    expect((await harness.store.read()).projectsById["101"].webUrl).toBe(webUrl);
    harness.runtime.snapshot(); harness.runtime.snapshot();
    await harness.runtime.refreshMrs();
    await harness.runtime.refreshMrs();
    expect(harness.codeHub.calls.filter(call => call[0] === "repo")).toEqual([["repo", "view", "101"]]);
    expect(harness.runtime.snapshot().projects[0].webUrl).toBe(webUrl);
  } finally { await harness.cleanup(); }
});
