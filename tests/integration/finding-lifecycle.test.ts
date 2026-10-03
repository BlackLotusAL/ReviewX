import { expect, test, vi } from "vitest";
import { AppError } from "@/src/server/errors";
import { configureMr, createRuntimeHarness, registerAndRefresh } from "../helpers/runtime";

test.each([false, true])("publication write failure preserves uncertainty (recovery on restart: %s)", async failUntilRestart => {
  const h = await createRuntimeHarness();
  try {
    configureMr(h, "1", "1"); await registerAndRefresh(h, ["1"]);
    h.reviewer.results.set("1", { findings: ["first", "second"].map(body => ({ body, severity: "major" })) });
    await h.runtime.createReview("1", "1"); await h.runtime.waitForIdle();
    const attempt = (await h.runtime.getMrDetail("1", "1")).attempts[0];
    const mutate = h.store.mutate.bind(h.store);
    const spy = vi.spyOn(h.store, "mutate").mockImplementation(operation => mutate(async draft => {
      await operation(draft);
      const status = draft.attemptsById[attempt.id].findings[0].status;
      if (status === "published" || (failUntilRestart && status === "unknown")) throw new AppError({
        code: "STATE_WRITE_ERROR", message: "Injected persistence failure", reason: "test", impact: "not committed", nextStep: "restart", technical: "Injected before state commit.",
      });
    }));
    await expect(h.runtime.publishFinding(attempt.id, 1)).rejects.toMatchObject({ code: "STATE_WRITE_ERROR" });
    expect(h.codeHub.comments).toHaveLength(1);
    const persisted = await h.store.read();
    expect(persisted.attemptsById[attempt.id].findings[0].status).toBe(failUntilRestart ? "pending" : "unknown");
    expect(persisted.activePublishBatch === null).toBe(!failUntilRestart);
    spy.mockRestore();
    const recovered = await h.store.initialize("2026-09-30T01:00:00Z");
    expect(recovered.attemptsById[attempt.id].findings.map(f => f.status)).toEqual(["unknown", "pending"]);
    expect(recovered.attemptsById[attempt.id].status).toBe("awaiting_confirmation");
    expect(recovered.attemptsById[attempt.id].findings[0].commentId).toBeUndefined();
    expect(recovered.attemptsById[attempt.id].publishBatches[0].status).toBe("failed");
    expect(recovered.activePublishBatch).toBeNull();
    expect(h.codeHub.comments).toHaveLength(1);
    // Recovery is idempotent and never initiates a second external write.
    expect(await h.store.initialize("2026-09-30T02:00:00Z")).toEqual(recovered);
  } finally { vi.restoreAllMocks(); await h.cleanup(); }
});

test("rereview archives only pending findings and never restores old actions after failure", async () => {
  const h = await createRuntimeHarness();
  try {
    configureMr(h, "1", "1"); await registerAndRefresh(h, ["1"]);
    h.reviewer.results.set("1", { findings: ["published", "dismissed", "pending"].map(body => ({ body, severity: "major" })) });
    await h.runtime.createReview("1", "1"); await h.runtime.waitForIdle();
    const old = (await h.runtime.getMrDetail("1", "1")).attempts[0];
    await h.runtime.publishFinding(old.id, 1);
    await h.runtime.decideFinding(old.id, 2, "dismissed");
    const before = (await h.runtime.getMrDetail("1", "1")).attempts[0];
    h.reviewer.failures.set("1", new Error("Next review failed"));
    await h.runtime.createReview("1", "1"); await h.runtime.waitForIdle();
    const history = (await h.runtime.getMrDetail("1", "1")).attempts;
    expect(history[0].status).toBe("review_failed");
    expect(history[1]).toMatchObject({ id: old.id, status: "archived", archivedFromStatus: "awaiting_confirmation" });
    expect(history[1].findings.map(f => f.status)).toEqual(["published", "dismissed", "archived"]);
    expect(history[1].findings.slice(0, 2)).toEqual(before.findings.slice(0, 2));
    expect(history[1].reviewFinishedAt).toBe(before.reviewFinishedAt);
    await expect(h.runtime.decideFinding(old.id, 2, "pending")).rejects.toMatchObject({ code: "ATTEMPT_NOT_ACTIONABLE" });
    await expect(h.runtime.publishFinding(old.id, 3)).rejects.toMatchObject({ code: "ATTEMPT_NOT_PUBLISHABLE" });
    expect(h.codeHub.comments).toHaveLength(1);
  } finally { await h.cleanup(); }
});

test("concurrent sends of the same finding create exactly one comment and one batch", async () => {
  const h = await createRuntimeHarness();
  try {
    configureMr(h, "1", "1"); await registerAndRefresh(h, ["1"]);
    h.reviewer.results.set("1", { findings: [{ body: "finding", severity: "major" }] });
    await h.runtime.createReview("1", "1"); await h.runtime.waitForIdle();
    const attempt = (await h.runtime.getMrDetail("1", "1")).attempts[0];
    h.codeHub.commentDelayMs = 30;
    const results = await Promise.allSettled([h.runtime.publishFinding(attempt.id, 1), h.runtime.publishFinding(attempt.id, 1)]);
    expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const state = await h.store.read();
    expect(state.attemptsById[attempt.id].publishBatches).toHaveLength(1);
    expect(state.attemptsById[attempt.id].findings[0].status).toBe("published");
    expect(state.activePublishBatch).toBeNull();
    expect(h.codeHub.comments).toHaveLength(1);
  } finally { await h.cleanup(); }
});
