import { expect, test } from "vitest";
import { generatedFindingSchema, outputSchema, parseReviewOutput, submissionSchema } from "@/src/server/review/schema";
import { renderFinding } from "@/src/shared/finding-markdown";
import type { StructuredFinding } from "@/src/shared/review-contract";
import { discoveryPrompt, batchVerifierPrompt, productionPrompt, reviewerPrompt, verifierPrompt, repairPrompt } from "@/src/server/review/prompt";
import { generatedFinding, structuredFinding } from "../helpers/runtime";

const document = (findings: StructuredFinding[]) => ({ schemaVersion: 1, summary: "完成", completion: "complete", limitations: [], findings });

test.each([
  ["cpp", "//", "  return seconds;"], ["python", "#", "\treturn seconds"],
  ["typescript", "//", "  return seconds;"], ["sql", "--", "SELECT seconds;"],
  ["json", "", '  "timeout": 0'], ["unknown-language", "", "  value = 0"], ["constructor", "", "value = 0"],
])("%s annotations are immediately before the original line without altering source", (language, prefix, source) => {
  const finding = generatedFinding();
  finding.locations[0] = { path: "delay.file", revision: "source", startLine: 12, endLine: 12,
    snippet: { language, code: source }, annotations: [{ line: 12, text: "缺少单位换算。" }] };
  const original = structuredClone(finding);
  const indent = /^[\t ]*/u.exec(source)![0];
  const body = renderFinding(finding);
  expect(body).toContain(indent + (prefix ? prefix + " " : "") + "【检视注释·问题行 L12】缺少单位换算。\n" + source);
  expect(body).toContain("带检视标注的源码：");
  expect(body).toContain("```" + (prefix ? language : "text"));
  expect(finding).toEqual(original);
});

test("multiple annotations use original line numbers and keep unmarked lines and tabs", () => {
  const finding = generatedFinding();
  finding.locations[0] = { path: "delay.py", revision: "source", startLine: 20, endLine: 22,
    snippet: { language: "python", code: "def delay(seconds):\n\tvalue = seconds\n\treturn value" },
    annotations: [{ line: 22, text: "返回秒值而非毫秒。" }, { line: 21, text: "此处缺少乘以 1000。" }] };
  expect(renderFinding(finding)).toContain("def delay(seconds):\n\t# 【检视注释·问题行 L21】此处缺少乘以 1000。\n\tvalue = seconds\n\t# 【检视注释·问题行 L22】返回秒值而非毫秒。\n\treturn value");
});

test("file/revision groups preserve all ranges and do not merge source with base", () => {
  const finding = generatedFinding();
  const first = { ...finding.locations[0], snippet: { language: "typescript", code: "bad();" } };
  finding.locations = [first, { ...first, path: "other.ts" },
    { ...first, startLine: 4, endLine: 4, annotations: [{ line: 4, text: "另一个错误调用。" }] }, { ...first, revision: "base" }];
  const body = renderFinding(finding);
  expect(body).toContain("1. `fixture.ts`（当前版本）");
  expect(body).toContain("2. `other.ts`（当前版本）");
  expect(body).toContain("3. `fixture.ts`（基线版本）");
  expect(body).toContain("`fixture.ts:4-4`");
  expect(body.match(/带检视标注的源码：/gu)).toHaveLength(4);
  expect(body.indexOf("fixture.ts:4-4")).toBeLessThan(body.indexOf("2. `other.ts`"));
});

test("backticks in both annotation and source lengthen the fence; headings remain data", () => {
  const finding = generatedFinding();
  finding.locations[0].annotations = [{ line: 1, text: "包含 ``` 和 <script>，需要检查。" }];
  finding.locations[0].snippet = { language: "cpp", code: 'const char* value = "````";' };
  expect(renderFinding(finding)).toContain('`````cpp\n// 【检视注释·问题行 L1】包含 ``` 和 <script>，需要检查。\nconst char* value = "````";\n`````');
});

test("missing source keeps original annotations inside a text block", () => {
  const finding = generatedFinding();
  const body = renderFinding(finding);
  expect(body).toContain("```text\n源码未能读取；以下标注使用原始行号。\n【检视注释·问题行 L1】此处逻辑导致调用结果错误。\n```");
  expect(generatedFindingSchema.safeParse(finding).success).toBe(true);
});

test("a complete multi-language fix has coordinated steps; alternatives are independent strategies", () => {
  const finding = generatedFinding();
  finding.solutions = [{ kind: "recommended", description: "恢复全部辅助函数的单位换算。", steps: [
    { path: "delay.h", description: "修复 C++ 实现。", example: { language: "cpp", code: "return seconds * 1000;" } },
    { path: "delay.py", description: "修复 Python 实现。", example: { language: "python", code: "return seconds * 1000" } },
  ] }, { kind: "alternative", description: "统一调整调用接口。", applicability: "所有调用方能够同步迁移时适用；改动范围更大。", steps: [{ description: "同步更新全部调用方和接口契约。" }] }];
  expect(generatedFindingSchema.safeParse(finding).success).toBe(true);
  const body = renderFinding(finding);
  expect(body.match(/\*\*推荐方案\*\*/gu)).toHaveLength(1);
  expect(body.match(/\*\*备用方案\*\*/gu)).toHaveLength(1);
  expect(body).toContain("1. `delay.h`：修复 C\\+\\+ 实现。");
  expect(body).toContain("2. `delay.py`：修复 Python 实现。");
  expect(body).toContain("适用条件与取舍：所有调用方能够同步迁移时适用；改动范围更大。");
  expect(body).toContain("   ```python\n   return seconds * 1000\n   ```");
  expect(finding.solutions[0].steps![0].example!.code).not.toContain("检视注释");
  finding.solutions.pop();
  expect(renderFinding(finding)).not.toContain("备用方案");
});

test("several genuine alternatives are numbered separately from their steps", () => {
  const finding = generatedFinding();
  finding.solutions.push(...[1, 2].map(i => ({ kind: "alternative" as const, description: `备用策略 ${i}`, applicability: "条件成立时适用。", steps: [{ description: "完成该策略的修改。" }] })));
  expect(renderFinding(finding)).toContain("**备用方案 1**");
  expect(renderFinding(finding)).toContain("**备用方案 2**");
});

test("generation requires bounded annotations and complete strategies; historical shape stays valid", () => {
  const finding = generatedFinding();
  const check = (edit: (f: StructuredFinding) => void) => {
    const invalid = structuredClone(finding); edit(invalid);
    const result = parseReviewOutput(JSON.stringify(document([finding, invalid])));
    expect(result.document.findings).toEqual([finding]); expect(result.invalid).toEqual([invalid]);
  };
  check(f => { delete f.locations[0].annotations; });
  check(f => { f.locations[0].annotations = []; });
  check(f => { f.locations[0].annotations![0].line = 0; });
  check(f => { f.locations[0].annotations![0].line = 2; });
  check(f => { f.locations[0].endLine = 100; f.locations[0].annotations![0].line = 41; });
  check(f => { f.locations[0].annotations![0].text = "字".repeat(121); });
  check(f => { f.locations[0].annotations![0].text = "第一行\n第二行"; });
  check(f => { delete f.solutions[0].kind; });
  check(f => { f.solutions.push(structuredClone(f.solutions[0])); });
  check(f => { f.solutions[0].kind = "alternative"; f.solutions[0].applicability = "替代条件。"; });
  check(f => { f.solutions[0].steps = []; });
  check(f => { delete f.solutions[0].steps; });
  check(f => { f.solutions[0].example = { language: "ts", code: "repair();" }; });
  check(f => { f.solutions[0].steps![0] = { description: "修复。", example: { language: "ts", code: "repair();" } }; });
  check(f => { f.solutions[0].steps![0].path = "../outside"; });
  check(f => { f.solutions.push({ kind: "alternative", description: "另一策略", steps: [{ description: "修改。" }] }); });
  const boundary = structuredClone(finding); boundary.locations[0].endLine = 100;
  boundary.locations[0].annotations = [{ line: 40, text: "字".repeat(120) }];
  expect(generatedFindingSchema.safeParse(boundary).success).toBe(true);
  const old = structuredFinding("旧".repeat(500)); old.tags = ["legacy"];
  old.solutions[0].example = { language: "python", code: "old_fix()" };
  expect(submissionSchema.parse(document([old])).findings).toEqual([old]);
  expect(renderFinding(old)).not.toContain("推荐方案");
  expect(renderFinding(old)).toContain("old_fix()");
  expect(submissionSchema.parse(document([finding])).findings).toEqual([finding]);
});

test("the JSON schema and every generation/verification prompt describe the new contract", () => {
  const fields = JSON.parse(JSON.stringify(outputSchema)).properties.findings.items.properties;
  expect(fields.locations.items.required).toContain("annotations");
  expect(fields.locations.items.properties.annotations.items.properties.text.maxLength).toBe(120);
  expect(fields.solutions.items.required).toEqual(expect.arrayContaining(["kind", "steps"]));
  expect(fields.solutions.items.additionalProperties).toBe(false);
  for (const prompt of [discoveryPrompt, batchVerifierPrompt, productionPrompt, reviewerPrompt, verifierPrompt, repairPrompt]) {
    expect(prompt).toContain("ORIGINAL one-based"); expect(prompt).toContain("INSIDE");
    expect(prompt).toContain("kind=recommended"); expect(prompt).toContain("solutions[].steps[].example");
    expect(prompt).toContain("NOT alternatives");
  }
});
