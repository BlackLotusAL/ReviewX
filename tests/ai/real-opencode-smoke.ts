import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { GitPreparer, type PreparedReview } from "@/src/server/integrations/git";
import { OpenCodeReviewer } from "@/src/server/integrations/opencode";
import { freezeReviewRules } from "@/src/server/review/rules";
import { digest } from "@/src/server/review/materials";
import { ensureDataPaths, resolveDataPaths } from "@/src/server/platform/paths";

const execute = promisify(execFile);
const engine: typeof import("@/src/server/package-engine") = process.env.REVIEWX_ACCEPTANCE_ENGINE
  ? await import(pathToFileURL(process.env.REVIEWX_ACCEPTANCE_ENGINE).href)
  : { GitPreparer, OpenCodeReviewer, freezeReviewRules, ensureDataPaths, resolveDataPaths };
async function git(cwd: string, ...args: string[]) {
  return (await execute("git", args, { cwd, windowsHide: true, encoding: "utf8" })).stdout.trim();
}
async function checkoutCommit(cwd: string) {
  try { return await git(cwd, "rev-parse", "HEAD"); }
  catch (error) {
    const failure = error as { code?: unknown; stderr?: string };
    if (failure.code === 128 && /fatal: not a git repository/iu.test(failure.stderr ?? "")) return "unknown (not a Git checkout)";
    throw error;
  }
}
const root = await mkdtemp(path.join(os.tmpdir(), "reviewx production Qt "));
let prepared: PreparedReview | undefined;
const attemptId = new Date().toISOString().replace(/[:.]/gu, "-");
const projectRoot = path.resolve(import.meta.dirname, "../..");
const evidence = path.join(projectRoot, "test-results/acceptance", attemptId);
const scenario = process.env.REVIEWX_ACCEPTANCE_CASE ?? "defects";
if (!["defects", "clean", "lifetime-defects", "lifetime-clean", "async-defects", "async-clean"].includes(scenario)) throw new Error("Unknown acceptance case");
await mkdir(evidence, { recursive: true });
process.stdout.write(`Acceptance artifacts: ${evidence}\n`);
try {
  const repository = path.join(root, "origin"); await mkdir(repository);
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.email", "reviewx@example.test");
  await git(repository, "config", "user.name", "ReviewX Synthetic");
  const baseline: Record<string, string> = {
    "delay.h": "#pragma once\ninline int retryDelayMs(int seconds) { return seconds * 1000; }\n",
    "controller.cpp": '#include <QTimer>\n#include "delay.h"\nvoid scheduleRetry(QTimer *timer) {\n  // Retry after 2 seconds.\n  timer->setSingleShot(true);\n  timer->start(retryDelayMs(2));\n}\n',
  };
  for (const [prefix, framework, seconds] of [["pyqt", "PyQt5", 3], ["pyside", "PySide2", 4]] as const) {
    baseline[`${prefix}_delay.py`] = "def retry_delay_ms(seconds):\n    return seconds * 1000\n";
    baseline[`${prefix}_controller.py`] = `from ${framework}.QtCore import QTimer\nfrom ${prefix}_delay import retry_delay_ms\n\ndef schedule_retry(timer: QTimer):\n    # Retry after ${seconds} seconds.\n    timer.setSingleShot(True)\n    timer.start(retry_delay_ms(${seconds}))\n`;
  }
  if (scenario.startsWith("lifetime")) {
    for (const key of Object.keys(baseline)) delete baseline[key];
    baseline["value.h"] = "#pragma once\n#include <memory>\ninline std::unique_ptr<int> makeValue() {\n  return std::make_unique<int>(42);\n}\n";
    baseline["consumer.cpp"] = '#include "value.h"\nint consume() { auto value = makeValue(); return *value; }\n';
  } else if (scenario.startsWith("async")) {
    for (const key of Object.keys(baseline)) delete baseline[key];
    baseline["loader.py"] = "async def fetch_value():\n    return 42\n\nasync def load_value():\n    return await fetch_value()\n";
    baseline["consumer.py"] = "from loader import load_value\n\nasync def consume():\n    value = await load_value()\n    return value + 1\n";
  }
  for (const [file, body] of Object.entries(baseline)) await writeFile(path.join(repository, file), body);
  await git(repository, "add", "."); await git(repository, "commit", "-m", "synthetic Qt baseline");
  await git(repository, "switch", "-c", "feature");
  const changedFiles = scenario.startsWith("lifetime") ? ["value.h"] : scenario.startsWith("async") ? ["loader.py"] : ["delay.h", "pyqt_delay.py", "pyside_delay.py"];
  for (const file of changedFiles) {
    const clean = scenario.endsWith("clean");
    let body = baseline[file];
    if (clean) body += file.endsWith(".h") ? "// Preserve the existing behavior.\n" : "# Preserve the existing behavior.\n";
    else if (scenario.startsWith("lifetime")) body = "#pragma once\n#include <memory>\ninline int* makeValue() {\n  auto value = std::make_unique<int>(42);\n  return value.get();\n}\n";
    else if (scenario.startsWith("async")) body = body.replace("return await fetch_value()", "return fetch_value()");
    else body = body.replace("seconds * 1000", "seconds");
    await writeFile(path.join(repository, file), body);
  }
  await git(repository, "add", "."); await git(repository, "commit", "-m", "synthetic retry refactor");
  await git(repository, "switch", "main"); await writeFile(path.join(repository, "target-only.txt"), "Independent target change.\n");
  await git(repository, "add", "."); await git(repository, "commit", "-m", "independent target");
  const paths = engine.resolveDataPaths({ LOCALAPPDATA: path.join(root, "local app data") }); engine.ensureDataPaths(paths);

  const cloneUrl = "https://reviewx-ai.invalid/synthetic.git";
  const environment = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${pathToFileURL(repository).href}.insteadOf`, GIT_CONFIG_VALUE_0: cloneUrl };
  const project = { webUrl: "https://example.test/project", id: "9001", name: "synthetic/Qt", cloneUrl, addedAt: "now", updatedAt: "now" };
  const details = { projectId: project.id, iid: "1", title: "Synthetic Qt review", state: "open", updatedAt: "now", sourceBranch: "feature", targetBranch: "main" };
  const prepareStarted = Date.now();
  prepared = await new engine.GitPreparer(paths, environment).prepare(project, details, new AbortController().signal);
  const prepareMs = Date.now() - prepareStarted;
  let rules = await engine.freezeReviewRules(paths.root, project.id, prepared.scope);
  if (process.env.REVIEWX_GENERIC_RULES === "with") {
    const generic = await engine.freezeReviewRules(paths.root, project.id, prepared.scope, {}, path.join(projectRoot, "tests/fixtures/generic-rules"));
    const resources = [...rules.resources, ...generic.resources];
    rules = { profileHash: digest(JSON.stringify(resources.map(r => [r.id, r.resourceHash]))), resources };
  }
  // Build fixture evidence independently; do not warm the review engine's cache.
  const source = Object.fromEntries(await Promise.all(Object.keys(baseline).map(async file => [file, (await execute("git", ["show", `${prepared!.sourceSha}:${file}`], { cwd: repository, windowsHide: true, encoding: "utf8" })).stdout])));
  await writeFile(path.join(evidence, "fixture.json"), JSON.stringify({ baseline, source, scope: prepared.scope }, null, 2));
  const result = await new engine.OpenCodeReviewer(process.env).review(project.id, details, prepared, new AbortController().signal, { attemptId, rules,
    onProgress: p => process.stdout.write(p.activity + "\n") });
  if (!result.submission || !result.execution) throw new Error("Missing production result");
  await writeFile(path.join(evidence, "raw-output.txt"), result.rawOutput ?? "");
  if (result.repairOutput !== undefined) await writeFile(path.join(evidence, "repair-output.txt"), result.repairOutput);
  await writeFile(path.join(evidence, "submission.json"), JSON.stringify(result.submission, null, 2));
  await writeFile(path.join(evidence, "execution.json"), JSON.stringify(result.execution, null, 2));
  const bodies = [];
  for (const [index, finding] of result.findings.entries()) {
    const file = `finding-${index + 1}.body.md`; await writeFile(path.join(evidence, file), finding.body);
    if (await readFile(path.join(evidence, file), "utf8") !== finding.body) throw new Error("Body changed");
    bodies.push({ file, hash: digest(finding.body), severity: finding.severity });
  }
  if (result.submission.completion !== "complete") throw new Error("Quality failed: fixture review incomplete");
  if (scenario.endsWith("clean") && result.findings.length) throw new Error("Quality failed: false positive on comment-only fixture");
  if (scenario === "defects") {
    for (const file of ["delay.h", "pyqt_delay.py", "pyside_delay.py"]) {      if (!result.submission.findings.some(f => f.locations.some(e => e.path === file) && /毫秒|millisecond|1000/iu.test(JSON.stringify(f)))) throw new Error(`Quality failed: missing conversion defect in ${file}`);
    }
  }
  if (scenario === "lifetime-defects" || scenario === "async-defects") {
    const file = changedFiles[0];
    const terms = scenario.startsWith("lifetime") ? /悬垂|释放|销毁|dangling|生命周期/iu : /await|协程|coroutine/iu;
    if (!result.submission.findings.some(f => f.locations.some(e => e.path === file) && terms.test(JSON.stringify(f)))) throw new Error("Quality failed: missing " + scenario);
  }
  await writeFile(path.join(evidence, "verification.json"), JSON.stringify({ technical: "passed", quality: "automated fixture checks passed; manual review required", scenario, genericRules: process.env.REVIEWX_GENERIC_RULES ?? "without", benchmarkGroup: process.env.REVIEWX_BENCHMARK_GROUP, prepareMs, modelMs: result.execution.durationMs, installedEngine: !!process.env.REVIEWX_ACCEPTANCE_ENGINE, system: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version, commit: await checkoutCommit(projectRoot), bodies }, null, 2));
  process.stdout.write(`Production acceptance: ${evidence}\n`);
} catch (error) {
  await writeFile(path.join(evidence, "failure.json"), JSON.stringify({ technical: "failed", scenario, genericRules: process.env.REVIEWX_GENERIC_RULES ?? "without", reason: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code ?? "AI_ACCEPTANCE_FAILED" }, null, 2));
  throw error;
} finally {
  await prepared?.cleanup();
  if (path.dirname(root) !== os.tmpdir()) throw new Error("Unsafe temporary root");
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
