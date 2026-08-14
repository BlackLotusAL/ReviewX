import { spawn as nativeSpawn } from "node:child_process";
import process from "node:process";
import crossSpawn from "cross-spawn";
import { ReviewXError } from "./errors.js";

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = nativeSpawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  const force = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process has already exited.
      }
    }
  }, 1_000);
  force.unref();
}

export class DefaultCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    if (options.signal?.aborted) {
      throw new ReviewXError("PROCESS_ABORTED", `Process ${command} was aborted.`);
    }

    const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = crossSpawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let timedOut = false;
      let aborted = false;
      let overflowed = false;
      let settled = false;

      const collect = (target: Buffer[], chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.length;
        if (outputBytes > maxOutputBytes) {
          overflowed = true;
          terminateProcessTree(child.pid);
          return;
        }
        target.push(buffer);
      };
      child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));

      const timeout =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              terminateProcessTree(child.pid);
            }, options.timeoutMs);
      timeout?.unref();

      const onAbort = () => {
        aborted = true;
        terminateProcessTree(child.pid);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new ReviewXError("PROCESS_ERROR", `Unable to start process ${command}.`, {
            cause: error,
          }),
        );
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (timedOut) {
          reject(new ReviewXError("PROCESS_TIMEOUT", `Process ${command} timed out.`));
          return;
        }
        if (aborted) {
          reject(new ReviewXError("PROCESS_ABORTED", `Process ${command} was aborted.`));
          return;
        }
        if (overflowed) {
          reject(new ReviewXError("PROCESS_ERROR", `Process ${command} exceeded its output limit.`));
          return;
        }
        resolve({
          exitCode,
          signal: signal as NodeJS.Signals | null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  }
}
