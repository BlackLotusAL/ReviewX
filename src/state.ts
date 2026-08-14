import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  emptyState,
  mergeRequestStateSchema,
  stateSchema,
  type MergeRequestState,
  type State,
} from "./contracts.js";
import { ReviewXError } from "./errors.js";
import { FileLock } from "./lock.js";

async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Preserve the original rename error.
    }
    throw error;
  }
}

export class StateStore {
  constructor(
    readonly statePath: string,
    readonly lockPath: string,
  ) {}

  async read(): Promise<State> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      return stateSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw new ReviewXError("STATE_ERROR", `Unable to read state file: ${this.statePath}`, {
        cause: error,
      });
    }
  }

  async update(mutator: (state: State) => State | Promise<State>): Promise<State> {
    const lock = await FileLock.acquire(this.lockPath, { waitMs: 5_000 });
    try {
      const current = await this.read();
      const next = stateSchema.parse(await mutator(structuredClone(current)));
      await atomicWriteJson(this.statePath, next);
      return next;
    } catch (error) {
      if (error instanceof ReviewXError) throw error;
      throw new ReviewXError("STATE_ERROR", `Unable to update state file: ${this.statePath}`, {
        cause: error,
      });
    } finally {
      await lock.release();
    }
  }

  async addRepository(repoId: string): Promise<State> {
    return await this.update((state) => {
      if (state.repositories[repoId]) {
        throw new ReviewXError(
          "DUPLICATE_REPOSITORY",
          `Repository ${repoId} is already registered.`,
          { exitCode: 2 },
        );
      }
      state.repositories[repoId] = { merge_requests: {} };
      return state;
    });
  }

  async updateMergeRequest(
    repoId: string,
    mrIid: string,
    updater: (current: MergeRequestState) => MergeRequestState,
  ): Promise<State> {
    return await this.update((state) => {
      const repository = state.repositories[repoId];
      if (!repository) {
        throw new ReviewXError("STATE_ERROR", `Repository ${repoId} is not registered.`);
      }
      const current =
        repository.merge_requests[mrIid] ?? mergeRequestStateSchema.parse({ finding_history: [] });
      repository.merge_requests[mrIid] = mergeRequestStateSchema.parse(updater(structuredClone(current)));
      return state;
    });
  }
}
