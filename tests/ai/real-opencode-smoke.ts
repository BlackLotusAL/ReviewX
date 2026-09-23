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
await mkdir(evidence, { recursive: true });
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
  for (const [file, body] of Object.entries(baseline)) await writeFile(path.join(repository, file), body);
  await git(repository, "add", "."); await git(repository, "commit", "-m", "synthetic Qt baseline");
  await git(repository, "switch", "-c", "feature");
  for (const file of ["delay.h", "pyqt_delay.py", "pyside_delay.py"]) await writeFile(path.join(repository, file), baseline[file].replace("seconds * 1000", "seconds"));
  await git(repository, "add", "."); await git(repository, "commit", "-m", "synthetic retry refactor");
  await git(repository, "switch", "main"); await writeFile(path.join(repository, "target-only.txt"), "Independent target change.\n");
  await git(repository, "add", "."); await git(repository, "commit", "-m", "independent target");
  const paths = engine.resolveDataPaths({ LOCALAPPDATA: path.join(root, "local app data") }); engine.ensureDataPaths(paths);
  await mkdir(path.join(paths.root, "rules"));
  await writeFile(path.join(paths.root, "rules/profile.json"), JSON.stringify({ version: 1, projects: { "9001": ["qt", "pyqt5", "pyside2"] } }));
  const cloneUrl = "https://reviewx-ai.invalid/synthetic.git";
  const environment = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${pathToFileURL(repository).href}.insteadOf`, GIT_CONFIG_VALUE_0: cloneUrl };
  const project = { webUrl: "https://example.test/project", id: "9001", name: "synthetic/Qt", cloneUrl, addedAt: "now", updatedAt: "now" };
  const details = { projectId: project.id, iid: "1", title: "Synthetic Qt review", state: "open", updatedAt: "now", sourceBranch: "feature", targetBranch: "main" };
  prepared = await new engine.GitPreparer(paths, environment).prepare(project, details, new AbortController().signal);
  const rules = await engine.freezeReviewRules(paths.root, project.id, prepared.context.scope);
  const source = Object.fromEntries(await Promise.all(Object.keys(baseline).map(async file => [file, (await prepared!.context.read("source", file, new AbortController().signal)).map(p => p.content).join("")])));
  await writeFile(path.join(evidence, "fixture.json"), JSON.stringify({ baseline, source, scope: prepared.context.scope }, null, 2));
  const result = await new engine.OpenCodeReviewer(process.env).review(project.id, details, prepared, new AbortController().signal, { attemptId, rules,
    onProgress: p => process.stdout.write(`Tools ${p.toolCount}; required ${p.deliveredMaterials}/${p.requiredMaterials}\n`) });
  if (!result.submission || !result.execution) throw new Error("Missing production result");
  await writeFile(path.join(evidence, "submission.json"), JSON.stringify(result.submission, null, 2));
  await writeFile(path.join(evidence, "execution.json"), JSON.stringify(result.execution, null, 2));
  const bodies = [];
  for (const [index, finding] of result.findings.entries()) {
    const file = `finding-${index + 1}.body.md`; await writeFile(path.join(evidence, file), finding.body);
    if (await readFile(path.join(evidence, file), "utf8") !== finding.body) throw new Error("Body changed");
    bodies.push({ file, hash: digest(finding.body), severity: finding.severity });
  }
  await writeFile(path.join(evidence, "verification.json"), JSON.stringify({ technical: "passed", quality: "manual review required", installedEngine: !!process.env.REVIEWX_ACCEPTANCE_ENGINE, system: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version, commit: await checkoutCommit(projectRoot), bodies }, null, 2));
  if (!result.findings.length) throw new Error("Quality failed: no Findings");
  process.stdout.write(`Production acceptance: ${evidence}\n`);
} catch (error) {
  await writeFile(path.join(evidence, "failure.json"), JSON.stringify({ technical: "failed", code: (error as { code?: string }).code ?? "AI_ACCEPTANCE_FAILED" }, null, 2));
  throw error;
} finally {
  await prepared?.cleanup();
  if (path.dirname(root) !== os.tmpdir()) throw new Error("Unsafe temporary root");
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
