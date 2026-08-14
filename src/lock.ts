import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { ReviewXError } from "./errors.js";

interface LockData {
  pid: number;
  created_at: string;
  token: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(lockPath: string): Promise<LockData | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockData>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.created_at !== "string" ||
      typeof parsed.token !== "string"
    ) {
      throw new Error("invalid lock contents");
    }
    return parsed as LockData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ReviewXError("LOCK_ERROR", `Lock file is invalid: ${lockPath}`, { cause: error });
  }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FileLock {
  private released = false;

  private constructor(
    readonly path: string,
    private readonly token: string,
  ) {}

  static async acquire(
    lockPath: string,
    options: { waitMs?: number; pollMs?: number; failFast?: boolean } = {},
  ): Promise<FileLock> {
    const waitMs = options.failFast ? 0 : (options.waitMs ?? 5_000);
    const pollMs = options.pollMs ?? 100;
    const deadline = Date.now() + waitMs;
    const token = randomUUID();
    await mkdir(path.dirname(lockPath), { recursive: true });

    while (true) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          const data: LockData = { pid: process.pid, created_at: new Date().toISOString(), token };
          await handle.writeFile(`${JSON.stringify(data)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new FileLock(lockPath, token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new ReviewXError("LOCK_ERROR", `Unable to acquire lock: ${lockPath}`, {
            cause: error,
          });
        }
        const current = await readLock(lockPath);
        if (!current) continue;
        if (!isProcessAlive(current.pid)) {
          try {
            await unlink(lockPath);
          } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new ReviewXError("LOCK_ERROR", `Lock is already held: ${lockPath}`);
        }
        await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
      }
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const current = await readLock(this.path);
    if (!current || current.token !== this.token) return;
    try {
      await unlink(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ReviewXError("LOCK_ERROR", `Unable to release lock: ${this.path}`, {
          cause: error,
        });
      }
    }
  }
}
