import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Run after tsup. Snapshot the engine and templates so later builds cannot change the experiment.
const execute = promisify(execFile), root = path.resolve(import.meta.dirname, "../..");
const directory = path.join(root, "artifacts", "generic-rules-" + new Date().toISOString().replace(/[:.]/gu, "-"));
const packageRoot = path.join(directory, "package");
await mkdir(path.join(packageRoot, "dist"), { recursive: true });
await cp(path.join(root, "dist/review-engine.js"), path.join(packageRoot, "dist/review-engine.js"));
await cp(path.join(root, "resources/rules"), path.join(packageRoot, "resources/rules"), { recursive: true });
await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "reviewx", type: "module" }));
const engineHash = createHash("sha256").update(await readFile(path.join(packageRoot, "dist/review-engine.js"))).digest("hex");
const results: unknown[] = [];
const failures: string[] = [], models = new Set<string>(), prompts = new Set<string>(), fixtures = new Map<string, string>();
const cases = ["defects", "clean", "lifetime-defects", "lifetime-clean", "async-defects", "async-clean"];
console.log(`Benchmark artifacts: ${directory}`);
for (let run = 0; run < 5; run++) for (const scenario of cases) {
  for (const group of run % 2 ? ["with", "without"] : ["without", "with"]) {
    const started = Date.now();
    let stdout = "", stderr = "", exitCode: string | number = 0;
    try {
      ({ stdout, stderr } = await execute(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "tests/ai/real-opencode-smoke.ts"], {
        cwd: root, windowsHide: true, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, REVIEWX_ACCEPTANCE_ENGINE: path.join(packageRoot, "dist/review-engine.js"),
          REVIEWX_ACCEPTANCE_CASE: scenario, REVIEWX_GENERIC_RULES: group, REVIEWX_BENCHMARK_GROUP: directory },
      }));
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: string | number };
      stdout = failure.stdout ?? ""; stderr = failure.stderr ?? ""; exitCode = failure.code ?? "FAILED";
    }
    const evidence = stdout.match(/Acceptance artifacts: (.+)/u)?.[1].trim();
    const read = async (name: string) => evidence ? JSON.parse(await readFile(path.join(evidence, name), "utf8").catch(() => "null")) : null;
    const execution = await read("execution.json"), submission = await read("submission.json");
    if (exitCode !== 0) failures.push(`${run + 1}/${scenario}/${group}`);
    if (execution) { models.add(JSON.stringify(execution.actualModel)); prompts.add(execution.workflowVersion); }
    const fixture = await read("fixture.json");
    const fixtureHash = fixture ? createHash("sha256").update(JSON.stringify({ baseline: fixture.baseline, source: fixture.source })).digest("hex") : null;
    if (fixtureHash) {
      if (fixtures.has(scenario) && fixtures.get(scenario) !== fixtureHash) failures.push(`Fixture changed: ${scenario}`);
      fixtures.set(scenario, fixtureHash);
    }
    results.push({ run: run + 1, scenario, group, exitCode, evidence, wallMs: Date.now() - started,
      fixtureHash,
      verification: await read("verification.json"), failure: await read("failure.json"),
      model: execution?.actualModel, workflowVersion: execution?.workflowVersion, durationMs: execution?.durationMs,
      subagents: execution?.metrics?.nativeSubagents,
      completion: submission?.completion, findings: submission?.findings?.length });
    await writeFile(path.join(directory, `${run + 1}-${scenario}-${group}.log`), stdout + "\n" + stderr);
    await writeFile(path.join(directory, "results.json"), JSON.stringify({ engineHash, cases, repetitions: 5, results }, null, 2));
    console.log(`${results.length}/60 ${scenario} ${group}: ${exitCode === 0 ? "passed" : "FAILED"} (${Math.round((Date.now() - started) / 1000)}s)`);
  }
}
console.log(`Benchmark complete: ${path.join(directory, "results.json")}`);
if (failures.length || models.size !== 1 || prompts.size !== 1) throw new Error(`Benchmark failed or conditions changed: ${JSON.stringify({ failures, models: [...models], prompts: [...prompts] })}`);
