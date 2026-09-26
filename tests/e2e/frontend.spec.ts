import { expect, test, type Page } from "@playwright/test";
import type { AppStateView, AttemptStatus, MrDetailView, SafeErrorView } from "@/src/shared/types";

const at = "2026-09-06T10:24:00Z";
const failure: SafeErrorView = { code: "OPENCODE_FAILED", message: "检视失败。", cause: "OpenCode 进程执行失败。", impact: "本次不生成可处理意见或 PASS。", nextStep: "检查 OpenCode 日志后重新检视。", technicalDetails: "OpenCode process exited with code 1." };

function fixtures(status: AttemptStatus = "awaiting_confirmation") {
  const mr = { projectId: "101", iid: "42", title: "修复解析器边界条件，完善配置读取与错误反馈", state: "open", updatedAt: at, sourceBranch: "fix/parser-validation", targetBranch: "main", webUrl: "https://codehub.example/platform/review-engine/merge_requests/42" };
  const findings = [{ ordinal: 1, severity: "major" as const, status: "pending" as const, body: "### 空配置会中断后续的检视任务\n\n配置文件存在但内容为空时，解析函数仍尝试读取首个节点。该异常会提前退出，使剩余任务无法完成。\n\n建议在解析之前检查输入，并返回明确的空配置结果。\n\n```ts\nif (!source.trim()) {\n  return { entries: [], warnings: [] };\n}\n```\n\n这项检查应保留原有调用顺序。" },
    { ordinal: 2, severity: "suggestion" as const, status: "pending" as const, body: "### 补充空白配置的回归测试\n\n增加纯空格和空文件两类样例，验证错误反馈与队列中的后续任务。\n\n| 输入 | 预期结果 | 后续任务 |\n| --- | --- | --- |\n| 空文件 | 空配置结果 | 正常继续 |\n| 纯空格 | 空配置结果 | 正常继续 |" }];
  const state: AppStateView = { revision: 1, refreshOperation: { status: "idle" }, publicationBusy: false, fatalError: null, currentLogUrl: "/api/logs/current", projects: [{ id: "101", name: "platform/review-engine", webUrl: "https://codehub.example/platform/review-engine", removing: false, refreshedAt: at, mergeRequests: [{ ...mr, status, latestAttemptId: "latest", phase: status === "reviewing" ? "running_opencode" : undefined, primaryAction: status === "reviewing" ? "stop" : "rereview" }, { ...mr, iid: "43", title: "为队列任务补充取消与清理测试", status: "unreviewed", primaryAction: "start" }] }] };
  const detail: MrDetailView = { project: { id: "101", name: "platform/review-engine", registered: true }, mergeRequest: mr, attempts: [{ id: "latest", projectId: "101", mrIid: "42", mrTitle: mr.title, requestedUpdatedAt: at, createdAt: at, status, phase: status === "reviewing" ? "running_opencode" : undefined, findings: status === "awaiting_confirmation" ? findings : [], publishBatches: [], result: status === "completed" ? "pass" : status === "awaiting_confirmation" ? "findings" : undefined, reportUrl: ["completed", "awaiting_confirmation"].includes(status) ? "/api/reports/latest" : undefined, error: status === "review_failed" ? failure : undefined }, { id: "history", projectId: "101", mrIid: "42", mrTitle: mr.title, requestedUpdatedAt: at, createdAt: at, status: "archived", findings: findings.map(f => ({ ...f, status: "archived" })), publishBatches: [], reportUrl: "/api/reports/history" }] };
  return { state, detail };
}

async function intercept(page: Page, data: ReturnType<typeof fixtures>) {
  await page.route("**/api/state", route => route.fulfill({ json: data.state }));
  await page.route("**/api/mrs/101/*", route => route.fulfill({ json: data.detail }));
  await page.route("**/api/reports/*", route => route.fulfill({ contentType: "text/plain", body: "# 完整检视报告\n\n固定提交、查证过程和检视局限。" }));
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const dialog = page.getByRole("dialog");
  if (await dialog.count()) {
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await dialog.evaluate(el => el.getBoundingClientRect().left)).toBeGreaterThanOrEqual(0);
  }
}

for (const status of ["completed", "awaiting_confirmation"] as const) {
  test(`partial review remains distinct from PASS while ${status}`, async ({ page }) => {
    const data = fixtures(status);
    data.state.projects[0].mergeRequests[0].result = "partial";
    data.detail.attempts[0].result = "partial";
    data.detail.attempts[0].progress = { toolCount: 10, deliveredMaterials: 8, requiredMaterials: 10, limitations: ["缺失必需材料：2 项。"] };
    await intercept(page, data); await page.goto("/");
    await expect(page.locator("#mr-101-42")).toContainText("部分完成");
    await page.locator("#mr-101-42 .mr-open").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "部分完成", exact: true })).toBeVisible();
    await expect(dialog).toContainText("缺失必需材料：2 项。");
    await expect(dialog.getByText("未发现问题。", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "发送到 CodeHub" })).toHaveCount(status === "awaiting_confirmation" ? 2 : 0);
  });
}

for (const outcome of ["failed", "unknown"] as const) {
  test(`queue retains publishing and ${outcome} findings after review`, async ({ page }) => {
    const data = fixtures("reviewing");
    await intercept(page, data);
    await page.goto("/");
    await page.getByRole("button", { name: "当前检视队列", exact: true }).click();
    const entry = page.locator('.queue-entry[href="#mr-101-42"]');
    await expect(entry.locator(".status")).toHaveText("检视中");
    data.detail = fixtures().detail;
    data.state.projects[0].mergeRequests[0].status = "awaiting_confirmation";
    data.state.revision++;
    await expect(entry.locator(".status")).toHaveText("待处理");
    await entry.click();
    await expect(page.locator("#mr-101-42")).toBeFocused();
    await page.getByRole("button", { name: "当前检视队列", exact: true }).click();
    data.state.projects[0].mergeRequests[0].status = "publishing";
    data.detail.attempts[0].status = "publishing";
    data.state.revision++;
    await expect(entry.locator(".status")).toHaveText("发送中");
    await expect(page.locator(".queue-heading")).toContainText("执行中 1 · 排队 0 · 待处理 0 · 发布失败 0");
    data.detail.attempts[0].findings[0].status = outcome;
    data.detail.attempts[0].findings[1].status = "dismissed";
    data.detail.attempts[0].status = "publish_failed";
    data.state.projects[0].mergeRequests[0].status = "publish_failed";
    data.state.revision++;
    await expect(entry.locator(".status")).toHaveText("发布失败");
    await expect(page.locator(".queue-heading")).toContainText("执行中 0 · 排队 0 · 待处理 0 · 发布失败 1");
  });
}

test("state polling recovers automatically without a manual retry button", async ({ page }) => {
  const data = fixtures();
  let healthy = false;
  let active = 0;
  let maxActive = 0;
  await page.route("**/api/state", async route => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 1200));
    active--;
    if (healthy) await route.fulfill({ json: data.state });
    else await route.abort("failed");
  });
  await page.goto("/");
  await expect(page.locator(".mr-panel > .diagnostic")).toBeVisible();
  await expect(page.getByRole("button", { name: "重新读取状态" })).toHaveCount(0);
  healthy = true;
  await expect(page.locator(".mr-card")).toHaveCount(2);
  await expect(page.locator(".mr-panel > .diagnostic")).toHaveCount(0);
  expect(maxActive).toBe(1);
});

test("project failures preserve input; modal keyboard, history navigation, backdrop and focus restoration", async ({ page }) => {
  const data = fixtures();
  const projects = data.state.projects;
  data.state.projects = [];
  await intercept(page, data);
  await page.route("**/api/projects", route => route.fulfill({ status: 400, json: { error: { ...failure, message: "项目暂时不可用。" } } }));
  await page.goto("/");
  await page.getByLabel("Project ID").fill("987");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByLabel("Project ID")).toHaveValue("987");
  await expect(page.locator("#project-error")).toContainText("检查 OpenCode 日志后重新检视。");
  data.state.projects = projects;
  data.state.revision++;
  const opener = page.locator(".mr-open").first();
  await expect(opener).toBeVisible();
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "MR 详情抽屉" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "关闭详情" })).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  const tabs = dialog.getByRole("tab");
  await tabs.first().focus();
  await page.keyboard.press("End");
  await expect(tabs.last()).toBeFocused();
  await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("button", { name: "发送到 CodeHub" })).toHaveCount(0);
  await page.keyboard.press("Home");
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("button", { name: "发送到 CodeHub" })).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  await opener.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(10, 400);
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  data.state.projects[0].mergeRequests = [];
  data.state.revision++;
  await expect(page.locator(".mr-open")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#mr-heading")).toBeFocused();
});

test("polling and decisions preserve content, scroll position and announcements", async ({ page }) => {
  const data = fixtures();
  await intercept(page, data);
  let publishRequests = 0;
  await page.route("**/api/attempts/latest/findings/1/publish", async route => {
    publishRequests++;
    await new Promise(resolve => setTimeout(resolve, 180));
    data.detail.attempts[0].findings[0].status = "published";
    data.state.revision++;
    await route.fulfill({ json: data.state });
  });
  await page.goto("/");
  await page.locator(".mr-open").first().click();
  const dialog = page.getByRole("dialog");
  const card = dialog.locator(".finding-card").first();
  await expect(dialog.locator(".attempt-overview code")).toHaveText("latest");
  const secondCard = dialog.locator(".finding-card").nth(1);
  const button = card.getByRole("button", { name: "发送到 CodeHub" });
  await button.scrollIntoViewIfNeeded();
  const cardHeight = await card.evaluate(el => el.getBoundingClientRect().height);
  await button.click();
  const scroll = await dialog.evaluate(el => el.scrollTop);
  const secondY = await secondCard.evaluate(el => el.getBoundingClientRect().top);
  await expect(card.getByText("已发送", { exact: true })).toBeVisible();
  expect(publishRequests).toBe(1);
  await expect(card).toBeFocused();
  expect(Math.abs(await card.evaluate(el => el.getBoundingClientRect().height) - cardHeight)).toBeLessThan(1);
  expect(await dialog.evaluate(el => el.scrollTop)).toBe(scroll);
  expect(Math.abs(await secondCard.evaluate(el => el.getBoundingClientRect().top) - secondY)).toBeLessThan(1);
  await expect(card.locator(".markdown")).toContainText("这项检查应保留原有调用顺序。");
  const nextPoll = page.waitForResponse("**/api/state");
  await nextPoll;
  expect(await dialog.evaluate(el => el.scrollTop)).toBe(scroll);
  await expect(card.locator(".markdown")).toContainText("这项检查应保留原有调用顺序。");
  // Background polling must not repeatedly announce unchanged results.
  const announcement = await dialog.locator(".drawer-live").textContent();
  await page.waitForResponse("**/api/state");
  expect(await dialog.locator(".drawer-live").textContent()).toBe(announcement);
});

test("dismiss and undo preserve finding height, scroll and focus", async ({ page }) => {
  const data = fixtures();
  await intercept(page, data);
  await page.route("**/api/attempts/latest/findings/1", async route => {
    data.detail.attempts[0].findings[0].status = route.request().postDataJSON().decision;
    data.state.revision++;
    await route.fulfill({ json: data.state });
  });
  await page.goto("/");
  await page.locator(".mr-open").first().click();
  const dialog = page.getByRole("dialog");
  const card = dialog.locator(".finding-card").first();
  for (const action of ["不发送", "撤销"]) {
    const button = card.getByRole("button", { name: action, exact: true });
    await button.scrollIntoViewIfNeeded();
    const height = await card.evaluate(el => el.getBoundingClientRect().height);
    await button.click();
    const scroll = await dialog.evaluate(el => el.scrollTop);
    await expect(card.locator(".finding-header .status")).toHaveText(action === "不发送" ? "已跳过" : "待处理");
    await expect(card).toBeFocused();
    expect(await card.evaluate(el => el.getBoundingClientRect().height)).toBe(height);
    expect(await dialog.evaluate(el => el.scrollTop)).toBe(scroll);
  }
});

test("closing a loading drawer ignores late responses and restores focus", async ({ page }) => {
  const data = fixtures("reviewing");
  await intercept(page, data);
  let resolveDetail: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { resolveDetail = resolve; });
  await page.route("**/api/mrs/101/42", async route => { await gate; await route.fulfill({ json: data.detail }); });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const opener = page.locator(".mr-open").first();
  await opener.click();
  await expect(page.getByLabel("正在读取检视历史…")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  resolveDetail();
  await page.waitForResponse("**/api/mrs/101/42");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("desktop content remains usable through empty, populated and long-content states", async ({ page }) => {
  const data = fixtures();
  const populated = structuredClone(data.state);
  data.state.projects = [];
  await intercept(page, data);
  const external: string[] = [];
  await page.route("**/*", async route => {
    if (new URL(route.request().url()).hostname !== "127.0.0.1") { external.push(route.request().url()); await route.abort(); }
    else await route.fallback();
  });
  const fontResponses: number[] = [];
  page.on("response", response => { if (new URL(response.url()).pathname.startsWith("/fonts/") && response.url().endsWith(".woff2")) fontResponses.push(response.status()); });
  await page.goto("/");
  await expect(page.locator(".welcome")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(external).toEqual([]);
  await noOverflow(page);
  data.state.projects = populated.projects;
  data.state.revision++;
  await expect(page.locator(".mr-open").first()).toBeVisible();
  // Wait for local font requests before checking resource availability.
  await page.evaluate(() => document.fonts.ready);
  expect(fontResponses.length).toBeGreaterThanOrEqual(2);
  expect(fontResponses.every(status => status === 200)).toBe(true);
  await noOverflow(page);
  await page.locator(".mr-open").first().click();
  await expect(page.locator(".finding-card")).toHaveCount(2);
  data.detail.attempts[0].id = `attempt-${"long-identifier-".repeat(16)}`;
  data.state.revision++;
  await expect(page.locator(".attempt-overview code")).toHaveText(data.detail.attempts[0].id);
  await noOverflow(page);
  // Exercise unbroken code and wide tables inside their own scroll containers.
  data.detail.attempts[0].findings[0].body += `\n\n\`\`\`\n${"very_long_identifier_".repeat(30)}\n\`\`\`\n\n| ${Array.from({ length: 12 }, (_, i) => `列 ${i}`).join(" | ")} |\n| ${Array(12).fill("---").join(" | ")} |\n| ${Array(12).fill("回归样例").join(" | ")} |`;
  data.state.revision++;
  await expect(page.locator(".markdown-table")).toHaveCount(2);
  await noOverflow(page);
  for (const status of ["reviewing", "completed", "review_failed"] as const) {
    const next = fixtures(status);
    data.detail = next.detail;
    data.state.projects = next.state.projects;
    data.state.revision++;
    await expect(page.locator(".attempt-overview .status")).toHaveText(status === "reviewing" ? "检视中" : status === "completed" ? "已完成" : "检视失败");
    await page.locator(".detail-drawer").evaluate(el => { el.scrollTop = 0; });
    await noOverflow(page);
  }
  expect(external).toEqual([]);
});

test("queue polling preserves collapsed directories and supports empty project anchors", async ({ page }) => {
  const data = fixtures("reviewing");
  data.state.projects.push({ id: "202", name: "platform/empty", webUrl: "https://codehub.example/platform/empty", removing: false, mergeRequests: [] });
  await intercept(page, data);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "当前检视队列", exact: true }).click();
  await expect(page.locator(".queue-entry")).toHaveCount(1);
  await page.keyboard.press("Escape");
  const directory = page.getByRole("button", { name: "platform", exact: true });
  await directory.click();
  data.state.revision += 1;
  data.state.projects[0].mergeRequests[0].status = "completed";
  await page.getByRole("button", { name: "当前检视队列", exact: true }).click();
  await expect(page.locator(".queue-empty")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(directory).toHaveAttribute("aria-expanded", "false");
  await directory.click();
  await page.getByRole("button", { name: "定位项目 platform/empty", exact: true }).click();
  await expect(page.locator("#project-202")).toBeFocused();
  await expect(page.locator("#project-202")).toBeInViewport();
});


test("project card surface navigates while external link and remove remain independent", async ({ page, context }) => {
  const data = fixtures();
  data.state.projects[0].webUrl = "https://codehub.example/project/101/home";
  await intercept(page, data);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await context.route("https://codehub.example/**", route => route.fulfill({ body: "Project home" }));
  await page.goto("/");
  const card = page.locator(".project-item").first();
  const cardBox = await card.boundingBox();
  await card.click({ position: { x: 3, y: cardBox!.height / 2 } });
  await expect(page.locator("#project-101")).toBeFocused();
  const locate = page.getByRole("button", { name: "定位项目 platform/review-engine" });
  await locate.focus();
  await locate.press("Space");
  await expect(page.locator("#project-101")).toBeFocused();
  const link = page.getByRole("link", { name: "在 CodeHub 打开 Project #101" });
  await expect(link).toHaveAttribute("href", data.state.projects[0].webUrl);
  const before = await page.evaluate(() => window.scrollY);
  const popupPromise = page.waitForEvent("popup");
  await link.click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toBe(data.state.projects[0].webUrl);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  await expect(page.locator("#project-101")).not.toBeFocused();
  await popup.close();
  await page.route("**/api/projects/101", route => route.fulfill({ status: 500, json: failure }));
  await card.getByRole("button", { name: "移除", exact: true }).click();
  await expect(page.locator("#project-101")).not.toBeFocused();
});

test("deep directories retain independently collapsible branches", async ({ page }) => {
  const data = fixtures();
  data.state.projects[0].name = "org/division/team/product/services/backend/core/review-engine";
  data.state.projects.push({ id: "202", name: "org/division/other/review-engine", webUrl: "https://codehub.example/org/division/other/review-engine", removing: false, mergeRequests: [] });
  await intercept(page, data);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "core", exact: true })).toBeVisible();
  await noOverflow(page);
  await page.getByRole("button", { name: "team", exact: true }).click();
  await expect(page.getByRole("button", { name: "core", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "other", exact: true })).toBeVisible();
});
