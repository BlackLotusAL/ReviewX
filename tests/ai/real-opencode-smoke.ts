import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { GitPreparer, type PreparedReview } from "@/src/server/git";
import { OpenCodeReviewer } from "@/src/server/opencode";
import { ensureDataPaths, resolveDataPaths } from "@/src/server/paths";
import type { MergeRequestSnapshot, ProjectRecord } from "@/src/shared/types";

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<void> {
  await execute("git", args, { cwd, windowsHide: true, encoding: "utf8" });
}

if (process.platform !== "win32") throw new Error("The ReviewX v1 real AI smoke test is Windows-only.");

const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-real-ai-"));
const artifactDirectory = path.resolve("test-results", "ai", `smoke-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
await mkdir(artifactDirectory, { recursive: true });
const started = Date.now();
const events: Array<Record<string, unknown>> = [];
let prepared: PreparedReview | undefined;
try {
  const repository = path.join(root, "origin");
  await mkdir(repository, { recursive: true });
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.email", "reviewx@example.test");
  await git(repository, "config", "user.name", "ReviewX Smoke");
  await mkdir(path.join(repository, "src"), { recursive: true });
  await writeFile(path.join(repository, "src", "authorization.ts"), [
    "export function canDeleteDocument(requesterId: string, ownerId: string, role: string): boolean {",
    "  return requesterId === ownerId || role === \"admin\";",
    "}",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(repository, "src", "delete-route.ts"), [
    'import { canDeleteDocument } from "./authorization";',
    'export function deleteDocument(requester: { id: string; role: string }, document: { ownerId: string; deleted: boolean }) {',
    '  if (!canDeleteDocument(requester.id, document.ownerId, requester.role)) throw new Error("Forbidden");',
    '  document.deleted = true;',
    '}',
    '',
  ].join("\n"), "utf8");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "secure authorization baseline");
  await git(repository, "switch", "-c", "feature/authorization-refactor");
  await writeFile(path.join(repository, "src", "authorization.ts"), [
    "export function canDeleteDocument(requesterId: string, ownerId: string, role: string): boolean {",
    "  // Refactor: any authenticated requester can proceed.",
    "  return Boolean(requesterId) || role === \"admin\";",
    "}",
    "",
  ].join("\n"), "utf8");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "refactor delete authorization");

  const paths = resolveDataPaths({ LOCALAPPDATA: path.join(root, "local-app-data") });
  ensureDataPaths(paths);
  const cloneUrl = "https://reviewx-ai.invalid/authorization.git";
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(repository).href}.insteadOf`,
    GIT_CONFIG_VALUE_0: cloneUrl,
  };
  const project: ProjectRecord = {
    id: "9001", name: "smoke/authorization", cloneUrl,
    addedAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
  };
  const details: MergeRequestSnapshot = {
    projectId: project.id, iid: "1", title: "Authorization refactor", state: "open",
    updatedAt: "2026-09-02T00:00:00Z", sourceBranch: "feature/authorization-refactor", targetBranch: "main",
  };
  prepared = await new GitPreparer(paths, environment).prepare(project, details, new AbortController().signal);
  const result = await new OpenCodeReviewer(process.env).review(project.id, details, prepared, new AbortController().signal, {
    diagnostic(event) { events.push(event); if (["round_started", "round_completed", "tool_call"].includes(String(event.event))) process.stdout.write(`${JSON.stringify(event)}\n`); },
  });
  await writeFile(path.join(artifactDirectory, "result.json"), JSON.stringify({ result, events, elapsedMs: Date.now() - started,
    sourceSha: prepared.sourceSha, targetSha: prepared.targetSha, baseSha: prepared.baseSha }, null, 2), "utf8");
  if (result.findings.length === 0) throw new Error("Real OpenCode returned PASS for the fixed authorization bypass fixture.");
  if (!result.findings.some((finding) => /authori[sz]|owner|requester|delete|权限|越权/iu.test(finding.body))) {
    throw new Error("Real OpenCode returned Findings, but none identified the fixed authorization bypass.");
  }
  if (!result.findings.every(finding => finding.confidence >= 90 && finding.evidence.length > 0)) throw new Error("Real OpenCode returned unverified findings.");
  process.stdout.write(`Real Git + OpenCode smoke passed with ${result.findings.length} valid Finding(s).\n`);
} catch (error) {
  await writeFile(path.join(artifactDirectory, "error.json"), JSON.stringify({ elapsedMs: Date.now() - started,
    error: error instanceof Error ? { ...error, message: error.message } : String(error) }, null, 2), "utf8");
  throw error;
} finally {
  await writeFile(path.join(artifactDirectory, "events.json"), JSON.stringify(events, null, 2), "utf8");
  await prepared?.cleanup().catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
