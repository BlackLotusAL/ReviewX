import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCommand } from "@/src/cli/resolve-command";
import { runProcess, type ResolvedCommand } from "@/src/server/process";

function requireSuccess(label: string, result: Awaited<ReturnType<typeof runProcess>>): void {
  if (result.exitCode !== 0 || result.timedOut || result.aborted || result.outputLimitExceeded) {
    throw new Error(`${label} failed (${String(result.exitCode)}):\n${result.stdout}\n${result.stderr}`);
  }
}

async function waitFor<T>(label: string, read: () => T | undefined | Promise<T | undefined>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function serviceEnvironment(localAppData: string, browser: "fail" | "skip"): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOCALAPPDATA: localAppData,
    REVIEWX_TEST_MODE: "1",
    REVIEWX_TEST_BROWSER: browser,
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

async function startService(command: ResolvedCommand, environment: NodeJS.ProcessEnv, browserFailureExpected: boolean) {
  const controller = new AbortController();
  let stdout = "";
  let stderr = "";
  const running = runProcess(command, [], {
    timeoutMs: 180_000,
    signal: controller.signal,
    env: environment,
    maxOutputBytes: 16 * 1024 * 1024,
    onStdout: (chunk) => { stdout += chunk; },
    onStderr: (chunk) => { stderr += chunk; },
  });
  const url = await waitFor("ReviewX startup URL", () => stdout.match(/ReviewX 已启动：(http:\/\/127\.0\.0\.1:\d+)/u)?.[1]);
  if (browserFailureExpected) await waitFor("browser failure diagnostic", () => stderr.includes("无法自动打开默认浏览器") ? true : undefined);
  return { controller, running, url, stdout: () => stdout, stderr: () => stderr };
}

async function waitUntilClosed(url: string): Promise<void> {
  await waitFor("released HTTP port", async () => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(400) });
      return undefined;
    } catch {
      return true;
    }
  }, 20_000);
}

if (process.platform !== "win32") throw new Error("ReviewX package verification is Windows-only.");

const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-package-test-"));
const packDirectory = path.join(root, "pack");
const installDirectory = path.join(root, "install");
const localAppData = path.join(root, "local-app-data");
let first: Awaited<ReturnType<typeof startService>> | undefined;
let third: Awaited<ReturnType<typeof startService>> | undefined;
try {
  const npm = await resolveCommand("npm", process.env);
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(installDirectory, { recursive: true }),
  ]));
  const packed = await runProcess(npm, ["pack", "--pack-destination", packDirectory], {
    cwd: process.cwd(), timeoutMs: 300_000, env: process.env, maxOutputBytes: 64 * 1024 * 1024,
  });
  requireSuccess("npm pack", packed);
  const tarballName = (await readdir(packDirectory)).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error("npm pack did not create a tarball.");
  const tarball = path.join(packDirectory, tarballName);

  const installed = await runProcess(npm, ["install", "--prefix", installDirectory, "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: root, timeoutMs: 600_000, env: process.env, maxOutputBytes: 64 * 1024 * 1024,
  });
  requireSuccess("isolated npm install", installed);
  const packageRoot = path.join(installDirectory, "node_modules", "reviewx");
  await Promise.all([
    stat(path.join(packageRoot, "dist", "reviewx.js")),
    stat(path.join(packageRoot, ".next", "BUILD_ID")),
    stat(path.join(packageRoot, "README.md")),
  ]);

  const binDirectory = path.join(installDirectory, "node_modules", ".bin");
  const environment = {
    ...serviceEnvironment(localAppData, "fail"),
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    Path: `${binDirectory}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ""}`,
  };
  const reviewx = await resolveCommand("reviewx", environment);
  const rejectedLegacy = await runProcess(reviewx, ["serve"], { timeoutMs: 30_000, env: environment });
  if (rejectedLegacy.exitCode !== 2 || !rejectedLegacy.stderr.includes("用法：reviewx")) throw new Error("Legacy ReviewX command was not rejected.");

  first = await startService(reviewx, environment, true);
  const parsed = new URL(first.url);
  if (parsed.hostname !== "127.0.0.1" || parsed.port === "3210" || !parsed.port) throw new Error(`Unexpected service address ${first.url}.`);
  const page = await fetch(first.url);
  if (!page.ok || !(await page.text()).includes("ReviewX")) throw new Error("Installed ReviewX page did not load.");
  const lock = JSON.parse(await readFile(path.join(localAppData, "ReviewX", "instance.lock"), "utf8")) as { url?: string };
  if (lock.url !== first.url) throw new Error("Instance lock did not store the advertised URL.");

  const second = await runProcess(reviewx, [], { timeoutMs: 60_000, env: { ...environment, REVIEWX_TEST_BROWSER: "skip" } });
  requireSuccess("second ReviewX invocation", second);
  if (!second.stdout.includes(`ReviewX 已在运行：${first.url}`)) throw new Error("Second invocation did not return the existing URL.");

  first.controller.abort();
  const stopped = await first.running;
  if (!stopped.aborted) throw new Error("Package test could not terminate the first service tree.");
  await waitUntilClosed(first.url);
  first = undefined;

  third = await startService(reviewx, { ...environment, REVIEWX_TEST_BROWSER: "skip" }, false);
  const restartedPage = await fetch(third.url);
  if (!restartedPage.ok) throw new Error("ReviewX could not restart after stale-lock recovery.");
  third.controller.abort();
  await third.running;
  await waitUntilClosed(third.url);
  third = undefined;

  process.stdout.write(`Package verification passed for ${tarballName}.\n`);
} finally {
  first?.controller.abort();
  third?.controller.abort();
  await Promise.all([first?.running.catch(() => undefined), third?.running.catch(() => undefined)]);
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
