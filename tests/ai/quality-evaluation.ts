import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { GitPreparer, type PreparedReview } from "@/src/server/git";
import { OpenCodeReviewer } from "@/src/server/opencode";
import { connectOpenCode, type ReviewTelemetry } from "@/src/server/opencode-client";
import { ensureDataPaths, resolveDataPaths } from "@/src/server/paths";
import { resolveCommand } from "@/src/cli/resolve-command";
import { runProcess } from "@/src/server/process";
import { LegacyOpenCodeReviewer } from "./legacy-reviewer";
import { qualityFixtures } from "./quality-fixtures";

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute("git", args, { cwd, windowsHide: true, encoding: "utf8" })).stdout.trim();
const artifactRoot = path.resolve("test-results", "ai", `quality-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
await mkdir(artifactRoot, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-quality-"));
const modelName = process.env.REVIEWX_AI_MODEL ?? "deepseek/deepseek-v4-flash";
const slash = modelName.indexOf("/");
if (slash <= 0) throw new Error("REVIEWX_AI_MODEL must be provider/model");
const model = { providerID: modelName.slice(0, slash), modelID: modelName.slice(slash + 1) };
const versionResult = await runProcess(await resolveCommand("opencode", process.env), ["--version"], { env: process.env, timeoutMs: 30_000 });
if (versionResult.exitCode !== 0) throw new Error("Cannot resolve real OpenCode version");
const version = versionResult.stdout.trim();
interface RunResult { fixture: string; variant: string; repetition: number; positive: boolean; valid: boolean; hit: boolean; falsePositive: boolean; findings: number; elapsedMs: number; reportedCost: number | null; tokens: Record<string, number> }
const results: RunResult[] = [];
const json = async (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2), "utf8");
await json(path.join(artifactRoot, "metadata.json"), { model: modelName, version, repetitions: 3, startedAt: new Date().toISOString(), platform: process.platform, node: process.version,
  costNote: "reportedCost is OpenCode/provider-reported USD when available, not a verified invoice. Zero may mean unavailable provider pricing." });
process.stdout.write(`Artifacts: ${artifactRoot}\nModel: ${modelName}; OpenCode ${version}\n`);
try {
  for (const fixture of qualityFixtures) {
    const repository = path.join(root, fixture.id);
    const artifacts = path.join(artifactRoot, fixture.id);
    await mkdir(repository, { recursive: true }); await mkdir(artifacts, { recursive: true });
    await git(repository, "init", "--initial-branch=main");
    await git(repository, "config", "user.email", "reviewx@example.test"); await git(repository, "config", "user.name", "ReviewX Evaluation");
    for (const [file, content] of Object.entries(fixture.base)) {
      await mkdir(path.dirname(path.join(repository, file)), { recursive: true });
      await writeFile(path.join(repository, file), content, "utf8");
    }
    const baselineBehavior = await runProcess({ name: "node", executable: process.execPath, prefixArgs: [] }, ["contract.test.mjs"], { cwd: repository, timeoutMs: 10_000 });
    if (baselineBehavior.exitCode !== 0) throw new Error(`Invalid fixture baseline: ${fixture.id}`);
    await git(repository, "add", "."); await git(repository, "commit", "-m", "baseline");
    await git(repository, "switch", "-c", "change");
    await writeFile(path.join(repository, fixture.changedPath), fixture.change, "utf8");
    const changedBehavior = await runProcess({ name: "node", executable: process.execPath, prefixArgs: [] }, ["contract.test.mjs"], { cwd: repository, timeoutMs: 10_000 });
    if ((changedBehavior.exitCode !== 0) !== fixture.positive) throw new Error(`Invalid fixture ground truth: ${fixture.id}`);
    await git(repository, "add", "."); await git(repository, "commit", "-m", "change");
    await git(repository, "bundle", "create", path.join(artifacts, "repository.bundle"), "--all");
    await json(path.join(artifacts, "fixture.json"), { ...fixture, matches: fixture.matches.source, baselineBehavior, changedBehavior });
    const paths = resolveDataPaths({ LOCALAPPDATA: path.join(root, "data") }); ensureDataPaths(paths);
    const cloneUrl = `https://reviewx-quality.invalid/${fixture.id}.git`;
    const environment = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${pathToFileURL(repository).href}.insteadOf`, GIT_CONFIG_VALUE_0: cloneUrl };
    const project = { id: "9002", name: fixture.id, cloneUrl, addedAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z" };
    const details = { projectId: project.id, iid: "1", title: "Refactor", state: "opened", sourceBranch: "change", targetBranch: "main", updatedAt: "2026-09-06T00:00:00Z" };
    let prepared: PreparedReview | undefined;
    try {
      prepared = await new GitPreparer(paths, environment).prepare(project, details, new AbortController().signal);
      await Promise.all([copyFile(prepared.patchPath, path.join(artifacts, "changes.patch")), copyFile(prepared.bundlePath, path.join(artifacts, "legacy-bundle.txt")), copyFile(prepared.manifestPath, path.join(artifacts, "manifest.json"))]);
      for (let repetition = 1; repetition <= 3; repetition++) for (const variant of ["legacy", "multi_turn"]) {
        const runDirectory = path.join(artifacts, `${variant}-${repetition}`); await mkdir(runDirectory);
        const events: ReviewTelemetry[] = [];
        let legacyStream = "";
        let output: { findings: Array<{ body: string }> } | undefined;
        let failure: unknown;
        const started = Date.now();
        process.stdout.write(`START ${fixture.id} ${variant} ${repetition}/3\n`);
        try {
          output = variant === "legacy"
            ? await new LegacyOpenCodeReviewer(process.env, { model: modelName, record: stdout => { legacyStream = stdout; } }).review(project.id, details, prepared, new AbortController().signal)
            : await new OpenCodeReviewer(process.env, { model, connect: async (...args) => {
              const connection = await connectOpenCode(...args);
              return { ...connection, prompt: async (...request) => {
                await appendFile(path.join(runDirectory, "transcript.jsonl"), `${JSON.stringify({ request })}\n`);
                const response = await connection.prompt(...request);
                await appendFile(path.join(runDirectory, "transcript.jsonl"), `${JSON.stringify({ response })}\n`);
                return response;
              } };
            } }).review(project.id, details, prepared, new AbortController().signal, { diagnostic: event => events.push(event) });
        } catch (error) { failure = error instanceof Error ? { ...error, message: error.message } : String(error); }
        if (legacyStream) {
          await writeFile(path.join(runDirectory, "events.jsonl"), legacyStream, "utf8");
          for (const line of legacyStream.split(/\r?\n/u).filter(Boolean)) {
            try {
              const event = JSON.parse(line);
              if (event.type === "step_finish") events.push({ event: "model_usage", model: modelName, reportedCost: event.part?.cost,
                inputTokens: event.part?.tokens?.input, outputTokens: event.part?.tokens?.output, reasoningTokens: event.part?.tokens?.reasoning,
                cacheReadTokens: event.part?.tokens?.cache?.read, cacheWriteTokens: event.part?.tokens?.cache?.write });
            } catch { /* Preserve invalid raw stream for audit; legacy parser records the failure. */ }
          }
        }
        const usage = events.filter(event => event.event === "model_usage");
        const sum = (key: string) => usage.reduce((total, event) => total + (typeof event[key] === "number" ? event[key] as number : 0), 0);
        const result: RunResult = { fixture: fixture.id, variant, repetition, positive: fixture.positive, valid: Boolean(output),
          hit: fixture.positive && Boolean(output?.findings.some(finding => fixture.matches.test(finding.body))),
          falsePositive: !fixture.positive && Boolean(output?.findings.length), findings: output?.findings.length ?? 0,
          elapsedMs: Date.now() - started, reportedCost: usage.some(event => typeof event.reportedCost === "number") ? sum("reportedCost") : null,
          tokens: Object.fromEntries(["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"].map(key => [key, sum(key)])) };
        results.push(result);
        await json(path.join(runDirectory, "result.json"), { ...result, model: modelName, version, sourceSha: prepared.sourceSha, baseSha: prepared.baseSha, output, failure, events });
        await json(path.join(artifactRoot, "results.json"), results);
        process.stdout.write(`DONE ${JSON.stringify(result)}${failure ? ` ERROR ${JSON.stringify(failure)}` : ""}\n`);
      }
    } finally { await prepared?.cleanup(); }
  }
  const score = (variant: string) => {
    const runs = results.filter(result => result.variant === variant);
    return { valid: runs.filter(result => result.valid).length, positiveHits: runs.filter(result => result.hit).length,
      negativeFalsePositives: runs.filter(result => result.falsePositive).length, elapsedMs: runs.reduce((sum, run) => sum + run.elapsedMs, 0),
      reportedCost: runs.reduce((sum, run) => sum + (run.reportedCost ?? 0), 0) };
  };
  const legacy = score("legacy"), multiTurn = score("multi_turn");
  const passed = multiTurn.valid === 18 && multiTurn.negativeFalsePositives === 0 && multiTurn.positiveHits >= 8 && multiTurn.positiveHits >= legacy.positiveHits;
  const summary = { passed, legacy, multiTurn, artifactRoot };
  await json(path.join(artifactRoot, "summary.json"), summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
