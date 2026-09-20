import { expect, test, type Page } from "@playwright/test";
import { createReviewPreviewData } from "@/src/client/review-workspace/preview-data";

async function belowToolbar(page: Page, selector: string) {
  const target = page.locator(selector);
  await expect(target).toBeFocused();
  await expect.poll(async () => {
    const toolbar = (await page.locator(".workspace-top").boundingBox())!;
    const title = await target.evaluate(el => el.matches(".mr-card") ? el.closest(".mr-group")?.querySelector(".group-title")?.getBoundingClientRect().bottom ?? 0 : 0);
    return (await target.boundingBox())!.y - Math.max(toolbar.y + toolbar.height, title);
  }).toBeGreaterThanOrEqual(0);
}

test("sticky toolbar keeps queue and pending navigation available without hiding destinations", async ({ page }) => {
  await page.setViewportSize({ width: 1675, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const unexpected: string[] = [];
  await page.route("**/api/**", route => { unexpected.push(route.request().url()); return route.abort(); });
  await page.goto("/preview");
  const next = page.getByRole("button", { name: "下一个待处理 MR" });
  await next.click();
  await belowToolbar(page, "#mr-202-602");
  expect((await page.locator(".workspace-top").boundingBox())!.y).toBeCloseTo(0, 1);
  await next.click();
  await belowToolbar(page, "#mr-202-606");
  await next.click();
  await belowToolbar(page, "#mr-202-602");
  await page.getByRole("button", { name: "当前检视队列", exact: true }).click();
  await page.locator('.queue-entry[href="#mr-101-403"]').click();
  await belowToolbar(page, "#mr-101-403");
  await page.getByRole("button", { name: "定位项目 apps/internal/tools/task-console", exact: true }).click();
  await belowToolbar(page, "#project-202");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test("live pending navigation handles status changes, removed cursors, a single candidate and no candidates", async ({ page }) => {
  const state = structuredClone(createReviewPreviewData().state);
  const rows = state.projects.flatMap(project => project.mergeRequests);
  rows.forEach(mr => { mr.status = "completed"; });
  rows[0].status = "awaiting_confirmation";
  rows[1].status = "publish_failed";
  rows.at(-1)!.status = "awaiting_confirmation";
  const unexpected: string[] = [];
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname === "/api/state") return route.fulfill({ json: state });
    unexpected.push(route.request().url());
    return route.abort();
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const next = page.getByRole("button", { name: "下一个待处理 MR" });
  await next.click();
  await expect(page.locator("#mr-101-401")).toBeFocused();
  rows[0].status = "completed";
  state.revision++;
  await expect(page.locator("#mr-101-401 .status")).toHaveText("已完成");
  await next.click();
  await expect(page.locator("#mr-101-402")).toBeFocused();
  state.projects[0].mergeRequests = state.projects[0].mergeRequests.filter(mr => mr.iid !== "402");
  state.revision++;
  await expect(page.locator("#mr-101-402")).toHaveCount(0);
  await next.click();
  const last = rows.at(-1)!;
  await expect(page.locator(`#mr-${last.projectId}-${last.iid}`)).toBeFocused();
  await next.click();
  await expect(page.locator(`#mr-${last.projectId}-${last.iid}`)).toBeFocused();
  last.status = "completed";
  state.revision++;
  await expect(next).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(unexpected).toEqual([]);
});
