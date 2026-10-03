import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { resolveDataPaths } from "@/src/server/platform/paths";
import { configureMr, createRuntimeHarness, registerAndRefresh, waitUntil } from "../helpers/runtime";

test.each(["complete", "failed", "cancelled", "timeout"])("independent trace survives %s and spans cover save/cleanup", async outcome => {
  const h = await createRuntimeHarness();
  const deadline = new AbortController(), timeout = AbortSignal.timeout.bind(AbortSignal);
  const spy = outcome === "timeout" ? vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 60 * 60_000 ? deadline.signal : timeout(ms)) : undefined;
  try {
    configureMr(h, "1", "1"); await registerAndRefresh(h, ["1"]);
    if (outcome === "failed") h.reviewer.failures.set("1", new Error("synthetic failure"));
    if (["cancelled", "timeout"].includes(outcome)) h.reviewer.delayMs = 5000;
    await h.runtime.createReview("1", "1");
    if (["cancelled", "timeout"].includes(outcome)) {
      await waitUntil(() => h.reviewer.active === 1);
      const attempt = (await h.runtime.getMrDetail("1", "1")).attempts[0];
      if (outcome === "timeout") deadline.abort(new Error("deadline"));
      else await h.runtime.stopAttempt(attempt.id);
    }
    await h.runtime.waitForIdle();
    const attempt = (await h.runtime.getMrDetail("1", "1")).attempts[0];
    const paths = resolveDataPaths({ LOCALAPPDATA: h.root });
    const events = (await readFile(join(paths.logs, `review-${attempt.id}.jsonl`), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events[0].type).toBe("review.queued");
    expect(events.at(-1)).toMatchObject({ type: "review.finished", outcome });
    expect(events.some(e => e.type === "span.end" && e.name === "workspace_cleanup")).toBe(true);
    expect(events.some(e => e.type === "report.visible")).toBe(outcome === "complete");
    if (outcome !== "complete") expect(attempt.reportUrl).toBeUndefined();
  } finally { spy?.mockRestore(); await h.cleanup(); }
});
