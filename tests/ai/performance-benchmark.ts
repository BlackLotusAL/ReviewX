import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { digest } from "@/src/server/review/materials";
import type { ExecutionRecord, ReviewDocument } from "@/src/shared/review-contract";

// Explicit invocation only: 3 workflows x 12 cases x 3 repeats consumes real model API calls.
const execute = promisify(execFile), root = path.resolve(import.meta.dirname, "../..");
const directory = path.join(root, "artifacts", "performance-" + new Date().toISOString().replace(/[:.]/gu, "-"));
await mkdir(directory, { recursive: true });
const packageRoot = path.join(directory, "package");
await mkdir(path.join(packageRoot, "dist"), { recursive: true });
await cp(path.join(root, "dist/review-engine.js"), path.join(packageRoot, "dist/review-engine.js"));
await cp(path.join(root, "resources/rules"), path.join(packageRoot, "resources/rules"), { recursive: true });
await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "reviewx", type: "module" }));
const engineHash = digest(await readFile(path.join(packageRoot, "dist/review-engine.js")));
const runnerFiles = ["real-opencode-smoke.ts", "oneshot-baseline.ts", "performance-benchmark.ts"];
const runnerHash = async () => digest(Buffer.concat(await Promise.all(runnerFiles.map(file => readFile(path.join(root, "tests/ai", file))))));
const originalRunnerHash = await runnerHash();
const cases = ["defects", "clean", "lifetime-defects", "lifetime-clean", "async-defects", "async-clean",
  "exception-defects", "exception-clean", "concurrency-defects", "concurrency-clean", "rules-defects", "rules-clean"];
const workflows = ["oneshot", "legacy", "balanced"] as const;
type Row = { run: number; scenario: string; workflow: string; wallMs: number; exitCode: number | string; timedOut: boolean; evidence?: string;
  execution: ExecutionRecord | null; submission: ReviewDocument | null; fixtureHash: string | null; verified: boolean };
const rows: Row[] = [];
const quantile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
const hashes = new Map<string, string>();
const mismatches: string[] = [];
const models = new Set<string>(), rules = new Map<string, string>();
for (let run = 0; run < 3; run++) for (const scenario of cases) {
  const order = [...workflows.slice(run), ...workflows.slice(0, run)];
  for (const workflow of order) {
    let stdout = "", stderr = "", exitCode: number | string = 0, timedOut = false;
    const start = Date.now();
    try {
      ({ stdout, stderr } = await execute(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "tests/ai/real-opencode-smoke.ts"], {
        cwd: root, windowsHide: true, timeout: 62 * 60_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, REVIEWX_ACCEPTANCE_ENGINE: path.join(packageRoot, "dist/review-engine.js"), REVIEWX_ACCEPTANCE_CASE: scenario, REVIEWX_WORKFLOW: workflow === "balanced" ? "balanced" : "legacy",
          REVIEWX_BENCHMARK_BASELINE: workflow === "oneshot" ? "oneshot" : "", REVIEWX_BENCHMARK_GROUP: directory },
      }));
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
      stdout = failure.stdout ?? ""; stderr = failure.stderr ?? ""; exitCode = failure.code ?? "FAILED"; timedOut = !!failure.killed;
    }
    const evidence = stdout.match(/(?:Acceptance artifacts|Production acceptance): (.+)/u)?.[1].trim();
    const read = async (name: string) => evidence ? JSON.parse(await readFile(path.join(evidence, name), "utf8").catch(() => "null")) : null;
    const execution = await read("execution.json"), submission = await read("submission.json"), fixture = await read("fixture.json");
    if (execution?.actualModel) {
      models.add(JSON.stringify(execution.actualModel));
      if (execution.actualModel.modelID === "unknown" || execution.actualModel.providerID === "unknown") mismatches.push(`Unverified model: ${scenario}/${workflow}/${run + 1}`);
    }
    if (execution?.rules) {
      const ruleHash = digest(JSON.stringify(execution.rules));
      if (rules.has(scenario) && rules.get(scenario) !== ruleHash) mismatches.push(`Changed rules: ${scenario}/${workflow}/${run + 1}`);
      rules.set(scenario, ruleHash);
    }
    const fixtureHash = fixture ? digest(JSON.stringify(fixture)) : null;
    if (fixtureHash) {
      if (hashes.has(scenario) && hashes.get(scenario) !== fixtureHash) mismatches.push(`${scenario}/${workflow}/${run + 1}`);
      hashes.set(scenario, fixtureHash);
    }
    const failure = await read("failure.json");
    timedOut ||= failure?.code === "REVIEW_TIMEOUT" || failure?.code === "OPENCODE_CANCELLED";
    rows.push({ run: run + 1, scenario, workflow, wallMs: Date.now() - start, exitCode, timedOut, evidence, execution, submission, fixtureHash,
      verified: exitCode === 0 && !!(await read("verification.json")) && !!execution && submission?.completion === "complete" });
    const summary = workflows.map(group => {
      const groupRows = rows.filter(r => r.workflow === group), complete = groupRows.filter(r => r.verified);
      return { workflow: group, runs: groupRows.length, successful: complete.length, failures: groupRows.length - complete.length,
        medianMs: quantile(complete.map(r => r.wallMs), .5), p95Ms: quantile(complete.map(r => r.wallMs), .95),
        overFiveMinutes: groupRows.filter(r => r.wallMs > 300000).length, timeouts: groupRows.filter(r => r.timedOut).length,
        // Keep missing counters null; no invented provider attempts or cost conversions.
        performance: groupRows.map(r => r.execution?.performance ?? null) };
    });
    await writeFile(path.join(directory, `${run + 1}-${scenario}-${workflow}.log`), stdout + "\n" + stderr);
    await writeFile(path.join(directory, "results.json"), JSON.stringify({ repetitions: 3, engineHash, runnerHash: originalRunnerHash, cases, summary, models: [...models], mismatches,
      note: "One-shot is an architecture reconstruction; verify model/reasoning configuration externally. Automated fixture checks do not establish precision/recall.", rows }, null, 2));
    console.log(`${rows.length}/108 ${scenario} ${workflow}: ${exitCode}, ${Math.round((Date.now() - start) / 1000)}s`);
    if (await runnerHash() !== originalRunnerHash) throw new Error("Benchmark runner changed during experiment; results are not comparable.");
  }
}
if (rows.some(r => !r.verified) || mismatches.length || models.size !== 1) throw new Error(`Benchmark has failures or changed conditions. See ${directory}`);
