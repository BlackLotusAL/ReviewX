import { expect, test } from "@playwright/test";

test("three-region UI polls queue state, renders history, publishes selections, and sanitizes Markdown", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ReviewX" })).toBeVisible();
  await expect(page.locator(".project-panel")).toBeVisible();
  await expect(page.locator(".mr-panel")).toBeVisible();
  await expect(page.getByText("ReviewX 不会自动扫描或发布评论。")).toBeVisible();

  await page.getByLabel("Project ID").fill("101");
  await page.getByRole("button", { name: "添加" }).click();
  await expect(page.getByLabel("已登记 Project").getByText("team/project-101", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "刷新 MR" }).click();

  const firstCard = page.locator(".mr-card").filter({ hasText: "Security-sensitive parser update" });
  const secondCard = page.locator(".mr-card").filter({ hasText: "Queue worker tests" });
  await expect(firstCard).toBeVisible();
  await expect(secondCard).toBeVisible();
  await firstCard.getByRole("button", { name: "开始检视" }).click();
  await secondCard.getByRole("button", { name: "开始检视" }).click();
  await expect(secondCard.getByText("队列第 1 位")).toBeVisible();
  await expect(firstCard.getByText("检视中")).toBeVisible();

  await firstCard.click();
  const drawer = page.getByRole("complementary", { name: "MR 详情抽屉" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("待确认", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(secondCard.getByText("已完成")).toBeVisible({ timeout: 15_000 });

  const checkboxes = drawer.getByRole("checkbox");
  await expect(checkboxes).toHaveCount(2);
  await expect(checkboxes.nth(0)).not.toBeChecked();
  await expect(checkboxes.nth(1)).not.toBeChecked();
  const publish = drawer.getByRole("button", { name: "发布选中意见" });
  await expect(publish).toBeDisabled();

  await expect(drawer.locator("script, form, iframe, object, embed, img")).toHaveCount(0);
  await expect(drawer.locator('a[href^="file:"]')).toHaveCount(0);
  await expect(drawer.locator('a[href*="127.0.0.1:65535"]')).toHaveCount(0);
  await expect(drawer.getByText("[图片已拦截] Loopback image")).toBeVisible();
  const publicImage = drawer.getByRole("link", { name: "[图片链接] Public image" });
  await expect(publicImage).toHaveAttribute("href", "https://example.com/public.png");
  await expect(drawer.getByRole("link", { name: "Public documentation" })).toHaveAttribute("href", "https://example.com/docs");

  await checkboxes.nth(0).check();
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(drawer.getByText("已发布", { exact: true })).toBeVisible();
  await expect(checkboxes.nth(0)).not.toBeChecked();
  await expect(publish).toBeDisabled();
  await checkboxes.nth(1).check();
  await publish.click();
  await expect(drawer.getByText("已完成", { exact: true }).first()).toBeVisible();

  await drawer.getByRole("button", { name: "加载报告" }).click();
  await expect(drawer.getByText("ReviewX Report")).toBeVisible();
  await expect(drawer.locator("script, form, iframe, object, embed, img")).toHaveCount(0);

  await drawer.getByRole("button", { name: "关闭详情" }).click();
  await firstCard.getByRole("button", { name: "重新检视" }).click();
  await expect(firstCard.getByText("待确认")).toBeVisible({ timeout: 15_000 });
  await firstCard.click();
  const historyTabs = drawer.getByRole("tablist", { name: "Attempt 历史" });
  await expect(historyTabs.getByRole("button")).toHaveCount(2);
  await expect(historyTabs.getByRole("button", { name: /历史 .*已归档/u })).toBeVisible();
});
