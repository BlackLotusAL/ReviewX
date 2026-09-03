import type { ReviewAttempt } from "@/src/shared/types";

const failedStatuses = new Set(["failed", "unknown", "not_attempted"]);

export function settleFindingDecisions(attempt: ReviewAttempt, now: string): void {
  if (attempt.findings.some((finding) => finding.status === "pending")) {
    attempt.status = "awaiting_confirmation";
    attempt.error = undefined;
    return;
  }
  const failed = attempt.findings.find((finding) => failedStatuses.has(finding.status));
  attempt.status = failed ? "publish_failed" : "completed";
  attempt.completedAt = now;
  attempt.error = failed?.error ?? (failed ? attempt.error : undefined);
}
