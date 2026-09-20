import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  MergeRequestSnapshot,
  ProjectRecord,
  ReviewerResult,
  Severity,
} from "@/src/shared/types";
import type { CodeHubMrListEntry } from "@/src/server/integrations/codehub-schemas";
import type { CodeHubPort, CommentCreateResult } from "@/src/server/integrations/codehub";
import type { GitPreparerPort, PreparedReview } from "@/src/server/integrations/git";
import { createLogFile, Logger } from "@/src/server/platform/logger";
import type { ReviewerPort, ReviewOptions } from "@/src/server/integrations/opencode";
import { ensureDataPaths, resolveDataPaths } from "@/src/server/platform/paths";
import { ReportStore } from "@/src/server/storage/report-store";
import { ReviewXRuntime } from "@/src/server/runtime";
import { StateStore } from "@/src/server/storage/state-store";

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => finish(signal.reason ?? new Error("aborted"));
    function finish(error?: unknown) {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error);
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export class FakeCodeHub implements CodeHubPort {
  readonly calls: string[][] = [];
  readonly comments: Array<{ projectId: string; mrIid: string; body: string; severity: Severity }> = [];
  readonly repos = new Map<string, { cloneUrl: string; name: string; webUrl: string }>();
  readonly lists = new Map<string, CodeHubMrListEntry[]>();
  readonly viewSequences = new Map<string, MergeRequestSnapshot[]>();
  readonly viewIndexes = new Map<string, number>();
  commentOutcomes: CommentCreateResult[] = [];
  commentDelayMs = 0;
  activeComments = 0;
  maximumActiveComments = 0;
  listFailures = new Map<string, Error>();

  async viewRepo(projectId: string): Promise<{ cloneUrl: string; name: string; webUrl: string }> {
    this.calls.push(["repo", "view", projectId]);
    return clone(this.repos.get(projectId) ?? { webUrl: `https://codehub.example/team/project-${projectId}`, cloneUrl: `https://codehub.example/team/project-${projectId}.git`, name: `team/project-${projectId}` });
  }

  async listOpenMrs(projectId: string): Promise<CodeHubMrListEntry[]> {
    this.calls.push(["mr", "list", projectId]);
    const failure = this.listFailures.get(projectId);
    if (failure) throw failure;
    return clone(this.lists.get(projectId) ?? []);
  }

  async viewMr(projectId: string, mrIid: string, title?: string): Promise<MergeRequestSnapshot> {
    this.calls.push(["mr", "view", projectId, mrIid]);
    const key = `${projectId}:${mrIid}`;
    const values = this.viewSequences.get(key) ?? [{
      projectId,
      iid: mrIid,
      title: title ?? `MR ${mrIid}`,
      state: "open",
      updatedAt: "2026-09-01T00:00:00Z",
      sourceBranch: `feature-${mrIid}`,
      targetBranch: "main",
      webUrl: `https://codehub.example/team/project-${projectId}/merge_requests/${mrIid}`,
    }];
    const index = this.viewIndexes.get(key) ?? 0;
    this.viewIndexes.set(key, index + 1);
    return clone(values[Math.min(index, values.length - 1)]);
  }

  async createComment(projectId: string, mrIid: string, body: string, severity: Severity): Promise<CommentCreateResult> {
    this.calls.push(["mr", "comment", "create", projectId, mrIid, severity]);
    this.comments.push({ projectId, mrIid, body, severity });
    this.activeComments += 1;
    this.maximumActiveComments = Math.max(this.maximumActiveComments, this.activeComments);
    try {
      if (this.commentDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.commentDelayMs));
      return this.commentOutcomes.shift() ?? {
        kind: "success",
        comment: { comment_id: `comment-${this.comments.length}` },
      };
    } finally {
      this.activeComments -= 1;
    }
  }
}

export class FakeGit implements GitPreparerPort {
  readonly order: string[] = [];
  cleanupCount = 0;
  delayMs = 0;

  async prepare(project: ProjectRecord, details: MergeRequestSnapshot, signal: AbortSignal): Promise<PreparedReview> {
    this.order.push(`${project.id}:${details.iid}`);
    await abortableDelay(this.delayMs, signal);
    return {
      rootDirectory: "C:\\reviewx-test\\review",
      baseSha: "3".repeat(40),
      context: { scope: { sourceSha: "1".repeat(40), targetSha: "2".repeat(40), baseSha: "3".repeat(40), scopeHash: "scope", changes: [] }, diff: () => [], read: async () => [], search: async () => ({ matches: [], nextOffset: null, limitations: [] }) },
      sourceSha: "1".repeat(40),
      targetSha: "2".repeat(40),
      cleanup: async () => { this.cleanupCount += 1; },
    };
  }
}

export function fakeResult(findings: ReviewerResult["findings"]): ReviewerResult {
  return { findings, submission: { contractVersion: "reviewx-review/1", completion: "complete", blockers: [], findings: findings.map(f => ({ ...f, changeIds: ["fixture"], evidence: [{ revision: "source", path: "fixture", startLine: 1, endLine: 1 }] })) },
    execution: { version: 1, attemptId: "fixture", sessionID: "fixture", protocol: "test-only", toolVersion: "test", opencodeVersion: "test", actualModel: { providerID: "test", modelID: "test" },
      scope: { sourceSha: "s", targetSha: "t", baseSha: "b", scopeHash: "test", changes: [] }, rules: { profileHash: "test", resources: [] }, submittedPromptHash: "test", receipts: [], progress: { toolCount: 0, requiredMaterials: 0, deliveredMaterials: 0, limitations: [] }, durationMs: 0, status: "ACCEPTED", allowedTools: [], permissionHash: "test",
      terminal: { finalMessageID: "test", finish: "stop", completedAt: 1, idle: true, processExited: true, bridgeClosed: true } } };
}

export class FakeReviewer implements ReviewerPort {
  readonly order: string[] = [];
  readonly results = new Map<string, Pick<ReviewerResult, "findings">>();
  readonly failures = new Map<string, Error>();
  delayMs = 0;
  active = 0;
  maximumActive = 0;

  async review(_projectId: string, details: MergeRequestSnapshot, _prepared: PreparedReview, signal: AbortSignal, options: ReviewOptions): Promise<ReviewerResult> {
    this.order.push(details.iid);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      await abortableDelay(this.delayMs, signal);
      const failure = this.failures.get(details.iid);
      if (failure) throw failure;
      const result = fakeResult(clone(this.results.get(details.iid)?.findings ?? []));
      result.execution.attemptId = options.attemptId;
      result.execution.rules = options.rules;
      result.execution.scope = _prepared.context.scope;
      return result;
    } finally {
      this.active -= 1;
    }
  }
}

export interface RuntimeHarness {
  root: string;
  runtime: ReviewXRuntime;
  store: StateStore;
  codeHub: FakeCodeHub;
  git: FakeGit;
  reviewer: FakeReviewer;
  logger: Logger;
  cleanup(): Promise<void>;
}

export async function createRuntimeHarness(): Promise<RuntimeHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-runtime-test-"));
  const paths = resolveDataPaths({ LOCALAPPDATA: root });
  ensureDataPaths(paths);
  const logger = new Logger(createLogFile(paths), {});
  const store = new StateStore(paths);
  const codeHub = new FakeCodeHub();
  const git = new FakeGit();
  const reviewer = new FakeReviewer();
  let clock = Date.parse("2026-09-02T00:00:00.000Z");
  let ids = 0;
  const runtime = await new ReviewXRuntime({
    paths,
    logger,
    store,
    codeHub,
    git,
    reviewer,
    reports: new ReportStore(paths),
    now: () => new Date(clock++),
    id: () => `test-id-${++ids}`,
  }).initialize();
  return {
    root,
    runtime,
    store,
    codeHub,
    git,
    reviewer,
    logger,
    cleanup: async () => {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function configureMr(harness: RuntimeHarness, projectId: string, mrIid: string, title = `MR ${mrIid}`): MergeRequestSnapshot {
  const details: MergeRequestSnapshot = {
    projectId,
    iid: mrIid,
    title,
    state: "opened",
    updatedAt: `2026-09-01T00:00:${mrIid.padStart(2, "0")}Z`,
    sourceBranch: `feature-${mrIid}`,
    targetBranch: "main",
    webUrl: `https://codehub.example/team/project-${projectId}/merge_requests/${mrIid}`,
  };
  harness.codeHub.lists.set(projectId, [...(harness.codeHub.lists.get(projectId) ?? []), { iid: mrIid, title }]);
  harness.codeHub.viewSequences.set(`${projectId}:${mrIid}`, [details]);
  return details;
}

export async function registerAndRefresh(harness: RuntimeHarness, projectIds: string[]): Promise<void> {
  for (const projectId of projectIds) await harness.runtime.addProject(projectId);
  await harness.runtime.refreshMrs();
}

export async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for test condition.");
}
