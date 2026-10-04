import { expect, test } from "vitest";
import { generatedFindingSchema, outputSchema, parseReviewOutput, submissionSchema } from "@/src/server/review/schema";
import { renderFinding } from "@/src/shared/finding-markdown";
import { structuredFinding, generatedFinding } from "../helpers/runtime";
const document = () => ({ schemaVersion: 1, summary: "完成", completion: "complete", limitations: [], findings: [generatedFinding()] });
test("accepts complete documents and isolates malformed findings without losing valid ones", () => {
  const input = { ...document(), findings: [generatedFinding(), { severity: "wrong" }] };
  const parsed = parseReviewOutput(JSON.stringify(input));
  expect(parsed.document.findings).toHaveLength(1); expect(parsed.invalid).toHaveLength(1);
  expect(parsed.errors[0]).toContain("findings[1]");
  expect(submissionSchema.safeParse(document()).success).toBe(true);
});
test("chat fragments and invalid locations are never promoted to a complete output", () => {
  expect(parseReviewOutput("I found nothing").envelopeValid).toBe(false);
  const d = document(); d.findings[0].locations[0].path = "../outside";
  expect(parseReviewOutput(JSON.stringify(d)).document.findings).toHaveLength(0);
});
test("fixed renderer owns headings, severity, escaping and code fences", () => {
  const finding = structuredFinding("a <script> & **bold**\nnext");
  finding.title = "title\n### injected";
  finding.tags = ["#state"];
  finding.locations[0].snippet = { language: "ts\nmalicious", code: "const x = '" + String.fromCharCode(96).repeat(3) + "';\n" };
  const body = renderFinding(finding);
  expect(body).toContain("### 🟠 Major:");
  expect(body).toContain("- 严重级别：Major");
  expect(body).toContain("\\<script\\>");
  expect(body).toContain(String.fromCharCode(96).repeat(4) + "text");
  expect(body).not.toContain("\n### injected");
  for (const label of ["问题描述", "问题位置", "影响分析", "解决方案", "预防措施"]) expect(body).toContain("**" + label + "**");
  expect(renderFinding(finding)).toBe(body);
});
test("plain text and snippets preserve meaning; optional code blocks are not required", () => {
  const f = structuredFinding(); f.solutions.push({ description: "另一个方案" });
  const body = renderFinding(f);
  expect(body).toContain("2. 另一个方案"); expect(body).not.toContain(String.fromCharCode(96).repeat(3));
  f.locations[0].endLine = 0;
  expect(submissionSchema.safeParse({ ...document(), findings: [f] }).success).toBe(false);
});

test.each(["fatal", "major", "minor", "suggestion"] as const)("PRD comment template: %s", severity => {
  const f = structuredFinding("换算缺失导致等待时间过短。");
  f.severity = severity; f.title = "恢复换算"; f.tags = ["功能回归", "单位换算"];
  f.locations[0] = { path: "delay.py", revision: "source", startLine: 2, endLine: 2, snippet: { language: "python", code: "    return seconds" } };
  f.solutions[0] = { description: "恢复毫秒换算。", example: { language: "python", code: "def delay(seconds):\n    return seconds * 1000" } };
  const levels = { fatal: "🔴 Fatal", major: "🟠 Major", minor: "🟡 Minor", suggestion: "🟢 Suggestion" };
  const level = levels[severity].split(" ")[1];
  expect(renderFinding(f)).toBe([
    `### ${levels[severity]}: 恢复换算`, "", "**问题描述**：", "",
    `- 严重级别：${level}`, "- 标签：`#功能回归` `#单位换算`", "- 简述：换算缺失导致等待时间过短。", "",
    "**问题位置**：`delay.py:2`", "", "```python", "    return seconds", "```", "",
    "**影响分析**：", "", "- **直接后果**：结果错误", "- **影响范围**：调用者", "- **触发条件**：调用函数", "",
    "**解决方案**：", "", "恢复毫秒换算。", "", "```python", "def delay(seconds):", "    return seconds * 1000", "```", "",
    "**预防措施**：", "", "- 添加边界测试",
  ].join("\n"));
});

test("multiple locations keep their revision and empty tags are explicit", () => {
  const f = structuredFinding();
  f.locations.push({ path: "old.ts", revision: "base", startLine: 3, endLine: 4 });
  const body = renderFinding(f);
  expect(body).toContain("- 标签：无");
  expect(body).toContain("**问题位置**：\n\n1. `fixture.ts:1`");
  expect(body).toContain("`old.ts:3-4`（基线版本）");
  expect(body.match(/\*\*问题位置\*\*/gu)).toHaveLength(1);
  expect(body).not.toContain("1. 修复逻辑");
});

test("new briefs enforce the boundary and a single paragraph without truncation", () => {
  const accepted = generatedFinding("字".repeat(120));
  expect(generatedFindingSchema.safeParse(accepted).success).toBe(true);
  for (const description of ["字".repeat(121), "第一句\n第二句", "第一句\r第二句", "第一句\u2028第二句", "第一句\u2029第二句", "第一句。第二句。第三句。", "One. Two. Three."]) {
    const rejected = generatedFinding(description);
    const input = { ...document(), findings: [accepted, rejected] };
    const parsed = parseReviewOutput(JSON.stringify(input));
    expect(parsed.document.findings).toEqual([accepted]);
    expect(parsed.invalid).toEqual([rejected]);
    expect(parsed.errors[0]).toContain("description");
  }
  expect(generatedFindingSchema.safeParse(generatedFinding("foo.bar 未进行换算，结果错误。第二个调用方也受影响。")).success).toBe(true);
});

test("generation schema exposes the constraints; Chinese categories normalize duplicates", () => {
  const schema = JSON.parse(JSON.stringify(outputSchema));
  const fields = schema.properties.findings.items.properties;
  expect(fields.description.maxLength).toBe(120);
  expect(fields.description.pattern).toBeTruthy();
  expect(fields.tags.items.enum).toContain("功能回归");
  const f = generatedFinding(); f.tags = ["功能回归", "单位换算", "功能回归"];
  expect(parseReviewOutput(JSON.stringify({ ...document(), findings: [f] })).document.findings[0].tags).toEqual(["功能回归", "单位换算"]);
  for (const tag of ["functional-regression", "#功能回归", "Qt", "未定义的中文分类"]) {
    f.tags = [tag];
    expect(parseReviewOutput(JSON.stringify({ ...document(), findings: [f] })).invalid).toEqual([f]);
  }
});

test("the historical contract still accepts long descriptions and freeform tags", () => {
  const f = structuredFinding(Array(200).fill("旧说明").join("\n")); f.tags = ["#state", "历史标签"];
  expect(submissionSchema.parse({ ...document(), findings: [f] }).findings[0]).toEqual(f);
  expect(generatedFindingSchema.safeParse(f).success).toBe(false);
});
