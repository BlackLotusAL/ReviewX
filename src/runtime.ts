import path from "node:path";

export interface RuntimePaths {
  root: string;
  state: string;
  stateLock: string;
  runLock: string;
  log: string;
  repos: string;
  worktrees: string;
  runs: string;
}

export function createRuntimePaths(statePath: string, logPath?: string): RuntimePaths {
  const state = path.resolve(statePath);
  const root = path.dirname(state);
  return {
    root,
    state,
    stateLock: path.join(root, "state.lock"),
    runLock: path.join(root, "reviewx.run.lock"),
    log: path.resolve(logPath ?? path.join(root, "reviewx.jsonl")),
    repos: path.join(root, "repos"),
    worktrees: path.join(root, "worktrees"),
    runs: path.join(root, "runs"),
  };
}

export function assertPathWithin(parent: string, target: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe runtime path: ${target}`);
  }
}
