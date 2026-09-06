import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MergeRequestSnapshot, ReviewCheckpoint, ReviewerFinding } from "@/src/shared/types";
import type { PreparedReview } from "@/src/server/git";
import type { OpenCodeMessage } from "@/src/server/opencode-client";

export const finding: ReviewerFinding = {
  severity: "major", body: '### 🟠 Major: 越权\n\n```ts\nrole === "user"\n```\n路径 `src\\authorization.ts`', confidence: 95,
  verificationSummary: "已核对调用方，无所有者校验。",
  evidence: [{ side: "source", path: "src/authorization.ts", startLine: 2, endLine: 2 }],
};
export const completeCheckpoint = (findings: ReviewerFinding[] = [finding]): ReviewCheckpoint => ({ status: "complete", nextChecks: [], findings, limitations: [] });
export function assistant(structured?: unknown, error?: string): OpenCodeMessage {
  return { info: { id: "msg_assistant", parentID: "msg_user", sessionID: "ses_test", role: "assistant",
    providerID: "deepseek", modelID: "deepseek-v4-flash", time: { created: 1, completed: 2 },
    finish: structured === undefined ? "stop" : "tool-calls", structured, ...(error ? { error: { name: error } } : {}) },
    parts: [{ type: "text", text: "这是过程文字，不能作为最终 JSON。" }],
  };
}
export async function preparedFixture(): Promise<{ prepared: PreparedReview; details: MergeRequestSnapshot; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "reviewx-reviewer-test-"));
  const review = path.join(root, "review");
  const runtime = path.join(root, "runtime");
  await mkdir(path.join(review, "source", "src"), { recursive: true });
  await mkdir(path.join(review, "base", "src"), { recursive: true });
  await mkdir(runtime, { recursive: true });
  const patch = 'diff --git a/src/authorization.ts b/src/authorization.ts\n--- a/src/authorization.ts\n+++ b/src/authorization.ts\n@@ -1,3 +1,3 @@\n function allow() {\n-  return false;\n+  return true;\n }\n';
  await writeFile(path.join(review, "changes.patch"), patch, "utf8");
  await writeFile(path.join(review, "source", "src", "authorization.ts"), "function allow() {\n  return true;\n}\n", "utf8");
  await writeFile(path.join(review, "base", "src", "authorization.ts"), "function allow() {\n  return false;\n}\n", "utf8");
  const prepared: PreparedReview = {
    rootDirectory: review, sourceDirectory: path.join(review, "source"), baseDirectory: path.join(review, "base"), runtimeDirectory: runtime,
    patchPath: path.join(review, "changes.patch"), bundlePath: path.join(review, "review-bundle.txt"), manifestPath: path.join(review, "manifest.json"),
    sourceSha: "1".repeat(40), targetSha: "2".repeat(40), baseSha: "3".repeat(40), limitations: [],
    files: ["source", "base"].map(side => ({ side: side as "source" | "base", path: "src/authorization.ts", lines: 3, changedLines: [{ start: 2, end: 2 }] })),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
  await writeFile(prepared.manifestPath, JSON.stringify({ files: prepared.files }), "utf8");
  return { root, prepared, details: { projectId: "101", iid: "7", title: "Authorization", state: "open", sourceBranch: "feature", targetBranch: "main", updatedAt: "now" } };
}
