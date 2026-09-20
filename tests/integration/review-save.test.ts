import { expect, test, vi } from "vitest";
import { ReportStore } from "@/src/server/storage/report-store";
import { configureMr, createRuntimeHarness, fakeResult, registerAndRefresh, waitUntil } from "../helpers/runtime";

test("cancel after atomic save leaves an unregistered non-publishable artifact", async () => {
  const h = await createRuntimeHarness();
  const original = ReportStore.prototype.save;
  let saved = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(ReportStore.prototype, "save").mockImplementation(async function (this: ReportStore, ...args) {
    const path = await original.apply(this, args); saved = true; await gate; return path;
  });
  try {
    configureMr(h, "1", "1"); await registerAndRefresh(h, ["1"]);
    h.reviewer.results.set("1", { findings: [{ severity: "major", body: "raw body\n \t\n" }] });
    await h.runtime.createReview("1", "1"); await waitUntil(() => saved);
    const attempt = (await h.runtime.getMrDetail("1", "1")).attempts[0];
    await h.runtime.stopAttempt(attempt.id); release(); await h.runtime.waitForIdle();
    const final = (await h.runtime.getMrDetail("1", "1")).attempts[0];
    expect(final.status).toBe("stopped"); expect(final.reportUrl).toBeUndefined(); expect(final.findings).toEqual([]);
    await expect(h.runtime.readReport(final.id)).rejects.toThrow();
    await expect(h.runtime.publishFinding(final.id, 1)).rejects.toThrow();
  } finally { release(); spy.mockRestore(); await h.cleanup(); }
});

test("report and persisted body preserve every original trailing byte", async () => {
  const h = await createRuntimeHarness();
  try {
    configureMr(h, "1", "1"); await registerAndRefresh(h, ["1"]);
    const body = "标题\r\n\n```text\ntext \t\n```\n \t\n\n";
    h.reviewer.results.set("1", { findings: [{ severity: "minor", body }] });
    await h.runtime.createReview("1", "1"); await h.runtime.waitForIdle();
    const attempt = (await h.runtime.getMrDetail("1", "1")).attempts[0];
    expect(attempt.findings[0].body).toBe(body);
    expect(await h.runtime.readReport(attempt.id)).toContain(body);
    const state = await h.store.read(); expect(state.version).toBe(1);
    expect(state.attemptsById[attempt.id]).not.toHaveProperty("execution");
  } finally { await h.cleanup(); }
});

test("tool progress increments only view revision and is visible in row/detail", async () => {
  const h = await createRuntimeHarness();
  try {
    configureMr(h, "1", "1"); await registerAndRefresh(h, ["1"]);
    vi.spyOn(h.reviewer, "review").mockImplementation(async (_project, _details, _prepared, _signal, options) => {
      const persisted = (await h.store.read()).revision;
      const view = h.runtime.snapshot().revision;
      const progress = { toolCount: 3, deliveredMaterials: 2, requiredMaterials: 4, limitations: ["bounded search"] };
      options.onProgress!(progress);
      expect(h.runtime.snapshot().revision).toBeGreaterThan(view);
      expect((await h.store.read()).revision).toBe(persisted);
      expect(h.runtime.snapshot().projects[0].mergeRequests[0].progress).toEqual(progress);
      expect((await h.runtime.getMrDetail("1", "1")).attempts[0].progress).toEqual(progress);
      return fakeResult([]);
    });
    await h.runtime.createReview("1", "1"); await h.runtime.waitForIdle();
    expect((await h.runtime.getMrDetail("1", "1")).attempts[0].status).toBe("completed");
  } finally { await h.cleanup(); }
});
