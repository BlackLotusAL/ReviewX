import { expect, test } from "@playwright/test";
import { createReviewPreviewData } from "@/src/client/review-workspace/preview-data";

test("project headings stick within their group without hiding navigation targets", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/preview");
  await expect(page.locator(".mr-card")).toHaveCount(14);
  await page.evaluate(() => document.fonts.ready);
  const group = page.locator(".mr-group").first();
  const title = group.locator(".group-title");
  const toolbar = page.locator(".workspace-top");
  const groupTop = (await group.boundingBox())!.y;
  await page.evaluate(top => window.scrollTo(0, top + 100), groupTop);
  await expect.poll(async () => (await title.boundingBox())!.y - (await toolbar.boundingBox())!.height).toBeCloseTo(0, 1);
  // Navigating to this same project must return to its actual start.
  await page.getByRole("button", { name: "定位项目 platform/review-engine", exact: true }).click();
  await expect(page.locator("#project-101")).toBeFocused();
  expect((await group.boundingBox())!.y).toBeGreaterThanOrEqual((await toolbar.boundingBox())!.height);
  const end = await group.evaluate(el => el.getBoundingClientRect().bottom + window.scrollY);
  const barHeight = (await toolbar.boundingBox())!.height;
  await page.evaluate(y => window.scrollTo(0, y), end - barHeight + 1);
  await expect.poll(async () => {
    const rect = (await title.boundingBox())!;
    return rect.y + rect.height;
  }).toBeLessThanOrEqual(barHeight + 1);
  const second = page.locator(".mr-group").nth(1);
  const secondTop = await second.evaluate(el => el.getBoundingClientRect().top + window.scrollY);
  await page.evaluate(y => window.scrollTo(0, y), secondTop - barHeight + 20);
  await expect.poll(async () => (await second.locator(".group-title").boundingBox())!.y).toBeCloseTo(barHeight, 1);
  await page.getByRole("button", { name: "当前检视队列", exact: true }).click();
  await expect(page.locator(".queue-popup")).toBeVisible();
  await page.locator('.queue-entry[href="#mr-101-403"]').click();
  await expect(page.locator("#mr-101-403")).toBeFocused();
  const header = (await title.boundingBox())!;
  expect((await page.locator("#mr-101-403").boundingBox())!.y).toBeGreaterThanOrEqual(header.y + header.height);
  await page.getByRole("button", { name: /^查看 MR !403：/ }).click();
  await expect(page.getByRole("dialog", { name: "MR 详情抽屉" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("wrapped project headings are remeasured and newly added empty groups remain navigable", async ({ page }) => {
  const state = structuredClone(createReviewPreviewData().state);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/state", route => route.fulfill({ json: state }));
  await page.goto("/");
  const firstTitle = page.locator(".group-title").first();
  await expect(firstTitle).toBeVisible();
  const oldHeight = (await firstTitle.boundingBox())!.height;
  state.projects[0].name = "platform/" + "超长项目名称".repeat(20);
  state.revision++;
  await expect(firstTitle).toContainText(state.projects[0].name.split("/").at(-1)!);
  await expect.poll(async () => (await firstTitle.boundingBox())!.height).toBeGreaterThan(oldHeight);
  await page.getByRole("button", { name: "当前检视队列", exact: true }).click();
  await page.locator('.queue-entry[href="#mr-101-403"]').click();
  await expect.poll(async () => {
    const title = (await firstTitle.boundingBox())!;
    return (await page.locator("#mr-101-403").boundingBox())!.y - title.y - title.height;
  }).toBeGreaterThanOrEqual(0);
  state.projects.unshift({ ...state.projects[1], id: "999", name: "empty", mergeRequests: [] });
  state.revision++;
  await page.getByRole("button", { name: "定位项目 empty", exact: true }).click();
  await expect(page.locator("#project-999")).toBeFocused();
  await expect(page.locator(".mr-group").first()).toContainText("暂无开放的 MR");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
