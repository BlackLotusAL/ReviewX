import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { AppError } from "./errors";

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeStaleLock(path: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    if (typeof parsed.pid === "number" && processAlive(parsed.pid)) return false;
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

export class FileLock {
  #released = false;
  private constructor(readonly path: string, private readonly handle: FileHandle) {}

  static async acquire(path: string): Promise<FileLock> {
    await mkdir(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx");
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
        await handle.sync();
        return new FileLock(path, handle);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST" && attempt === 0 && await removeStaleLock(path)) continue;
        throw new AppError({
          code: "STATE_LOCKED",
          message: "ReviewX 无法取得状态文件锁。",
          reason: "另一个写入正在更新本地状态，或残留锁无法安全确认。",
          impact: "当前状态变更未执行。",
          nextStep: "确认没有其他 ReviewX 实例后重新操作。",
          technical: error instanceof Error ? error.message : String(error),
          httpStatus: 409,
          cause: error,
        });
      }
    }
    throw new Error("Unreachable lock acquisition state.");
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    await this.handle.close();
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lock = await FileLock.acquire(path);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}
