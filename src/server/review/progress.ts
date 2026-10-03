import type { ReviewProgress } from "@/src/shared/review-contract";
import { REVIEW_LIMITS } from "./materials";

/** Soft target is informational; it never aborts or changes completion. */
export function timedProgress(progress: ReviewProgress, elapsedMs: number): ReviewProgress {
  return elapsedMs < REVIEW_LIMITS.softTargetMs || progress.activity.startsWith("已超过 5 分钟目标") ? progress : {
    ...progress, activity: `已超过 5 分钟目标，继续完成检视 · ${progress.activity}`,
  };
}
