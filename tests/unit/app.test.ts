import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addRepository, defaultStatePath, runScanLoop, runService } from "../../src/app.js";
import { CodeHubClient } from "../../src/codehub.js";
import type { CommandResult, CommandRunner } from "../../src/process.js";

const roots: string[] = [];
async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), "reviewx-app-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

class RepoRunner implements CommandRunner {
  constructor(private readonly returnedId = "1") {}
  async run(): Promise<CommandResult> {
    return {
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: JSON.stringify({
        repo_id: this.returnedId,
        full_name: "g/r",
        clone_urls: { ssh: null, https: "https://example.test/r.git" },
      }),
    };
  }
}

describe("application services", () => {
  it("validates and persists a canonical repository", async () => {
    const temp = await root();
    const state = path.join(temp, "state.json");
    const id = await addRepository("0001", state, new CodeHubClient(new RepoRunner("1")));
    expect(id).toBe("1");
    expect(JSON.parse(await readFile(state, "utf8"))).toEqual({
      repositories: { "1": { merge_requests: {} } },
    });
    await expect(addRepository("bad", state, new CodeHubClient(new RepoRunner()))).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      exitCode: 2,
    });
    await expect(addRepository("1", path.join(temp, "other.json"), new CodeHubClient(new RepoRunner("2"))))
      .rejects.toMatchObject({ code: "CODEHUB_ERROR" });
  });

  it("runs immediate empty scans until aborted and releases its lock", async () => {
    const temp = await root();
    const state = path.join(temp, "state.json");
    const log = path.join(temp, "log.log");
    await writeFile(state, '{"repositories":{}}\n', "utf8");
    const controller = new AbortController();
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      if (String(chunk).includes("[scan_finished]")) controller.abort();
      return true;
    });
    await runService({ statePath: state, logPath: log, intervalMs: 10, agentTimeoutMs: 100, signal: controller.signal });
    expect(await readFile(log, "utf8")).toContain("[INFO] [scan_finished]");
    await expect(readFile(path.join(temp, "reviewx.run.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("logs fatal state errors and still releases the run lock", async () => {
    const temp = await root();
    const state = path.join(temp, "state.json");
    const log = path.join(temp, "log.log");
    await writeFile(state, "broken", "utf8");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(
      runService({
        statePath: state,
        logPath: log,
        intervalMs: 10,
        agentTimeoutMs: 100,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "STATE_ERROR" });
    expect(await readFile(log, "utf8")).toContain("[ERROR] [runtime_error]");
    await expect(readFile(path.join(temp, "reviewx.run.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops after failures occur for the configured number of consecutive scans", async () => {
    const scanOnce = vi.fn(async () => ({
      repositoryCount: 1,
      pendingReviewCount: 1,
      completedReviewCount: 0,
      failureCount: 1,
    }));
    const write = vi.fn(async () => undefined);

    await expect(
      runScanLoop({
        scanner: { scanOnce },
        logger: { write },
        intervalMs: 1,
        maxConsecutiveFailures: 3,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "REPEATED_FAILURES" });

    expect(scanOnce).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        event: "runtime_error",
        error: expect.stringContaining("3 consecutive scans"),
      }),
    );
  });

  it("derives the default runtime state from cwd", () => {
    expect(defaultStatePath("/srv/reviewx")).toBe(path.join("/srv/reviewx", "runtime", "state.json"));
  });
});
