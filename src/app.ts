import path from "node:path";
import { CodeHubClient } from "./codehub.js";
import { normalizePositiveId } from "./contracts.js";
import { errorMessage, ReviewXError } from "./errors.js";
import { GitManager } from "./git.js";
import { FileLock } from "./lock.js";
import { TextLogger } from "./logger.js";
import { OpenCodeClient } from "./opencode.js";
import { createRuntimePaths } from "./runtime.js";
import { StateStore } from "./state.js";
import { ReviewWorkflow } from "./workflow.js";

export async function addRepository(
  rawRepoId: string,
  statePath: string,
  codeHub = new CodeHubClient(),
): Promise<string> {
  let requestedId: string;
  try {
    requestedId = normalizePositiveId(rawRepoId);
  } catch (error) {
    throw new ReviewXError("INVALID_ARGUMENT", "Repository ID must be a positive integer.", {
      exitCode: 2,
      cause: error,
    });
  }
  const repository = await codeHub.repoView(requestedId);
  const canonicalId = normalizePositiveId(repository.repo_id);
  if (canonicalId !== requestedId) {
    throw new ReviewXError(
      "CODEHUB_ERROR",
      `CodeHub returned repository ${canonicalId} for requested ID ${requestedId}.`,
    );
  }
  const paths = createRuntimePaths(statePath);
  const store = new StateStore(paths.state, paths.stateLock);
  await store.addRepository(canonicalId);
  return canonicalId;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runService(options: {
  statePath: string;
  logPath?: string;
  intervalMs: number;
  agentTimeoutMs: number;
  signal: AbortSignal;
}): Promise<void> {
  const paths = createRuntimePaths(options.statePath, options.logPath);
  const runLock = await FileLock.acquire(paths.runLock, { failFast: true });
  const logger = new TextLogger(paths.log);
  const state = new StateStore(paths.state, paths.stateLock);
  const codeHub = new CodeHubClient();
  const git = new GitManager(paths);
  const openCode = new OpenCodeClient();
  const workflow = new ReviewWorkflow(
    paths,
    state,
    logger,
    codeHub,
    git,
    openCode,
    options.agentTimeoutMs,
  );
  try {
    while (!options.signal.aborted) {
      try {
        await workflow.scanOnce(options.signal);
      } catch (error) {
        await logger.write({
          level: "error",
          event: "runtime_error",
          error: errorMessage(error),
        });
        throw error;
      }
      if (!options.signal.aborted) {
        await abortableDelay(options.intervalMs, options.signal);
      }
    }
  } finally {
    await logger.flush();
    await runLock.release();
  }
}

export function defaultStatePath(cwd = process.cwd()): string {
  return path.join(cwd, "runtime", "state.json");
}
