import { expect, test } from "vitest";
import { reviewDuration } from "@/src/shared/review-duration";
import type { MrDisplayStatus } from "@/src/shared/types";

const start = "2026-09-10T00:00:00Z";
const at = (seconds: number) => Date.parse(start) + seconds * 1000;

test.each([[0, "0 秒"], [42, "42 秒"], [59, "59 秒"], [60, "1 分 00 秒"], [188, "3 分 08 秒"], [3725, "1 时 02 分 05 秒"]])("formats elapsed %s seconds", (seconds, result) => {
  expect(reviewDuration({ status: "reviewing", reviewStartedAt: start }, at(Number(seconds)))).toBe(result);
});

test("only running reviews tick; terminal results retain their review finish despite later decisions", () => {
  for (const status of ["reviewing", "stopping"] as MrDisplayStatus[]) {
    expect(reviewDuration({ status, reviewStartedAt: start }, at(42))).toBe("42 秒");
    expect(reviewDuration({ status, reviewStartedAt: start }, at(43))).toBe("43 秒");
  }
  for (const status of ["awaiting_confirmation", "publishing", "completed", "publish_failed", "review_failed", "stopped", "archived"] as MrDisplayStatus[]) {
    const row = { status, reviewStartedAt: start, reviewFinishedAt: new Date(at(42)).toISOString() };
    expect(reviewDuration(row, at(7200))).toBe("42 秒");
    expect(reviewDuration({ ...row, reviewFinishedAt: undefined }, at(7200))).toBe("—");
  }
});

test("omits unstarted work and handles missing, invalid or backwards timestamps", () => {
  for (const status of ["unreviewed", "queued", "stopped"] as MrDisplayStatus[]) expect(reviewDuration({ status }, at(42))).toBeNull();
  expect(reviewDuration({ status: "completed" }, at(42))).toBe("—");
  expect(reviewDuration({ status: "reviewing", reviewStartedAt: "invalid" }, at(42))).toBe("—");
  expect(reviewDuration({ status: "reviewing", reviewStartedAt: start }, at(-1))).toBe("—");
  expect(reviewDuration({ status: "completed", reviewStartedAt: start, reviewFinishedAt: "invalid" }, at(42))).toBe("—");
});
