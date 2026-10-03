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
import { ReviewTrace } from "@/src/server/review/trace";
import { runOneshotBaseline } from "./oneshot-baseline";
import { FINDING_TAGS, SOURCE_SNIPPET_LINE_LIMIT } from "@/src/shared/review-output-policy";
import { generatedFindingSchema } from "@/src/server/review/schema";

const execute = promisify(execFile);
const engine: typeof import("@/src/server/package-engine") = process.env.REVIEWX_ACCEPTANCE_ENGINE
  ? await import(pathToFileURL(process.env.REVIEWX_ACCEPTANCE_ENGINE).href)
  : { GitPreparer, OpenCodeReviewer, freezeReviewRules, ensureDataPaths, resolveDataPaths };
async function git(cwd: string, ...args: string[]) {
  return (await execute("git", args, { cwd, windowsHide: true, encoding: "utf8", env: { ...process.env,
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } })).stdout.trim();
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
if (!["defects", "clean", "lifetime-defects", "lifetime-clean", "async-defects", "async-clean", "exception-defects", "exception-clean", "concurrency-defects", "concurrency-clean", "rules-defects", "rules-clean"].includes(scenario)) throw new Error("Unknown acceptance case");
await mkdir(evidence, { recursive: true });
process.stdout.write(`Acceptance artifacts: ${evidence}\n`);
const trace = new ReviewTrace(attemptId, path.join(evidence, "trace.jsonl"));
const reviewSignal = AbortSignal.timeout(60 * 60_000);
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
  if (scenario.startsWith("exception")) {
    for (const key of Object.keys(baseline)) delete baseline[key];
    baseline["loader.py"] = "import json\ndef load(path):\n    try:\n        with open(path) as f:\n            return json.load(f)\n    except (OSError, ValueError):\n        return {}\n";
    baseline["caller.py"] = "from loader import load\n# Missing config files are supported and should use defaults.\ndef start(path):\n    return load(path).get('port', 8080)\n";
  }
  if (scenario.startsWith("concurrency")) {
    for (const key of Object.keys(baseline)) delete baseline[key];
    baseline["loader.py"] = "import asyncio\nlock = asyncio.Lock()\nvalue = 0\nasync def increment():\n    global value\n    async with lock:\n        current = value\n        await asyncio.sleep(0)\n        value = current + 1\n";
    baseline["caller.py"] = "import asyncio\nimport loader\nasync def run():\n    await asyncio.gather(loader.increment(), loader.increment())\n    assert loader.value == 2\n";
  }
  if (scenario.startsWith("rules")) {
    for (const key of Object.keys(baseline)) delete baseline[key];
    baseline["AGENTS.md"] = "All request timeout constants must be at most 30 seconds.\n";
    baseline["loader.py"] = "REQUEST_TIMEOUT_SECONDS = 30\n";
    await mkdir(path.join(repository, "scoped"));
    baseline["scoped/AGENTS.md"] = "In this directory, request timeout constants may be up to 120 seconds; this overrides the parent limit.\n";
    baseline["scoped/loader.py"] = "REQUEST_TIMEOUT_SECONDS = 30\n";
  }
  for (const [file, body] of Object.entries(baseline)) await writeFile(path.join(repository, file), body);
  await git(repository, "add", "."); await git(repository, "commit", "-m", "synthetic Qt baseline");
  await git(repository, "switch", "-c", "feature");
  const changedFiles = scenario.startsWith("lifetime") ? ["value.h"] : scenario.startsWith("rules") ? ["loader.py", "scoped/loader.py"] : /^(async|exception|concurrency)/u.test(scenario) ? ["loader.py"] : ["delay.h", "pyqt_delay.py", "pyside_delay.py"];
  for (const file of changedFiles) {
    const clean = scenario.endsWith("clean");
    let body = baseline[file];
    if (scenario.startsWith("rules")) body = body.replace("= 30", file.startsWith("scoped/") ? "= 90" : clean ? "= 20" : "= 90");
    else if (clean) body += file.endsWith(".h") ? "// Preserve the existing behavior.\n" : "# Preserve the existing behavior.\n";
    else if (scenario.startsWith("lifetime")) body = "#pragma once\n#include <memory>\ninline int* makeValue() {\n  auto value = std::make_unique<int>(42);\n  return value.get();\n}\n";
    else if (scenario.startsWith("async")) body = body.replace("return await fetch_value()", "return fetch_value()");
    else if (scenario.startsWith("exception")) body = body.replace("(OSError, ValueError)", "ValueError");
    else if (scenario.startsWith("concurrency")) body = body.replace("    async with lock:\n", "").replace(/^        /gmu, "    ");
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
  prepared = await new engine.GitPreparer(paths, environment).prepare(project, details, reviewSignal, trace);
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
  const result = process.env.REVIEWX_BENCHMARK_BASELINE === "oneshot"
    ? await runOneshotBaseline(details, prepared, reviewSignal, { attemptId, rules, trace })
    : await new engine.OpenCodeReviewer(process.env).review(project.id, details, prepared, reviewSignal, { attemptId, rules, trace,
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
  // The benchmark-only no-tool baseline does not use production source extraction.
  if (process.env.REVIEWX_BENCHMARK_BASELINE !== "oneshot") for (const finding of result.submission.findings) {
    if (!generatedFindingSchema.safeParse(finding).success) throw new Error("Quality failed: brief, tags, annotations or solution strategy contract");
    if (new Set(finding.tags).size !== finding.tags.length || finding.tags.some(tag => !FINDING_TAGS.some(allowed => allowed === tag))) throw new Error("Quality failed: tag normalization");
    for (const location of finding.locations) {
      const text = location.revision === "source" ? source[location.path] : baseline[location.path];
      if (text === undefined) throw new Error("Quality failed: location not in fixture");
      const lines = text.split(/\r\n|\r|\n/u); if (/[\r\n]$/u.test(text)) lines.pop();
      const expected = lines.slice(location.startLine - 1, Math.min(location.endLine, location.startLine + SOURCE_SNIPPET_LINE_LIMIT - 1)).join("\n");
      if (location.endLine > lines.length || !expected || location.snippet?.code !== expected) throw new Error("Quality failed: source snippet differs from the fixed revision and line range");
    }
    const body = result.findings.find(f => f.structured === finding)?.body ?? result.findings[result.submission.findings.indexOf(finding)]?.body ?? "";
    for (const location of finding.locations) for (const annotation of location.annotations ?? []) {
      if (!body.includes(`【检视注释·问题行 L${annotation.line}】${annotation.text}`)) throw new Error("Quality failed: missing in-code annotation");
    }
    if (!body.includes("**推荐方案**")) throw new Error("Quality failed: missing recommended strategy");
    if (!finding.solutions.some(solution => solution.steps?.some(step => step.path && step.example?.code.trim()))) throw new Error("Quality failed: concrete fixture defect lacks file-specific corrected source code");
  }
  if (scenario.endsWith("clean") && result.findings.length) throw new Error("Quality failed: false positive on comment-only fixture");
  if (scenario === "defects") {
    for (const file of ["delay.h", "pyqt_delay.py", "pyside_delay.py"]) {
      if (!result.submission.findings.some(f => f.locations.some(e => e.path === file) && /毫秒|millisecond|1000/iu.test(JSON.stringify(f)))) throw new Error(`Quality failed: missing conversion defect in ${file}`);
    }
  }
  if (scenario === "defects" && process.env.REVIEWX_BENCHMARK_BASELINE !== "oneshot" && !result.submission.findings.some(f => {
    const recommended = f.solutions.find(s => s.kind === "recommended");
    return ["delay.h", "pyqt_delay.py", "pyside_delay.py"].every(file => recommended?.steps?.some(step => step.path === file && /1000/u.test(step.example?.code ?? "")));
  })) throw new Error("Quality failed: coordinated C++ and Python repairs must share one recommended strategy with file-specific code");
  if (scenario === "lifetime-defects" || scenario === "async-defects") {
    const file = changedFiles[0];
    const terms = scenario.startsWith("lifetime") ? /悬垂|释放|销毁|dangling|生命周期/iu : /await|协程|coroutine/iu;
    if (!result.submission.findings.some(f => f.locations.some(e => e.path === file) && terms.test(JSON.stringify(f)))) throw new Error("Quality failed: missing " + scenario);
  }
  if (/^(exception|concurrency|rules)-defects$/u.test(scenario)) {
    const terms = scenario.startsWith("exception") ? /OSError|FileNotFound|异常|不存在/iu : scenario.startsWith("concurrency") ? /竞态|并发|更新|race/iu : /30|规则|超时/iu;
    if (!result.submission.findings.some(f => f.locations.some(l => l.path === "loader.py") && terms.test(JSON.stringify(f)))) throw new Error("Quality failed: missing " + scenario);
  }
  if (scenario.startsWith("rules") && result.submission.findings.some(f => f.locations.some(l => l.path === "scoped/loader.py"))) throw new Error("Quality failed: ignored nearer scoped rule");
  if (scenario.startsWith("rules") && result.submission.findings.some(f => {
    const impact = JSON.stringify(f.impact);
    return !/未发现|未见|未提供|没有|暂无|无法确认|未知|尚无/u.test(impact) || !/调用|运行|引用|使用/u.test(impact);
  })) throw new Error("Quality failed: rules-only fixture has no callers; unsupported runtime impact must not be asserted");
  await writeFile(path.join(evidence, "verification.json"), JSON.stringify({ technical: "passed", quality: "automated fixture checks passed; manual review required", scenario, genericRules: process.env.REVIEWX_GENERIC_RULES ?? "without", benchmarkGroup: process.env.REVIEWX_BENCHMARK_GROUP, prepareMs, modelMs: result.execution.durationMs, installedEngine: !!process.env.REVIEWX_ACCEPTANCE_ENGINE, system: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version, commit: await checkoutCommit(projectRoot), bodies }, null, 2));
  process.stdout.write(`Production acceptance: ${evidence}\n`);
} catch (error) {
  await writeFile(path.join(evidence, "failure.json"), JSON.stringify({ technical: "failed", scenario, genericRules: process.env.REVIEWX_GENERIC_RULES ?? "without", reason: error instanceof Error ? error.message : String(error), code: reviewSignal.aborted ? "REVIEW_TIMEOUT" : (error as { code?: string }).code ?? "AI_ACCEPTANCE_FAILED" }, null, 2));
  throw error;
} finally {
  trace.emit("acceptance.finished", { timedOut: reviewSignal.aborted });
  await trace.flush();
  await prepared?.cleanup();
  if (path.dirname(root) !== os.tmpdir()) throw new Error("Unsafe temporary root");
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
