import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createServer, type RequestListener, type Server } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AppError, isAppError, unexpectedError } from "../server/errors";
import { InstanceLock } from "../server/instance-lock";
import { createLogFile, Logger } from "../server/logger";
import { ensureDataPaths, resolveDataPaths } from "../server/paths";
import { runProcess, terminateAllChildProcesses, type ResolvedCommand } from "../server/process";
import { initializeRuntime, type ReviewXRuntime } from "../server/runtime";

const HOST = "127.0.0.1";

function usage(): string {
  return "用法：reviewx";
}

function assertPlatform(): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (process.platform !== "win32") throw new AppError({
    code: "UNSUPPORTED_PLATFORM",
    message: "ReviewX v1 仅支持 Windows。",
    reason: `当前平台为 ${process.platform}。`,
    impact: "Web 服务未启动。",
    nextStep: "请在 Windows 10/11 上运行 ReviewX。",
    technical: `Unsupported platform ${process.platform}.`,
  });
  if (!Number.isFinite(major) || major < 22) throw new AppError({
    code: "UNSUPPORTED_NODE",
    message: "ReviewX 需要 Node.js 22 或更高版本。",
    reason: `当前 Node.js 版本为 ${process.versions.node}。`,
    impact: "Web 服务未启动。",
    nextStep: "升级 Node.js 后重新运行 reviewx。",
    technical: `Unsupported Node.js ${process.versions.node}.`,
  });
}

function findPackageRoot(start: string): string {
  let current = path.resolve(start);
  while (path.dirname(current) !== current) {
    const packageJson = path.join(current, "package.json");
    if (fs.existsSync(packageJson)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8")) as { name?: string };
        if (parsed.name === "reviewx") return current;
      } catch {
        // Continue toward the filesystem root.
      }
    }
    current = path.dirname(current);
  }
  throw new Error("Unable to locate ReviewX package root.");
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not expose a TCP port.");
  return address.port;
}

async function cleanupStaleWorkspaces(root: string, logger: Logger): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch (error) {
    logger.error({}, new AppError({
      code: "WORKSPACE_CLEANUP_ERROR",
      message: "ReviewX 无法检查遗留工作区。",
      reason: "workspaces 目录不可读。",
      impact: "旧临时目录可能仍留在本机，但不会复用。",
      nextStep: "检查目录权限并人工清理。",
      technical: error instanceof Error ? error.message : String(error),
      cause: error,
    }));
    return;
  }
  for (const entry of entries) {
    const target = path.resolve(root, entry);
    if (path.dirname(target) !== path.resolve(root) || target === path.resolve(root)) continue;
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch((error) => {
      logger.error({}, new AppError({
        code: "WORKSPACE_CLEANUP_ERROR",
        message: "ReviewX 无法清理一个遗留工作区。",
        reason: "目录被占用或不可删除。",
        impact: "该临时目录仍留在本机，但不会复用。",
        nextStep: "关闭占用进程并人工删除。",
        technical: `${target}: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      }));
    });
  }
}

async function openBrowser(url: string, environment: NodeJS.ProcessEnv): Promise<void> {
  if (environment.REVIEWX_TEST_MODE === "1") {
    if (environment.REVIEWX_TEST_BROWSER === "fail") throw new Error("Injected browser launch failure.");
    if (environment.REVIEWX_TEST_BROWSER === "skip") return;
  }
  const executable = path.join(environment.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe");
  const command: ResolvedCommand = { name: "default browser", executable, prefixArgs: [] };
  const result = await runProcess(command, ["url.dll,FileProtocolHandler", url], {
    timeoutMs: 15_000,
    env: environment,
    maxOutputBytes: 1024 * 1024,
  });
  if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) throw new Error(`Browser opener exited with ${String(result.exitCode)}.`);
}

export async function runWeb(environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  let logger: Logger | null = null;
  let logFile: string | null = null;
  let instanceLock: InstanceLock | null = null;
  let server: Server | null = null;
  let runtime: ReviewXRuntime | null = null;
  let activeHandler: RequestListener = (_request, response) => {
    response.statusCode = 503;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("ReviewX 正在启动。\n");
  };
  try {
    const paths = resolveDataPaths(environment);
    ensureDataPaths(paths);
    logFile = createLogFile(paths);
    logger = new Logger(logFile, environment);
    logger.info({}, "ReviewX service session is starting.");
    assertPlatform();
    const acquired = await InstanceLock.acquire(paths.instanceLockFile);
    if ("existingUrl" in acquired) {
      logger.info({}, `A ReviewX instance is already running at ${acquired.existingUrl}.`);
      process.stdout.write(`ReviewX 已在运行：${acquired.existingUrl}\n日志文件：${logFile}\n`);
      return 0;
    }
    instanceLock = acquired.lock;
    server = createServer((request, response) => activeHandler(request, response));
    const port = await listen(server);
    const origin = `http://${HOST}:${port}`;
    await instanceLock.setUrl(origin);
    Object.assign(process.env, environment, {
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      REVIEWX_LOG_FILE: logFile,
      REVIEWX_ORIGIN: origin,
    });
    await cleanupStaleWorkspaces(paths.workspaces, logger);
    runtime = await initializeRuntime(paths, logger);

    const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
    const { default: next } = await import("next");
    const application = next({ dev: false, dir: packageRoot, hostname: HOST, port, quiet: true });
    await application.prepare();
    const nextHandler = application.getRequestHandler();
    activeHandler = (request, response) => {
      if (request.headers.host !== `${HOST}:${port}`) {
        response.statusCode = 421;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end("ReviewX 已拒绝非本机 Host。\n");
        return;
      }
      void nextHandler(request, response).catch((error: unknown) => {
        const appError = unexpectedError(error, "Web 请求");
        try { logger?.error({}, appError); } catch { /* Fatal logger state is already recorded. */ }
        if (!response.headersSent) {
          response.statusCode = 500;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
        }
        if (!response.writableEnded) response.end("ReviewX 请求处理失败。\n");
      });
    };
    logger.info({}, `ReviewX is listening on ${origin}.`);
    process.stdout.write(`ReviewX 已启动：${origin}\n日志文件：${logFile}\n`);
    try {
      await openBrowser(origin, environment);
    } catch (error) {
      const browserError = new AppError({
        code: "BROWSER_OPEN_ERROR",
        message: "ReviewX 无法自动打开默认浏览器。",
        reason: "Windows 浏览器启动器返回失败。",
        impact: `Web 服务继续运行，可手动访问 ${origin}。`,
        nextStep: `在浏览器中打开 ${origin}。`,
        technical: error instanceof Error ? error.message : String(error),
        cause: error,
      });
      try { logger.error({}, browserError); } catch { /* Fatal logger state is already recorded. */ }
      process.stderr.write(`${browserError.message} 请手动访问 ${origin}\n`);
    }

    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      try { logger?.info({}, "ReviewX service session is stopping."); } catch { /* Ignore unavailable log during shutdown. */ }
      await runtime?.shutdown().catch(() => undefined);
      await terminateAllChildProcesses();
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await instanceLock?.release().catch(() => undefined);
      process.exitCode = 0;
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    return await new Promise<number>((resolve) => {
      server!.once("close", () => resolve(0));
    });
  } catch (error) {
    const appError = isAppError(error) ? error : unexpectedError(error, "启动");
    try { logger?.error({}, appError); } catch { /* Terminal remains available. */ }
    process.stderr.write(`${appError.message}\n`);
    if (logFile) process.stderr.write(`日志文件：${logFile}\n`);
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await instanceLock?.release().catch(() => undefined);
    return 1;
  }
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.exitCode = await runWeb();
  } else if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    process.stdout.write(`${usage()}\n`);
  } else {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
  }
}
