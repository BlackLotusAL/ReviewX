import { open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { AppError } from "./errors";

interface InstanceInfo {
  pid: number;
  startedAt: string;
  url: string | null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function validInfo(value: unknown): value is InstanceInfo {
  if (!value || typeof value !== "object") return false;
  const info = value as Partial<InstanceInfo>;
  return Number.isInteger(info.pid) && Number(info.pid) > 0 && typeof info.startedAt === "string" && (info.url === null || typeof info.url === "string");
}

async function readInfo(path: string): Promise<InstanceInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return validInfo(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function existingLiveInfo(path: string): Promise<InstanceInfo | null> {
  let info = await readInfo(path);
  if (!info || !processAlive(info.pid)) return null;
  for (let index = 0; info.url === null && index < 20; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    info = await readInfo(path);
    if (!info || !processAlive(info.pid)) return null;
  }
  return info;
}

export class InstanceLock {
  #released = false;
  private constructor(readonly path: string, private readonly handle: FileHandle, private info: InstanceInfo) {}

  static async acquire(path: string): Promise<{ lock: InstanceLock } | { existingUrl: string }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx");
        const info: InstanceInfo = { pid: process.pid, startedAt: new Date().toISOString(), url: null };
        const bytes = Buffer.from(`${JSON.stringify(info)}\n`, "utf8");
        await handle.write(bytes, 0, bytes.length, 0);
        await handle.truncate(bytes.length);
        await handle.sync();
        return { lock: new InstanceLock(path, handle, info) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new AppError({
          code: "INSTANCE_LOCK_ERROR",
          message: "ReviewX 无法取得单实例锁。",
          reason: "instance.lock 无法创建。",
          impact: "Web 服务未启动。",
          nextStep: "检查 ReviewX 数据目录权限后重试。",
          technical: error instanceof Error ? error.message : String(error),
          cause: error,
        });
        const existing = await existingLiveInfo(path);
        if (existing?.url && /^http:\/\/127\.0\.0\.1:\d+\/?$/u.test(existing.url)) return { existingUrl: existing.url };
        if (existing) throw new AppError({
          code: "INSTANCE_STARTING",
          message: "已有 ReviewX 实例正在启动。",
          reason: "单实例锁有效，但访问地址尚未写入。",
          impact: "第二个实例未创建。",
          nextStep: "稍后再次运行 reviewx 获取现有地址。",
          technical: `Existing ReviewX PID ${existing.pid} has no URL yet.`,
        });
        if (attempt === 0) {
          await unlink(path).catch(() => undefined);
          continue;
        }
      }
    }
    throw new AppError({
      code: "INSTANCE_LOCK_ERROR",
      message: "ReviewX 无法安全恢复单实例锁。",
      reason: "残留 instance.lock 无法确认或替换。",
      impact: "Web 服务未启动。",
      nextStep: "确认没有 ReviewX 进程后人工检查 instance.lock。",
      technical: "Stale instance lock recovery failed.",
    });
  }

  async setUrl(url: string): Promise<void> {
    this.info = { ...this.info, url };
    const bytes = Buffer.from(`${JSON.stringify(this.info)}\n`, "utf8");
    await this.handle.write(bytes, 0, bytes.length, 0);
    await this.handle.truncate(bytes.length);
    await this.handle.sync();
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
