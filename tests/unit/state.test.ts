import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileLock } from "../../src/lock.js";
import { createRuntimePaths } from "../../src/runtime.js";
import { StateStore } from "../../src/state.js";

const temporary: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-state-"));
  temporary.push(root);
  const paths = createRuntimePaths(path.join(root, "state.json"));
  return { root, paths, store: new StateStore(paths.state, paths.stateLock) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("state and file locks", () => {
  it("creates state atomically and preserves concurrent repository additions", async () => {
    const { paths, store } = await tempRoot();
    await Promise.all([store.addRepository("1"), store.addRepository("2")]);
    expect(await store.read()).toEqual({
      repositories: {
        "1": { merge_requests: {} },
        "2": { merge_requests: {} },
      },
    });
    expect((await readFile(paths.state, "utf8")).endsWith("\n")).toBe(true);
  });

  it("rejects duplicates without changing existing state", async () => {
    const { paths, store } = await tempRoot();
    await store.addRepository("1");
    const before = await readFile(paths.state, "utf8");
    await expect(store.addRepository("1")).rejects.toMatchObject({
      code: "DUPLICATE_REPOSITORY",
    });
    expect(await readFile(paths.state, "utf8")).toBe(before);
  });

  it("never overwrites an invalid state file", async () => {
    const { paths, store } = await tempRoot();
    await writeFile(paths.state, "not-json", "utf8");
    await expect(store.addRepository("1")).rejects.toMatchObject({ code: "STATE_ERROR" });
    expect(await readFile(paths.state, "utf8")).toBe("not-json");
  });

  it("removes a lock owned by a dead PID", async () => {
    const { paths } = await tempRoot();
    await writeFile(
      paths.stateLock,
      JSON.stringify({ pid: 2_147_483_647, created_at: new Date().toISOString(), token: "old" }),
    );
    const lock = await FileLock.acquire(paths.stateLock, { waitMs: 100 });
    await lock.release();
    await expect(readFile(paths.stateLock, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a second fail-fast lock and releases idempotently", async () => {
    const { paths } = await tempRoot();
    const first = await FileLock.acquire(paths.runLock, { failFast: true });
    await expect(FileLock.acquire(paths.runLock, { failFast: true })).rejects.toMatchObject({
      code: "LOCK_ERROR",
    });
    await first.release();
    await first.release();
  });

  it("updates MR state and rejects updates for unknown repositories", async () => {
    const { store } = await tempRoot();
    await store.addRepository("1");
    await store.updateMergeRequest("1", "7", (current) => ({
      ...current,
      last_processed_updated_at: "now",
    }));
    expect((await store.read()).repositories["1"]!.merge_requests["7"]).toEqual({
      finding_history: [],
      last_processed_updated_at: "now",
    });
    await expect(store.updateMergeRequest("2", "7", (current) => current)).rejects.toMatchObject({
      code: "STATE_ERROR",
    });
  });

  it("rejects invalid lock contents instead of deleting them", async () => {
    const { paths } = await tempRoot();
    await writeFile(paths.stateLock, "{}", "utf8");
    await expect(FileLock.acquire(paths.stateLock, { failFast: true })).rejects.toMatchObject({
      code: "LOCK_ERROR",
    });
  });

  it("treats a syntactically valid non-positive PID as stale", async () => {
    const { paths } = await tempRoot();
    await writeFile(
      paths.stateLock,
      JSON.stringify({ pid: 0, created_at: new Date().toISOString(), token: "old" }),
    );
    const lock = await FileLock.acquire(paths.stateLock, { failFast: true });
    await lock.release();
  });

  it("treats EPERM process probes as an active owner", async () => {
    const { paths } = await tempRoot();
    await writeFile(
      paths.stateLock,
      JSON.stringify({ pid: 123, created_at: new Date().toISOString(), token: "old" }),
    );
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    await expect(FileLock.acquire(paths.stateLock, { failFast: true })).rejects.toMatchObject({
      code: "LOCK_ERROR",
    });
  });

  it("does not remove a lock whose ownership token changed", async () => {
    const { paths } = await tempRoot();
    const lock = await FileLock.acquire(paths.stateLock, { failFast: true });
    await writeFile(
      paths.stateLock,
      JSON.stringify({ pid: process.pid, created_at: new Date().toISOString(), token: "other" }),
    );
    await lock.release();
    expect(JSON.parse(await readFile(paths.stateLock, "utf8")).token).toBe("other");
  });

  it("allows release after the lock file was already removed", async () => {
    const { paths } = await tempRoot();
    const lock = await FileLock.acquire(paths.stateLock, { failFast: true });
    await rm(paths.stateLock);
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
