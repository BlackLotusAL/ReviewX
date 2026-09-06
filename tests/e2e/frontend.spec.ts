import { expect, test, type Page } from "@playwright/test";
import type { AppStateView, AttemptStatus, MrDetailView, SafeErrorView } from "@/src/shared/types";

const at = "2026-09-06T10:24:00Z";
const failure: SafeErrorView = { code: "REVIEW_INCOMPLETE", message: "检视未完成。", cause: "必要调用方未取得。", impact: "本次不生成可处理意见或 PASS。", nextStep: "补齐上下文后重新检视。", technicalDetails: "Verification context unavailable." };

function fixtures(status: AttemptStatus = "awaiting_confirmation") {
  const mr = { projectId: "101", iid: "42", title: "修复解析器边界条件，完善配置读取与错误反馈", state: "open", updatedAt: at, sourceBranch: "fix/parser-validation", targetBranch: "main", webUrl: "https://codehub.example/platform/review-engine/merge_requests/42" };
  const findings = [{ ordinal: 1, severity: "major" as const, status: "pending" as const, confidence: 96, verificationSummary: "已核对配置读取入口及下游调用，空输入会直接进入解析分支。", body: "### 空配置会中断后续的检视任务\n\n配置文件存在但内容为空时，解析函数仍尝试读取首个节点。该异常会提前退出，使剩余任务无法完成。\n\n建议在解析之前检查输入，并返回明确的空配置结果。\n\n```ts\nif (!source.trim()) {\n  return { entries: [], warnings: [] };\n}\n```\n\n这项检查应保留原有调用顺序。" },
    { ordinal: 2, severity: "suggestion" as const, status: "pending" as const, confidence: 92, verificationSummary: "已核对相关测试，当前覆盖正常输入，但缺少空白文件样例。", body: "### 补充空白配置的回归测试\n\n增加纯空格和空文件两类样例，验证错误反馈与队列中的后续任务。\n\n| 输入 | 预期结果 | 后续任务 |\n| --- | --- | --- |\n| 空文件 | 空配置结果 | 正常继续 |\n| 纯空格 | 空配置结果 | 正常继续 |" }];
  const state: AppStateView = { revision: 1, refreshOperation: { status: "idle" }, publicationBusy: false, fatalError: null, currentLogUrl: "/api/logs/current", projects: [{ id: "101", name: "platform/review-engine", removing: false, refreshedAt: at, mergeRequests: [{ ...mr, status, latestAttemptId: "latest", phase: status === "reviewing" ? "verifying_findings" : undefined, primaryAction: status === "reviewing" ? "stop" : "rereview" }, { ...mr, iid: "43", title: "为队列任务补充取消与清理测试", status: "unreviewed", primaryAction: "start" }] }] };
  const detail: MrDetailView = { project: { id: "101", name: "platform/review-engine", registered: true }, mergeRequest: mr, attempts: [{ id: "latest", projectId: "101", mrIid: "42", mrTitle: mr.title, requestedUpdatedAt: at, createdAt: at, status, phase: status === "reviewing" ? "verifying_findings" : undefined, findings: status === "awaiting_confirmation" ? findings : [], publishBatches: [], result: status === "completed" ? "pass" : status === "awaiting_confirmation" ? "findings" : undefined, reportUrl: ["completed", "awaiting_confirmation"].includes(status) ? "/api/reports/latest" : undefined, error: status === "review_failed" ? failure : undefined }, { id: "history", projectId: "101", mrIid: "42", mrTitle: mr.title, requestedUpdatedAt: at, createdAt: at, status: "archived", findings: findings.map(f => ({ ...f, status: "archived" })), publishBatches: [], reportUrl: "/api/reports/history" }] };
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
  await expect(page.locator("#project-error")).toContainText("补齐上下文后重新检视。");
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

test("polling and decisions preserve content, scroll position and one-shot transitions", async ({ page }) => {
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
  expect(await card.evaluate(el => el.getBoundingClientRect().height)).toBe(cardHeight);
  expect(await dialog.evaluate(el => el.scrollTop)).toBe(scroll);
  expect(await secondCard.evaluate(el => el.getBoundingClientRect().top)).toBe(secondY);
  await expect(card.locator(".markdown")).toContainText("这项检查应保留原有调用顺序。");
  const content = await card.locator(".markdown").elementHandle();
  const nextPoll = page.waitForResponse("**/api/state");
  await nextPoll;
  expect(await content!.evaluate(el => el.isConnected)).toBe(true);
  expect(await dialog.evaluate(el => el.scrollTop)).toBe(scroll);
  // Background polling must neither replay entry animation nor repeatedly announce unchanged results.
  const announcement = await dialog.locator(".drawer-live").textContent();
  await page.waitForResponse("**/api/state");
  expect(await dialog.locator(".drawer-live").textContent()).toBe(announcement);
  expect(await page.locator(".mr-card").first().evaluate(el => el.getAnimations().length)).toBe(0);
  expect(await dialog.locator(".findings-section").evaluate(el => Boolean(el.compareDocumentPosition(document.querySelector(".report-section")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
});

test("closing a loading drawer ignores late responses and reduced motion stays static", async ({ page }) => {
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
  expect(await page.locator(".detail-drawer").evaluate(el => getComputedStyle(el).animationName)).toBe("none");
  expect(await page.locator(".skeleton-row > span").first().evaluate(el => getComputedStyle(el).animationName)).toBe("none");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  resolveDetail();
  await page.waitForResponse("**/api/mrs/101/42");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.locator(".spinner").first().evaluate(el => getComputedStyle(el).animationName)).toBe("none");
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`layout and local fonts at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
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
    expect(await page.evaluate(() => [...document.fonts].filter(f => f.status === "loaded").map(f => f.family))).toEqual(expect.arrayContaining(["Inter", "Geist Mono"]));
    expect(fontResponses).toEqual([200, 200]);
    if (viewport.width === 1440) {
      const session = await page.context().newCDPSession(page);
      await session.send("DOM.enable"); await session.send("CSS.enable");
      const doc = await session.send("DOM.getDocument");
      const node = await session.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#mr-heading" });
      console.log("Rendered heading fonts:", (await session.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId })).fonts.map(f => f.familyName));
      await session.detach();
    }
    expect(external).toEqual([]);
    await noOverflow(page);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("empty.png"), fullPage: true });
    data.state.projects = populated.projects;
    data.state.revision++;
    await expect(page.locator(".mr-open").first()).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("queue.png"), fullPage: true });
    await page.locator(".mr-open").first().click();
    await expect(page.locator(".finding-card")).toHaveCount(2);
    await noOverflow(page);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("findings.png") });
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
      await expect(page.locator(".attempt-overview .status")).toHaveText(status === "reviewing" ? "检视中" : status === "completed" ? "已完成" : "检视未完成");
      await page.locator(".detail-drawer").evaluate(el => { el.scrollTop = 0; });
      await noOverflow(page);
      await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`${status}.png`) });
    }
  });
}
