import { expect, test } from "vitest";
import { confidenceDisplay } from "@/src/shared/confidence-display";

test.each([
  [0, "rgb(255, 228, 230)"], [25, "rgb(255, 236, 213)"],
  [50, "rgb(255, 243, 196)"], [75, "rgb(238, 248, 214)"],
  [90, "rgb(227, 250, 224)"], [98, "rgb(221, 252, 230)"],
  [100, "rgb(220, 252, 231)"], [50.5, "rgb(255, 243, 196)"],
])("interpolates %s without changing its displayed value", (score, background) => {
  expect(confidenceDisplay(score)).toEqual({ label: `${score}/100`, background });
});

test.each([undefined, null, NaN, Infinity, -Infinity, -1, 101, "98", {}])("invalid score %s uses the unevaluated display", score => {
  expect(confidenceDisplay(score)).toEqual({ label: "未评估", background: "#eef0f2" });
});
