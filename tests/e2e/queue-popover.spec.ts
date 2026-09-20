import { expect, test } from "@playwright/test";
import { createReviewPreviewData } from "@/src/client/review-workspace/preview-data";

test("desktop queue popup dismisses without shifting content and restores focus", async ({ page }) => {
  const viewport = page.viewportSize()!;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/preview");
  const trigger = page.getByRole("button", { name: "当前检视队列", exact: true });
  const popup = page.getByRole("dialog", { name: "当前检视队列", exact: true });
  await expect(popup).toHaveCount(0);
  await expect(page.locator(".queue-counts")).toHaveText("待处理 2 · 排队 1");
  await trigger.scrollIntoViewIfNeeded();
  const cardY = await page.locator(".mr-card").first().evaluate(el => el.getBoundingClientRect().top + window.scrollY);
  await trigger.click();
  await expect(popup).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".queue-entry")).toHaveCount(8);
  const bounds = (await popup.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  expect(await page.locator(".mr-card").first().evaluate(el => el.getBoundingClientRect().top + window.scrollY)).toBeCloseTo(cardY, 1);
  await page.locator("#queue-heading").click();
  await expect(popup).toBeVisible();
  await page.locator(".queue-list").evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await trigger.click();
  await expect(popup).toHaveCount(0);
  await trigger.click();
  await page.locator("#mr-heading").click();
  await expect(popup).toHaveCount(0);
  await trigger.click();
  await page.locator('.queue-entry[href="#mr-101-403"]').click();
  await expect(popup).toHaveCount(0);
  await expect(page.locator("#mr-101-403")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("queue counts and popup update during loading, empty and growing live queues", async ({ page }) => {
  const state = structuredClone(createReviewPreviewData().state);
  const sample = state.projects[0].mergeRequests[0];
  state.projects = [{ ...state.projects[0], mergeRequests: [] }];
  let release!: () => void;
  const loaded = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/state", async route => { await loaded; await route.fulfill({ json: state }); });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "当前检视队列", exact: true });
  await expect(trigger).toBeDisabled();
  await expect(page.locator(".queue-counts")).toHaveText("待处理 — · 排队 —");
  release();
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.locator(".queue-empty")).toBeVisible();
  for (const count of [1, 6, 7, 12, 0]) {
    state.projects[0].mergeRequests = Array.from({ length: count }, (_, i) => ({ ...sample, iid: String(i + 1), status: i === 0 ? "publish_failed" : "awaiting_confirmation", title: "长标题完整提示".repeat(30) }));
    state.revision++;
    await expect(page.locator(".queue-entry")).toHaveCount(count);
    await expect(page.locator(".queue-counts")).toHaveText(`待处理 ${count} · 排队 0`);
    await expect(page.locator(".queue-popup")).toBeVisible();
    if (count > 1) expect(await page.locator(".queue-list").evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    if (count) await expect(page.locator(".queue-copy strong").first()).toHaveAttribute("title", state.projects[0].mergeRequests[0].title);
    else await expect(page.locator(".queue-empty")).toBeVisible();
  }
});
