import { expect, test } from "@playwright/test";
import { createReviewPreviewData } from "@/src/preview/mr-fixtures";

for (const viewport of [{ width: 1675, height: 1000 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`queue popup dismisses without shifting layout at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/preview");
    const trigger = page.getByRole("button", { name: "当前检视队列", exact: true });
    const popup = page.getByRole("dialog", { name: "当前检视队列", exact: true });
    await expect(popup).toHaveCount(0);
    await expect(page.locator(".queue-counts")).toHaveText("待处理 2 · 排队 1");
    await expect(page.locator(".queue-counts")).toHaveCSS("white-space", "nowrap");
    await trigger.scrollIntoViewIfNeeded();
    const countBox = (await page.locator(".queue-counts").boundingBox())!;
    const triggerBox = (await trigger.boundingBox())!;
    expect(countBox.x + countBox.width).toBeLessThan(triggerBox.x);
    expect(Math.abs(countBox.y + countBox.height / 2 - triggerBox.y - triggerBox.height / 2)).toBeLessThan(1);
    const cardY = await page.locator(".mr-card").first().evaluate(el => el.getBoundingClientRect().top + window.scrollY);
    await page.screenshot({ path: testInfo.outputPath("queue-closed.png") });
    await trigger.click();
    await expect(popup).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".queue-entry")).toHaveCount(8);
    const bounds = (await popup.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(16);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 16);
    expect(bounds.y).toBeGreaterThanOrEqual(16);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 16);
    expect(await page.locator(".mr-card").first().evaluate(el => el.getBoundingClientRect().top + window.scrollY)).toBeCloseTo(cardY, 1);
    const entries = await page.locator(".queue-entry").evaluateAll(nodes => nodes.map(el => ({ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y })));
    expect(entries[0].x).toBe(entries[1].x);
    expect(entries[1].y).toBeGreaterThan(entries[0].y);
    await page.locator("#queue-heading").click();
    await expect(popup).toBeVisible();
    await page.locator(".queue-list").evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(popup).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("queue-open.png") });
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
    if (viewport.width <= 900) {
      await trigger.click();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(popup).toHaveCount(0);
    }
  });
}

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
