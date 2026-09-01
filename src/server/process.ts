import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError } from "./errors";

export interface ResolvedCommand {
  name: string;
  executable: string;
  prefixArgs: string[];
  powerShellScript?: string;
}

export interface ProcessResult {
  started: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  input?: string;
  stdoutFile?: string;
}

const registrySymbol = Symbol.for("reviewx.child-processes");

interface SpawnTarget {
  executable: string;
  args: string[];
  cleanup?: () => Promise<void>;
}

function processStartError(command: ResolvedCommand, error: unknown): AppError {
  return new AppError({
    code: "PROCESS_START_ERROR",
    message: `ReviewX 无法启动 ${command.name}。`,
    reason: "外部进程未能启动。",
    impact: "当前操作未完成。",
    nextStep: `检查 ${command.name} 安装与权限后重试。`,
    technical: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

// Windows PowerShell 5.1 removes embedded quotes when an npm .ps1 shim
// forwards $args to a native executable. Preserve the quote and every slash
// that immediately precedes it. PowerShell 7's Standard argument passing does
// not need this compatibility transform.
function escapeLegacyPowerShellNativeArgument(argument: string): string {
  return argument.replace(
    /(\\*)"/gu,
    (_match, backslashes: string) => `${backslashes}${backslashes}\\"`,
  );
}

async function prepareSpawnTarget(
  command: ResolvedCommand,
  args: string[],
): Promise<SpawnTarget> {
  if (!command.powerShellScript) {
    return {
      executable: command.executable,
      args: [...command.prefixArgs, ...args],
    };
  }

  let temporaryDirectory: string;
  try {
    temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "reviewx-powershell-"),
    );
  } catch (error) {
    throw processStartError(command, error);
  }
  const argumentsPath = path.join(temporaryDirectory, "arguments.json");
  const wrapperPath = path.join(temporaryDirectory, "invoke.ps1");
  const legacyPowerShell = path.basename(command.executable).toLowerCase() === "powershell.exe";
  const scriptArguments = legacyPowerShell
    ? args.map(escapeLegacyPowerShellNativeArgument)
    : [...args];
  const encodedScriptPath = Buffer.from(command.powerShellScript, "utf8").toString("base64");
  const encodedArgumentsPath = Buffer.from(argumentsPath, "utf8").toString("base64");
  const wrapper = [
    "$ErrorActionPreference = 'Stop'",
    "$utf8 = New-Object System.Text.UTF8Encoding($false)",
    "[Console]::InputEncoding = $utf8",
    "[Console]::OutputEncoding = $utf8",
    "$OutputEncoding = $utf8",
    "$codePage = [IO.Path]::Combine($env:SystemRoot, 'System32', 'chcp.com')",
    "if ([IO.File]::Exists($codePage)) { & $codePage 65001 | Out-Null }",
    "if (Test-Path -LiteralPath variable:PSNativeCommandArgumentPassing) { $PSNativeCommandArgumentPassing = 'Standard' }",
    `$scriptPath = $utf8.GetString([Convert]::FromBase64String('${encodedScriptPath}'))`,
    `$argumentsPath = $utf8.GetString([Convert]::FromBase64String('${encodedArgumentsPath}'))`,
    "$payload = [IO.File]::ReadAllText($argumentsPath, $utf8) | ConvertFrom-Json",
    "$scriptArguments = [object[]]$payload.arguments",
    "& $scriptPath @scriptArguments",
    "if ($null -eq $LASTEXITCODE) { exit 0 }",
    "exit $LASTEXITCODE",
  ].join("\n");

  try {
    await fs.writeFile(
      argumentsPath,
      JSON.stringify({ arguments: scriptArguments }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await fs.writeFile(wrapperPath, wrapper, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw processStartError(command, error);
  }

  return {
    executable: command.executable,
    args: [...command.prefixArgs, "-File", wrapperPath],
    cleanup: () => fs.rm(temporaryDirectory, { recursive: true, force: true }),
  };
}

function processRegistry(): Set<number> {
  const globalRegistry = globalThis as typeof globalThis & { [registrySymbol]?: Set<number> };
  globalRegistry[registrySymbol] ??= new Set<number>();
  return globalRegistry[registrySymbol];
}

async function killProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
        shell: false,
      });
      killer.once("error", () => {
        child.kill("SIGKILL");
        resolve();
      });
      killer.once("close", (exitCode) => {
        if (exitCode !== 0) child.kill("SIGKILL");
        resolve();
      });
    });
  } else {
    child.kill("SIGKILL");
  }
}

export async function terminateAllChildProcesses(): Promise<void> {
  const pids = [...processRegistry()];
  await Promise.all(
    pids.map(
      (pid) =>
        new Promise<void>((resolve) => {
          if (process.platform === "win32") {
            const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
              windowsHide: true,
              stdio: "ignore",
              shell: false,
            });
            killer.once("error", () => {
              try {
                process.kill(pid, "SIGKILL");
              } catch {
                // Process already exited.
              }
              resolve();
            });
            killer.once("close", (exitCode) => {
              if (exitCode !== 0) {
                try {
                  process.kill(pid, "SIGKILL");
                } catch {
                  // Process already exited.
                }
              }
              resolve();
            });
          } else {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // Process already exited.
            }
            resolve();
          }
        }),
    ),
  );
}

export async function runProcess(
  command: ResolvedCommand,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const target = await prepareSpawnTarget(command, args);
  try {
    return await new Promise<ProcessResult>((resolve, reject) => {
      const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
      let child: ReturnType<typeof spawn>;
      let stdoutFileDescriptor: number | undefined;
      try {
        if (options.stdoutFile) {
          stdoutFileDescriptor = fsSync.openSync(options.stdoutFile, "wx", 0o600);
        }
        child = spawn(target.executable, target.args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          windowsHide: true,
          shell: false,
          stdio: [options.input === undefined ? "ignore" : "pipe", stdoutFileDescriptor ?? "pipe", "pipe"],
        });
      } catch (error) {
        if (stdoutFileDescriptor !== undefined) fsSync.closeSync(stdoutFileDescriptor);
        reject(processStartError(command, error));
        return;
      }
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let started = false;
      let timedOut = false;
      let aborted = false;
      let outputLimitExceeded = false;
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortHandler);
        if (child.pid) processRegistry().delete(child.pid);
        if (stdoutFileDescriptor !== undefined) {
          fsSync.closeSync(stdoutFileDescriptor);
          stdoutFileDescriptor = undefined;
        }
      };

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          started,
          exitCode,
          signal,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          timedOut,
          aborted,
          outputLimitExceeded,
        });
      };

      const stop = async () => {
        await killProcessTree(child);
      };

      const append = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
        if (stream === "stdout") stdoutBytes += chunk.length;
        else stderrBytes += chunk.length;
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          outputLimitExceeded = true;
          void stop();
          return;
        }
        target.push(chunk);
        if (stream === "stdout") options.onStdout?.(chunk.toString("utf8"));
        else options.onStderr?.(chunk.toString("utf8"));
      };

      child.stdout?.on("data", (chunk: Buffer) => append(stdoutChunks, chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => append(stderrChunks, chunk, "stderr"));
      child.once("spawn", () => {
        started = true;
        if (child.pid) processRegistry().add(child.pid);
        if (options.input !== undefined) child.stdin?.end(options.input, "utf8");
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(processStartError(command, error));
      });
      child.once("close", finish);

      const timeout = setTimeout(() => {
        timedOut = true;
        void stop();
      }, options.timeoutMs);
      timeout.unref();

      const abortHandler = () => {
        aborted = true;
        void stop();
      };
      options.signal?.addEventListener("abort", abortHandler, { once: true });
      if (options.signal?.aborted) abortHandler();
    });
  } finally {
    await target.cleanup?.().catch(() => undefined);
  }
}
