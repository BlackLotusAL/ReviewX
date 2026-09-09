import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GitPreparer, type PreparedReview } from "@/src/server/git";
import { OpenCodeReviewer } from "@/src/server/opencode";
import { OpenCodeDiagnostics } from "@/src/server/opencode-diagnostics";
import { isAppError } from "@/src/server/errors";
import { resolveDataPaths, ensureDataPaths } from "@/src/server/paths";
import { resolveCommand } from "@/src/cli/resolve-command";
import { runProcess } from "@/src/server/process";

const { values } = parseArgs({ options: {
  repo: { type: "string", default: "." }, commit: { type: "string", default: "main" },
} });
const repository = path.resolve(values.repo);
const artifactRoot = path.resolve("test-results", "ai-commit");
await mkdir(artifactRoot, { recursive: true });
const artifacts = await mkdtemp(path.join(artifactRoot, "run-"));
const temporaryRoot = path.join(artifacts, "temporary");
await mkdir(temporaryRoot);
const started = Date.now();
const diagnostics = new OpenCodeDiagnostics(process.env, "");
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const event = (value: Record<string, string | number | boolean | undefined>) => {
  const safe = diagnostics.event({ timestamp: new Date().toISOString(), totalElapsedMs: Date.now() - started, ...value });
  appendFileSync(path.join(artifacts, "events.jsonl"), `${JSON.stringify(safe)}\n`);
  if (!["tool_call", "model_usage"].includes(String(value.event))) process.stdout.write(`${JSON.stringify(safe)}\n`);
};
const json = (name: string, value: unknown) => writeFile(path.join(artifacts, name), JSON.stringify(value, null, 2), "utf8");
let prepared: PreparedReview | undefined;
process.stdout.write(`Artifacts: ${artifacts}\n`);
try {
  const gitCommand = await resolveCommand("git", process.env);
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runProcess(gitCommand, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      signal: controller.signal, timeoutMs: 600_000, maxOutputBytes: 4 * 1024 * 1024 });
    if (result.exitCode !== 0 || result.aborted || result.timedOut || result.outputLimitExceeded) {
      throw new Error(`Git ${args[0]} failed: ${diagnostics.text(result.stderr)}`);
    }
    return result.stdout.trim();
  };
  const sourceSha = await git(repository, "rev-parse", "--verify", "--end-of-options", `${values.commit}^{commit}`);
  const baseSha = await git(repository, "rev-parse", "--verify", `${sourceSha}^1`);
  const versionResult = await runProcess(await resolveCommand("opencode", process.env), ["--version"], {
    env: process.env, signal: controller.signal, timeoutMs: 30_000 });
  if (versionResult.exitCode !== 0) throw new Error(`Cannot resolve OpenCode version: ${diagnostics.text(versionResult.stderr)}`);
  const implementation: Record<string, string> = {};
  for (const file of ["src/server/git.ts", "src/server/opencode.ts", "src/server/opencode-client.ts"]) {
    implementation[file] = createHash("sha256").update(await readFile(path.resolve(file))).digest("hex");
  }
  await json("metadata.json", { repository, requestedCommit: values.commit, sourceSha, targetSha: baseSha, baseSha,
    startedAt: new Date(started).toISOString(), node: process.version, undici: process.versions.undici,
    opencode: diagnostics.text(versionResult.stdout.trim()), model: "production default; actual model in events.jsonl",
    implementation, comparison: "first parent to pinned commit", accuracy: "unlabelled real repository; completion is not accuracy" });
  const origin = path.join(temporaryRoot, "origin.git");
  await git(repository, "clone", "--bare", "--no-hardlinks", "--", repository, origin);
  await git(origin, "update-ref", "refs/heads/reviewx-source", sourceSha);
  await git(origin, "update-ref", "refs/heads/reviewx-base", baseSha);
  const cloneUrl = "https://reviewx-commit.invalid/repository.git";
  const configCount = Number(process.env.GIT_CONFIG_COUNT ?? "0");
  assert(Number.isSafeInteger(configCount) && configCount >= 0);
  const environment = { ...process.env, GIT_CONFIG_COUNT: String(configCount + 1),
    [`GIT_CONFIG_KEY_${configCount}`]: `url.${pathToFileURL(origin).href}.insteadOf`,
    [`GIT_CONFIG_VALUE_${configCount}`]: cloneUrl };
  const paths = resolveDataPaths({ LOCALAPPDATA: path.join(temporaryRoot, "data") });
  ensureDataPaths(paths);
  const now = new Date().toISOString();
  const project = { id: "9003", name: "real-commit", cloneUrl, addedAt: now, updatedAt: now };
  const details = { projectId: project.id, iid: "1", title: `Commit ${sourceSha}`, state: "opened", updatedAt: now,
    sourceBranch: "reviewx-source", targetBranch: "reviewx-base" };
  event({ event: "preparing", sourceSha, baseSha });
  prepared = await new GitPreparer(paths, environment).prepare(project, details, controller.signal);
  assert.equal(prepared.sourceSha, sourceSha);
  assert.equal(prepared.baseSha, baseSha);
  assert.equal(prepared.targetSha, baseSha);
  const expectedPatch = await git(repository, "diff", "--no-ext-diff", "--no-textconv", "--binary", "--find-renames", `${baseSha}...${sourceSha}`, "--");
  assert.equal((await readFile(prepared.patchPath, "utf8")).trim(), expectedPatch, "Production preparation must preserve the complete pinned diff");
  for (const file of [prepared.patchPath, prepared.manifestPath]) await copyFile(file, path.join(artifacts, path.basename(file)));
  const result = await new OpenCodeReviewer(process.env).review(project.id, details, prepared, controller.signal, {
    diagnostic: event, phase: async phase => { event({ event: "phase", phase }); },
  });
  await json("result.json", { completed: true, elapsedMs: Date.now() - started, sourceSha, baseSha, result });
  event({ event: "test_completed", findings: result.findings.length });
} catch (error) {
  await json("error.json", { completed: false, elapsedMs: Date.now() - started, error: diagnostics.error(error),
    publicError: isAppError(error) ? error.toSafeView(text => diagnostics.text(text)) : undefined });
  event({ event: "test_failed", error: diagnostics.error(error) });
  process.exitCode = 1;
} finally {
  try {
    await prepared?.cleanup();
    const relative = path.relative(artifactRoot, temporaryRoot);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    event({ event: "test_cleanup_completed" });
  } catch (error) {
    event({ event: "test_cleanup_failed", error: diagnostics.error(error) });
    process.exitCode = 1;
  }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
