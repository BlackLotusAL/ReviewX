import { expect, test } from "@playwright/test";

const sample = "[2026-09-08 10:20:30.123] [INFO] [Project: demo/review (#101)] Session started.\n"
  + "[2026-09-08 10:20:32.456] [ERROR] Connection failed.\n"
  + "    Cause: Server is offline.\n    Impact: Review has stopped.\n    Next step: Check the connection.\n"
  + "    Stderr:\n      <script>window.__reviewxLogInjected = true</script>\n      <img src=x onerror=alert(1)> & <b>plain text</b>\n"
  + "Unrecognized record stays visible.\n"
  + "[2026-09-08 10:20:34.789] [INFO] Connection recovered.\n";

test("the sidebar opens the session log in a new tab", async ({ page, context }) => {
  await context.route("**/api/logs/current", route => route.fulfill({ contentType: "text/plain; charset=utf-8", body: sample }));
  await page.goto("/");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "查看当前会话日志" }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/logs$/u);
  await expect(popup.locator(".log-entry-info")).toHaveCount(2);
  await popup.close();
});

for (const viewport of [{ width: 1230, height: 900 }, { width: 390, height: 844 }]) {
  test(`readable, safe logs without controls at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const text = sample + `[2026-09-08 10:20:35.000] [INFO] ${"long_identifier_".repeat(70)}\n`;
    await page.route("**/api/logs/current", route => route.fulfill({ contentType: "text/plain; charset=utf-8", body: text }));
    await page.goto("/logs");
    await expect(page.locator(".log-entry")).toHaveCount(5);
    expect(await page.locator(".session-log").textContent()).toBe(text);
    await expect(page.locator(".log-entry-error")).toContainText("    Cause: Server is offline.");
    const logPage = page.getByRole("main", { name: "当前会话日志" });
    await expect(logPage.getByRole("button")).toHaveCount(0);
    await expect(logPage.getByRole("link")).toHaveCount(0);
    expect(await page.locator(".session-log script, .session-log img, .session-log b").count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, "__reviewxLogInjected"))).toBeUndefined();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await page.locator(".log-page").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.locator(".log-page").evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath("logs.png"), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test("new records follow the bottom while reading history preserves the viewport and text selection", async ({ page }) => {
  let text = Array.from({ length: 120 }, (_, index) => `[2026-09-08 10:20:30.123] [INFO] Record ${index + 1}.\n`).join("");
  await page.route("**/api/logs/current", route => route.fulfill({ contentType: "text/plain; charset=utf-8", body: text }));
  await page.goto("/logs");
  const viewport = page.getByRole("main", { name: "当前会话日志" });
  const distanceFromBottom = () => viewport.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect(page.locator(".log-entry")).toHaveCount(120);
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1);

  await viewport.evaluate(el => { el.scrollTop = 200; });
  await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBe(200);
  const selected = page.locator(".log-entry").nth(3);
  await selected.evaluate(el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  const selection = await page.evaluate(() => window.getSelection()?.toString());
  text += "[2026-09-08 10:20:32.123] [INFO] Appended while reading history.\n";
  await expect(page.locator(".log-entry")).toHaveCount(121);
  expect(await viewport.evaluate(el => el.scrollTop)).toBe(200);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selection);

  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await viewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1);
  text += "[2026-09-08 10:20:34.123] [INFO] Appended at the bottom.\n";
  await expect(page.locator(".log-entry")).toHaveCount(122);
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1);
});
