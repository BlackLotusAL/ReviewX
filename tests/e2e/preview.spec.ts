import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createReviewPreviewData } from "@/src/preview/mr-fixtures";

const data = createReviewPreviewData();
const rows = data.state.projects.flatMap(project => project.mergeRequests);
const statusLabels = ["未检视", "排队中", "检视中", "检视中", "检视中", "停止中", "已停止", "检视未完成", "待处理", "发送中", "已完成", "已完成", "发布失败", "已归档"];

async function forbidApi(context: BrowserContext) {
  const requests: string[] = [];
  await context.route("**/api/**", async route => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.abort();
  });
  return requests;
}

function opener(page: Page, iid: string) {
  return page.getByRole("button", { name: new RegExp(`^查看 MR !${iid}：`) });
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const dialog = page.getByRole("dialog");
  if (await dialog.count()) {
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await dialog.evaluate(el => el.getBoundingClientRect().left)).toBeGreaterThanOrEqual(0);
  }
}

test("fixed preview covers every MR with matching details and reports without any API access", async ({ page, context }) => {
  const requests = await forbidApi(context);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/preview");
  await expect(page).toHaveTitle("MR 样式预览 · ReviewX");
  await expect(page.locator(".project-item")).toHaveCount(2);
  await expect(page.locator(".mr-card")).toHaveCount(14);
  await expect(page.locator(".mr-card .status")).toHaveText(statusLabels);
  await expect(page.locator(".mr-card .phase")).toHaveText(["理解改动", "核实问题", "整理结果", "清理临时目录"]);
  await expect(page.locator(".queue-position")).toHaveText("队列第 1 位");
  for (const [index, row] of rows.entries()) {
    await opener(page, row.iid).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".drawer-header h2")).toHaveText(row.title);
    await expect(dialog.locator(".drawer-mr-link")).toHaveText(`!${row.iid}`);
    const detail = data.details[`${row.projectId}/${row.iid}`];
    await expect(dialog.locator(".drawer-mr-meta")).toContainText(detail.project.name);
    if (row.status === "unreviewed") await expect(dialog.getByText("暂无检视记录")).toBeVisible();
    else {
      await expect(dialog.getByRole("tab")).toHaveCount(3);
      await expect(dialog.locator(".attempt-overview .status")).toHaveText(statusLabels[index]);
      const latest = detail.attempts[0];
      await expect(dialog.locator(".finding-card")).toHaveCount(latest.findings.length);
      if (latest.result === "pass") await expect(dialog.locator(".review-pass")).toContainText("未发现证据充分的问题。");
      if (latest.reportUrl) {
        await dialog.locator(".report-section summary").click();
        await expect(dialog.locator(".report-preview")).toContainText(`MR !${row.iid} · 检视报告`);
        await expect(dialog.locator(".report-preview")).toContainText(latest.id);
        await expect(dialog.locator(".report-preview table").first()).toBeVisible();
        await expect(dialog.locator(".report-preview pre").first()).toBeVisible();
      }
      if (latest.error) {
        const diagnostic = dialog.locator(".attempt-detail > .diagnostic");
        await expect(diagnostic).toContainText(latest.error.cause);
        await diagnostic.locator("summary").click();
        await expect(diagnostic).toContainText(latest.error.technicalDetails);
      }
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test("preview actions and example links leave samples unchanged across reloads", async ({ page, context }) => {
  const requests = await forbidApi(context);
  await page.goto("/preview");
  await expect(page.locator(".mr-card")).toHaveCount(14);
  const original = await page.locator(".mr-groups").textContent();
  const sidebar = await page.locator(".project-list").textContent();
  await page.getByLabel("Project ID").fill("999");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByLabel("Project ID")).toHaveValue("999");
  for (const button of await page.getByRole("button", { name: "移除", exact: true }).all()) await button.click();
  await page.getByRole("button", { name: "刷新 MR" }).click();
  for (const button of await page.locator(".mr-action button").all()) {
    await expect(button).toBeEnabled();
    await button.click();
  }
  await expect(page.locator(".project-list")).toHaveText(sidebar!);
  await expect(page.locator(".mr-groups")).toHaveText(original!);
  await opener(page, "602").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".finding-card")).toHaveCount(4);
  const findings = await dialog.locator(".findings-section").textContent();
  for (const button of await dialog.locator(".finding-actions button").all()) {
    await expect(button).toBeEnabled();
    await button.click();
  }
  await expect(dialog.locator(".findings-section")).toHaveText(findings!);
  await dialog.getByRole("link", { name: "示例 MR !602" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const exampleLink = page.getByRole("link", { name: "示例 MR !401" });
  await exampleLink.click();
  await exampleLink.click({ button: "middle" });
  await exampleLink.click({ modifiers: ["Control"] });
  await exampleLink.focus();
  await page.keyboard.press("Enter");
  // Allow more than two normal homepage polling intervals to detect accidental polling.
  await page.waitForTimeout(2_100);
  expect(context.pages()).toHaveLength(1);
  await expect(page).toHaveURL(/\/preview$/);
  await expect(page.locator(".mr-groups")).toHaveText(original!);
  await page.reload();
  await expect(page.locator(".mr-groups")).toHaveText(original!);
  await opener(page, "602").click();
  await expect(page.locator(".findings-section")).toHaveText(findings!);
  const reopened = await context.newPage();
  await reopened.goto("/preview");
  await expect(reopened.locator(".mr-groups")).toHaveText(original!);
  await reopened.close();
  expect(requests).toEqual([]);
});

test("preview history, markdown disclosure and keyboard focus remain interactive", async ({ page, context }) => {
  const requests = await forbidApi(context);
  await page.goto("/preview");
  const trigger = opener(page, "602");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "关闭详情" })).toBeFocused();
  await expect(dialog.locator(".finding-severity")).toHaveText(["Fatal", "Major", "Minor", "Suggestion"]);
  await expect(dialog.locator(".finding-card pre")).toHaveCount(2);
  await expect(dialog.locator(".finding-card table")).toHaveCount(1);
  await expect(dialog.locator(".findings-section > h3")).toHaveText("检视问题");
  await expect(dialog.locator(".finding-verification")).toHaveCount(0);
  await expect(dialog.locator(".finding-header .finding-confidence")).toHaveCount(4);
  await expect(dialog.locator(".finding-body > .finding-confidence")).toHaveCount(0);
  await expect(dialog.locator(".finding-card pre .hljs-keyword").first()).toBeVisible();
  for (const [index, color] of ["rgb(255, 240, 241)", "rgb(255, 243, 232)", "rgb(255, 249, 223)", "rgb(234, 243, 255)"].entries()) {
    await expect(dialog.locator(".finding-severity").nth(index)).toHaveCSS("background-color", color);
  }
  await expect(dialog.locator(".attempt-metadata")).toHaveCount(0);
  await expect(dialog.locator(".attempt-overview code")).toHaveText("preview-202-602-latest");
  const tabs = dialog.getByRole("tab");
  await tabs.first().focus();
  await page.keyboard.press("End");
  await expect(tabs.last()).toBeFocused();
  await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
  await expect(dialog.locator(".attempt-overview code")).toHaveText("preview-202-602-history-1");
  await expect(dialog.locator(".finding-confidence")).toHaveText("置信度 未评估");
  await expect(dialog.locator(".finding-actions button")).toHaveCount(0);
  const summary = dialog.locator(".report-section summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.locator(".report-preview")).toContainText("preview-202-602-history-1");
  await page.keyboard.press("Enter");
  await expect(dialog.locator(".report-section")).not.toHaveAttribute("open", "");
  await tabs.last().focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(dialog.locator(".finding-card")).toHaveCount(2);
  await summary.click();
  await expect(dialog.locator(".report-preview")).toContainText("preview-202-602-history-2");
  await tabs.nth(1).focus();
  await page.keyboard.press("Home");
  await expect(tabs.first()).toBeFocused();
  await expect(dialog.locator(".finding-card")).toHaveCount(4);
  await summary.click();
  await expect(dialog.locator(".report-preview")).toContainText("preview-202-602-latest");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(requests).toEqual([]);
});

test("preview log link opens local logs while the homepage still reads live state", async ({ page, context }) => {
  const requests: string[] = [];
  await context.route("**/api/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    requests.push(pathname);
    if (pathname === "/api/logs/current") await route.fulfill({ contentType: "text/plain", body: "[2026-09-08 10:20:30.123] [INFO] Current local session.\n" });
    else if (pathname === "/api/state") await route.fulfill({ json: { ...data.state, projects: [] } });
    else await route.abort();
  });
  await page.goto("/preview");
  await expect(page.locator(".mr-card")).toHaveCount(14);
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "查看当前会话日志" }).click();
  const logs = await opened;
  await expect(logs).toHaveURL(/\/logs$/);
  await expect(logs.locator("main")).toContainText("Current local session.");
  expect(requests).toContain("/api/logs/current");
  expect(requests).not.toContain("/api/state");
  await logs.close();
  await page.goto("/");
  await expect(page.locator(".welcome")).toBeVisible();
  await expect(page.locator(".mr-card")).toHaveCount(0);
  await expect(page.getByLabel("Project ID")).toBeVisible();
  await expect(page.locator(".project-form label")).toHaveCount(0);
  expect(requests).toContain("/api/state");
});

test("live duration ticks during execution and stopping, then freezes without detail requests", async ({ page }) => {
  const state = structuredClone(data.state);
  const row = { ...state.projects[0].mergeRequests[2], reviewStartedAt: "2026-09-10T00:00:00Z", reviewFinishedAt: undefined as string | undefined };
  state.projects = [{ ...state.projects[0], mergeRequests: [row] }];
  const unexpected: string[] = [];
  await page.route("**/api/**", async route => {
    if (new URL(route.request().url()).pathname === "/api/state") await route.fulfill({ json: state });
    else { unexpected.push(route.request().url()); await route.abort(); }
  });
  await page.clock.setFixedTime(new Date("2026-09-10T00:00:42Z"));
  await page.goto("/");
  const duration = page.locator(".mr-duration");
  await expect(duration).toHaveText("检视耗时 42 秒");
  await page.clock.setFixedTime(new Date("2026-09-10T00:00:43Z"));
  await expect(duration).toHaveText("检视耗时 43 秒");
  row.status = "stopping";
  state.revision++;
  await page.clock.setFixedTime(new Date("2026-09-10T00:00:45Z"));
  await expect(page.locator(".mr-state .status")).toHaveText("停止中");
  await expect(duration).toHaveText("检视耗时 45 秒");
  row.status = "stopped";
  row.reviewFinishedAt = "2026-09-10T00:00:45Z";
  state.revision++;
  await expect(page.locator(".mr-state .status")).toHaveText("已停止");
  await page.clock.setFixedTime(new Date("2026-09-10T02:00:00Z"));
  await page.waitForResponse("**/api/state");
  await expect(duration).toHaveText("检视耗时 45 秒");
  delete row.reviewFinishedAt;
  state.revision++;
  await expect(duration).toHaveText("检视耗时 —");
  expect(unexpected).toEqual([]);
});

for (const viewport of [{ width: 1675, height: 1216 }, { width: 1230, height: 1216 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`preview layout at ${viewport.width}x${viewport.height}`, async ({ page, context }, testInfo) => {
    const requests = await forbidApi(context);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize(viewport);
    await page.goto("/preview");
    await expect(page.locator(".mr-card")).toHaveCount(14);
    await expect(page.locator(".mr-project-id")).toHaveCount(0);
    await expect(page.locator(".project-copy > .mono").first()).toHaveText("#101");
    await expect(page.locator(".project-copy strong").first()).toHaveCSS("font-size", "16px");
    await expect(page.locator(".project-item > .icon").first()).toHaveCSS("width", "22px");
    await expect(page.locator(".mr-main h4").first()).toHaveCSS("font-size", "18px");
    await expect(page.locator(".mr-card").first()).toHaveCSS("background-color", "rgb(245, 247, 250)");
    await expect(page.locator(".mr-card").first().locator(".mr-progress")).toHaveCount(0);
    const durations = await page.locator(".mr-duration").allTextContents();
    expect(durations).toHaveLength(12);
    if (viewport.width > 600) {
      for (const card of await page.locator(".mr-card").all()) {
        if (!await card.locator(".mr-action button").count()) continue;
        const stateBox = await card.locator(".mr-state").boundingBox();
        const actionBox = await card.locator(".mr-action button").boundingBox();
        expect(Math.abs(stateBox!.y + stateBox!.height / 2 - actionBox!.y - actionBox!.height / 2)).toBeLessThan(1);
      }
    }
    await expect(page.getByLabel("Project ID")).toBeVisible();
    await expect(page.locator(".project-form label")).toHaveCount(0);
    await expect(page.locator("#mr-heading")).toHaveText("MR 检视队列");
    await expect(page.locator("#mr-heading .status-dot")).toHaveCount(0);
    if (viewport.width > 900) expect(await page.locator(".project-panel").evaluate(el => el.getBoundingClientRect().width)).toBe(360);
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("preview-queue.png"), fullPage: true, animations: "disabled" });
    await page.screenshot({ path: testInfo.outputPath("preview-viewport.png"), animations: "disabled" });
    await opener(page, "602").click();
    await expect(page.locator(".finding-card")).toHaveCount(4);
    await expect(page.locator(".drawer-mr-meta")).toHaveCSS("font-size", "14px");
    await expect(page.locator(".attempt-tabs time").first()).toHaveCSS("font-size", "13px");
    for (const pill of await page.locator(".finding-confidence, .finding-badges > .status, .attempt-overview .status").all()) {
      await expect(pill).toHaveCSS("font-size", "13px");
      expect(await pill.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(32);
    }
    await expect(page.locator(".finding-card footer, .decision-result")).toHaveCount(0);
    await expect(page.locator(".attempt-overview > div")).toHaveCount(4);
    await expect(page.locator(".finding-severity").first()).toHaveCSS("font-size", "13px");
    await expect(page.locator(".finding-severity .icon")).toHaveCount(0);
    await expect(page.locator(".finding-severity").first()).toHaveCSS("font-weight", "400");
    await expect(page.locator(".attempt-overview code")).toHaveCSS("font-size", "16px");
    await expect(page.locator(".attempt-overview time")).toHaveCSS("font-size", "16px");
    await expect(page.locator(".finding-confidence").first()).toHaveCSS("background-color", "rgb(221, 252, 230)");
    await expect(page.locator(".finding-confidence").first()).toHaveCSS("color", "rgb(55, 65, 81)");
    for (const header of await page.locator(".finding-header").all()) {
      await expect(header).toHaveCSS("background-color", "rgb(245, 247, 250)");
      const info = header.locator(".finding-info");
      expect(await info.evaluate(el => el.getBoundingClientRect().left - el.parentElement!.getBoundingClientRect().left)).toBe(viewport.width <= 600 ? 16 : 24);
      const actions = header.locator(".finding-actions");
      if (await actions.count()) {
        expect(await actions.evaluate(el => el.parentElement!.getBoundingClientRect().right - el.getBoundingClientRect().right)).toBe(viewport.width <= 600 ? 16 : 24);
      }
    }
    const cells = await page.locator(".attempt-overview > div").evaluateAll(nodes => nodes.map(el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y}; }));
    expect(cells[0].y).toBe(cells[1].y);
    expect(cells[2].y).toBe(cells[3].y);
    expect(cells[0].x).toBe(cells[2].x);
    for (const button of await page.locator(".finding-header .finding-actions button").all()) {
      expect(await button.evaluate(el => el.getBoundingClientRect().height)).toBe(44);
      const primary = (await button.getAttribute("class"))!.includes("button-primary");
      await expect(button).toHaveCSS("width", primary ? "164px" : "82px");
      await expect(button).toHaveCSS("background-color", primary ? "rgb(18, 18, 18)" : "rgb(255, 255, 255)");
    }
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("preview-findings.png"), animations: "disabled" });
    await page.locator(".report-section summary").click();
    await expect(page.locator(".report-preview table")).toHaveCount(2);
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("preview-report.png"), animations: "disabled" });
    expect(requests).toEqual([]);
  });
}
