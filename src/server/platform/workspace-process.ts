import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { reviewError } from "../review/materials";

/** Never kill a persisted PID: after restart it could belong to another process. */
export async function checkWorkspaceProcesses(workspaces: string): Promise<void> {
  for (const entry of await readdir(workspaces, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const marker = join(workspaces, entry.name, "task", "opencode-process.json");
    let pid: number;
    try { pid = (JSON.parse(await readFile(marker, "utf8")) as { pid: number }).pid; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw reviewError("OPENCODE_CLEANUP_FAILED", "遗留进程记录不可读，请核对工作区。", { cause: error }); }
    if (!Number.isInteger(pid) || pid <= 0) throw reviewError("OPENCODE_CLEANUP_FAILED", "遗留进程记录无效，请核对工作区。");
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    if (alive) throw reviewError("OPENCODE_CLEANUP_FAILED", "上次检视进程可能仍在运行（PID " + pid + "）。关闭后重试清理；排队任务保留。");
    await unlink(marker);
  }
}
