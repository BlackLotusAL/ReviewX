import { expect, test, vi } from "vitest";
import { ReportStore } from "@/src/server/storage/report-store";
import { configureMr, createRuntimeHarness, fakeResult, registerAndRefresh, generatedFinding, waitUntil } from "../helpers/runtime";
import { renderFinding } from "@/src/shared/finding-markdown";

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
    const state = await h.store.read(); expect(state.version).toBe(2);
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
      const progress = { activity: "检视进行中", limitations: ["bounded search"] };
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

test("the fixed comment body is saved, displayed and published unchanged", async () => {
  const h = await createRuntimeHarness();
  try {
    configureMr(h, "1", "1"); await registerAndRefresh(h, ["1"]);
    const f = generatedFinding("单位换算缺失导致计时过短。"); f.tags = ["单位换算"];
    f.locations[0].label = "延迟换算";
    f.locations[0].snippet = { language: "typescript", code: "return seconds;" };
    f.solutions[0].steps![0].example = { language: "typescript", code: "return seconds * 1000;" };
    const body = renderFinding(f);
    const result = fakeResult([{ severity: f.severity, body, structured: f }]); result.submission.findings = [f];
    vi.spyOn(h.reviewer, "review").mockResolvedValue(result);
    await h.runtime.createReview("1", "1"); await h.runtime.waitForIdle();
    const displayed = (await h.runtime.getMrDetail("1", "1")).attempts[0];
    expect(displayed.findings[0].body).toBe(body);
    expect(await h.runtime.readReport(displayed.id)).toContain(body);
    await h.runtime.publishFinding(displayed.id, 1);
    expect(h.codeHub.comments[0].body).toBe(body);
    expect((await h.store.read()).attemptsById[displayed.id].findings[0].body).toBe(body);
    expect((await h.store.read()).attemptsById[displayed.id].findings[0].structured).toEqual(f);
    expect(displayed.findings[0].body).toContain("[!code error:1]");
    expect(displayed.findings[0].body).not.toContain("**推荐方案**");
    expect(displayed.findings[0].structured!.locations[0].snippet!.code).toBe("return seconds;");
  } finally { await h.cleanup(); }
});
