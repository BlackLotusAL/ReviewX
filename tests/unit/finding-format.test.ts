import { expect, test } from "vitest";
import { formatFinding } from "@/src/server/finding-format";
import { structuredFinding } from "../helpers/reviewer";

test.each(["fatal", "major", "minor", "suggestion"] as const)("renders six sections and preserves uncertain premises for %s", severity => {
  const result = formatFinding({ ...structuredFinding, severity, confidence: 0,
    title: "漏液指示灯状态语义待确认",
    description: "新增长 set_leak_state_control。必要前提（未验证）：PLC state 的协议语义。\n\n```py\nstate == True\n```",
    evidence: [{ side: "source", path: "src/leak.py", startLine: 170, endLine: 177 }],
    locations: [{ evidenceIndex: 0, symbol: "set_leak_state_control" }],
    impact: "若 state=True 表示正常状态，则可能误亮红灯；该前提尚未验证。",
    solution: "待确认 PLC 协议后决定是否调整判定。",
    prevention: "待确认状态映射后补充 True/False 用例。" });
  expect(result.body.match(/^#{3,4} .+$/gmu)).toEqual([
    expect.stringContaining("漏液指示灯状态语义待确认"), "#### 问题描述", "#### 问题位置", "#### 影响分析", "#### 解决方案", "#### 预防措施",
  ]);
  expect(result.body).toContain("src/leak.py:170-177");
  expect(result.body).toContain("必要前提（未验证）：PLC state 的协议语义。");
  expect(result.body).toContain("```py\nstate == True\n```");
  expect(result.body).toContain("该前提尚未验证。");
  expect(result.confidence).toBe(0);
});
