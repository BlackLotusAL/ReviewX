import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { checkWorkspaceProcesses } from "@/src/server/platform/workspace-process";

test("restart retains live process marker without killing it, removes marker only after confirmed exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "reviewx-process-test-"));
  const task = join(root, "attempt", "task");
  await mkdir(task, { recursive: true });
  const marker = join(task, "opencode-process.json");
  await writeFile(marker, JSON.stringify({ pid: process.pid }));
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  try {
    await expect(checkWorkspaceProcesses(root)).rejects.toMatchObject({ code: "OPENCODE_CLEANUP_FAILED" });
    expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, 0);
    expect(await readFile(marker, "utf8")).toContain(String(process.pid));
    kill.mockImplementation(() => { throw Object.assign(new Error("not found"), { code: "ESRCH" }); });
    await checkWorkspaceProcesses(root);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { kill.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
