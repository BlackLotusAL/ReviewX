import { expect, test } from "@playwright/test";

test("card-level decisions, cached report folding, MR links, history, and Markdown safety", async ({ page }) => {
  let reportRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/reports/")) reportRequests += 1;
  });

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

  const firstMrLink = firstCard.getByRole("link", { name: "在 CodeHub 打开 MR !1" });
  await expect(firstMrLink).toHaveAttribute("href", "https://codehub.example/team/project-101/merge_requests/1");
  await expect(firstMrLink).toHaveAttribute("target", "_blank");
  await firstMrLink.evaluate((link) => {
    link.addEventListener("click", (event) => event.preventDefault(), { once: true });
    (link as HTMLElement).click();
  });
  await expect(page.getByRole("complementary", { name: "MR 详情抽屉" })).toHaveCount(0);

  await firstCard.getByRole("button", { name: "开始检视" }).click();
  await secondCard.getByRole("button", { name: "开始检视" }).click();
  await expect(secondCard.getByText("队列第 1 位")).toBeVisible();
  await expect(firstCard.getByText("检视中")).toBeVisible();

  await firstCard.click();
  const drawer = page.getByRole("complementary", { name: "MR 详情抽屉" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("待处理", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(secondCard.getByText("已完成")).toBeVisible({ timeout: 15_000 });
  const drawerMrLink = drawer.getByRole("link", { name: "在 CodeHub 打开 MR !1" });
  await expect(drawerMrLink).toHaveAttribute("href", "https://codehub.example/team/project-101/merge_requests/1");
  await expect(drawerMrLink).toHaveAttribute("target", "_blank");

  await expect(drawer.getByRole("checkbox")).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "发布选中意见" })).toHaveCount(0);
  const findings = drawer.locator(".finding-card");
  await expect(findings).toHaveCount(2);

  await expect(drawer.locator("script, form, iframe, object, embed, img")).toHaveCount(0);
  await expect(drawer.locator('a[href^="file:"]')).toHaveCount(0);
  await expect(drawer.locator('a[href*="127.0.0.1:65535"]')).toHaveCount(0);
  await expect(drawer.getByText("[图片已拦截] Loopback image")).toBeVisible();
  const publicImage = drawer.getByRole("link", { name: "[图片链接] Public image" });
  await expect(publicImage).toHaveAttribute("href", "https://example.com/public.png");
  await expect(drawer.getByRole("link", { name: "Public documentation" })).toHaveAttribute("href", "https://example.com/docs");

  await findings.nth(0).getByRole("button", { name: "发送到 CodeHub" }).click();
  await expect(findings.nth(0).getByText("已发送", { exact: true })).toBeVisible();
  await expect(findings.nth(1).getByText("待处理", { exact: true })).toBeVisible();

  await findings.nth(1).getByRole("button", { name: "不发送" }).click();
  await expect(findings.nth(1).getByText("已跳过", { exact: true }).first()).toBeVisible();
  await expect(findings.nth(1).getByRole("button", { name: "撤销" })).toBeVisible();
  await expect(drawer.getByText("已完成", { exact: true }).first()).toBeVisible();

  await findings.nth(1).getByRole("button", { name: "撤销" }).click();
  await expect(findings.nth(1).getByText("待处理", { exact: true })).toBeVisible();
  await findings.nth(1).getByRole("button", { name: "发送到 CodeHub" }).click();
  await expect(findings.nth(1).getByText("已发送", { exact: true })).toBeVisible();
  await expect(drawer.getByText("已完成", { exact: true }).first()).toBeVisible();

  const report = drawer.locator("details.report-section");
  const reportSummary = report.locator("summary");
  await expect(report).not.toHaveAttribute("open", "");
  expect(reportRequests).toBe(0);
  await reportSummary.click();
  await expect(drawer.getByText("ReviewX Report")).toBeVisible();
  expect(reportRequests).toBe(1);
  await expect(drawer.locator("script, form, iframe, object, embed, img")).toHaveCount(0);
  await reportSummary.click();
  await expect(report).not.toHaveAttribute("open", "");
  await reportSummary.click();
  await expect(drawer.getByText("ReviewX Report")).toBeVisible();
  expect(reportRequests).toBe(1);

  await drawer.getByRole("button", { name: "关闭详情" }).click();
  await firstCard.getByRole("button", { name: "重新检视" }).click();
  await expect(firstCard.getByText("待处理")).toBeVisible({ timeout: 15_000 });
  await firstCard.click();
  const historyTabs = drawer.getByRole("tablist", { name: "Attempt 历史" });
  await expect(historyTabs.getByRole("button")).toHaveCount(2);
  await expect(historyTabs.getByRole("button", { name: /历史 .*已归档/u })).toBeVisible();
});
