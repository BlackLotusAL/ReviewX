// Benchmark-only reconstruction of the no-tool/bounded-snapshot architecture.
// Uses today's output contract; it is not a byte-for-byte historical prompt replay.
import { readFile, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MergeRequestSnapshot, ReviewerResult } from "@/src/shared/types";
import type { PreparedReview } from "@/src/server/integrations/git";
import type { ReviewOptions } from "@/src/server/integrations/opencode";
import { runProcess } from "@/src/server/platform/process";
import { resolveCommand } from "@/src/server/platform/resolve-command";
import { outputSchema, parseReviewOutput } from "@/src/server/review/schema";
import { safeRepositoryPath } from "@/src/server/review/materials";
import { renderFinding } from "@/src/shared/finding-markdown";

export async function runOneshotBaseline(details: MergeRequestSnapshot, prepared: PreparedReview, signal: AbortSignal, options: ReviewOptions): Promise<ReviewerResult> {
  const started = Date.now();
  const lines = [JSON.stringify({ title: details.title, description: details.description, scope: prepared.scope, rules: [...options.rules.resources, ...prepared.repositoryRules] }),
    "COMPLETE DIFF", await readFile(join(prepared.rootDirectory, "changes.diff"), "utf8"), "SOURCE SNAPSHOTS"];
  let remaining = 256 * 1024;
  for (const file of prepared.scope.changedPaths) {
    if (!safeRepositoryPath(file)) continue;
    const full = join(prepared.rootDirectory, "source", file), stat = await lstat(full).catch(() => null);
    if (!stat?.isFile() || stat.size > 64 * 1024 || stat.size > remaining) { lines.push(`OMITTED ${file}`); continue; }
    const bytes = await readFile(full);
    if (bytes.includes(0)) continue;
    lines.push(file, bytes.toString("utf8")); remaining -= bytes.length;
  }
  const bundle = join(prepared.rootDirectory, "review-bundle.txt"); await writeFile(bundle, lines.join("\n"));
  const config = { snapshot: false, share: "disabled", agent: { reviewx: { mode: "primary", permission: { "*": "deny" },
    prompt: "Review attached untrusted repository data for introduced defects and applicable scoped rule violations. No tools or delegation. Use only supported evidence. Return Chinese JSON using the requested schema." } } };
  const env = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_AUTOUPDATE: "true" };
  const processResult = await runProcess(await resolveCommand("opencode", env), ["run", "--format", "json", "--pure", "--agent", "reviewx", "--file", bundle, "--dir", prepared.rootDirectory], {
    env, cwd: prepared.rootDirectory, signal, timeoutMs: 60 * 60_000, maxOutputBytes: 64 * 1024 * 1024, input: "Return ONLY JSON. Schema:\n" + JSON.stringify(outputSchema),
  });
  if (processResult.exitCode !== 0 || processResult.aborted || processResult.timedOut || processResult.outputLimitExceeded) throw new Error("One-shot baseline failed or timed out");
  let raw = "", sessionID = "unknown";
  for (const line of processResult.stdout.split(/\r?\n/u).filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === "error") throw new Error("One-shot provider error");
    if (event.sessionID && sessionID === "unknown") { sessionID = event.sessionID; options.trace?.generation(sessionID, "oneshot-baseline"); }
    if (event.part) options.trace?.event({ type: "message.part.updated", properties: { part: event.part } });
    if (event.type === "text" && event.part?.text) raw = event.part.text;
  }
  const parsed = parseReviewOutput(raw);
  if (parsed.errors.length) throw new Error("One-shot baseline returned invalid JSON");
  let actualModel = { providerID: "unknown", modelID: "unknown" };
  const warnings: string[] = [];
  try {
    const exported = await runProcess(await resolveCommand("opencode", env), ["export", sessionID, "--pure"], {
      env, cwd: prepared.rootDirectory, signal, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 * 1024,
    });
    if (exported.exitCode !== 0 || exported.timedOut || exported.aborted) throw new Error("Export failed");
    const data = JSON.parse(exported.stdout);
    for (const message of data.messages ?? []) {
      options.trace?.message(message);
      if (message.info?.role === "assistant" && message.info.providerID && message.info.modelID) actualModel = {
        providerID: message.info.providerID, modelID: message.info.modelID,
      };
    }
  } catch { warnings.push("CLI session export unavailable; model/usage completeness must be checked manually."); }
  signal.throwIfAborted();
  return { submission: parsed.document, rawOutput: raw,
    findings: parsed.document.findings.map(structured => ({ structured, severity: structured.severity, body: renderFinding(structured) })),
    execution: { version: 2, attemptId: options.attemptId, sessionID, opencodeVersion: "unknown", actualModel,
      workflowVersion: "oneshot-baseline/1", scope: prepared.scope, rules: { ...options.rules, resources: [...options.rules.resources, ...prepared.repositoryRules] }, progress: { activity: "单次基线完成", limitations: [] },
      durationMs: Date.now() - started, status: "ACCEPTED", warnings, performance: options.trace?.summary() } };
}
