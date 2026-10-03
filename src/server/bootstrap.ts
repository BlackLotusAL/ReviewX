import { ReviewXRuntime } from "./runtime";
import { CodeHubClient } from "./integrations/codehub";
import { GitPreparer } from "./integrations/git";
import { Logger, createLogFile } from "./platform/logger";
import { OpenCodeReviewer } from "./integrations/opencode";
import { ensureDataPaths, resolveDataPaths, type DataPaths } from "./platform/paths";
import { ReportStore } from "./storage/report-store";
import { StateStore } from "./storage/state-store";

const runtimeSymbol = Symbol.for("reviewx.runtime.promise");
type RuntimeGlobal = typeof globalThis & { [runtimeSymbol]?: Promise<ReviewXRuntime> };

export async function initializeRuntime(paths: DataPaths, logger: Logger): Promise<ReviewXRuntime> {
  const target = globalThis as RuntimeGlobal;
  target[runtimeSymbol] ??= new ReviewXRuntime({
    paths,
    logger,
    store: new StateStore(paths),
    codeHub: new CodeHubClient(process.env),
    git: new GitPreparer(paths, process.env),
    reviewer: new OpenCodeReviewer(process.env),
    reports: new ReportStore(paths),
  }).initialize();
  return target[runtimeSymbol];
}

export async function getRuntime(): Promise<ReviewXRuntime> {
  const target = globalThis as RuntimeGlobal;
  if (!target[runtimeSymbol]) {
    const paths = resolveDataPaths();
    ensureDataPaths(paths);
    const logFile = process.env.REVIEWX_LOG_FILE || createLogFile(paths);
    target[runtimeSymbol] = initializeRuntime(paths, new Logger(logFile, process.env));
  }
  return target[runtimeSymbol];
}

export function installRuntimeForTests(runtime: ReviewXRuntime): void {
  (globalThis as RuntimeGlobal)[runtimeSymbol] = Promise.resolve(runtime);
}
