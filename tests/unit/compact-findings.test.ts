import { expect, test } from "vitest";
import { findingLocationGroups } from "@/src/shared/finding-locations";
import { renderFinding } from "@/src/shared/finding-markdown";
import { generatedFindingSchema, submissionSchema } from "@/src/server/review/schema";
import type { ReviewLocation } from "@/src/shared/review-contract";
import { generatedFinding } from "../helpers/runtime";

function location(startLine: number, endLine: number, extra: Partial<ReviewLocation> = {}): ReviewLocation {
  return { path: "api.py", revision: "source", startLine, endLine,
    snippet: { language: "python", code: Array.from({ length: endLine - startLine + 1 }, (_, i) => `line_${startLine + i}()`).join("\n") },
    annotations: [{ line: startLine, text: "类型不一致。" }], highlights: [{ startLine, endLine }], ...extra };
}

test("same-file evidence uses a single compact path and block with honest omissions", () => {
  const f = generatedFinding(); f.locations = [location(705, 706, { label: "FitLinePolar()" }), location(696, 696, { label: "导入" })];
  const original = structuredClone(f);
  const body = renderFinding(f);
  expect(body).toContain("**问题位置**：`api.py:696,705-706`");
  expect(body).toContain("# 导入 L696\nline_696()  # 类型不一致。 [!code error:1]\n# … 省略原始 L697–704 …\n# FitLinePolar() L705-706\nline_705()  # 类型不一致。 [!code error:2]\nline_706()");
  expect(body.match(/```python/gu)).toHaveLength(1);
  expect(body).not.toContain("带检视标注"); expect(f).toEqual(original);
});

test("overlapping and adjacent locations deduplicate source and compact ranges", () => {
  const groups = findingLocationGroups([location(1, 3), location(2, 4), location(5, 5)], "error");
  expect(groups[0].path).toBe("api.py:1-5");
  expect(groups[0].blocks[0].code.match(/line_2\(\)/gu)).toHaveLength(1);
  expect(groups[0].blocks[0].code).toContain("[!code error:4]");
  expect(groups[0].blocks[0].code).toContain("[!code error:1]");
});

test("forty-source-line pages split markers and do not count inserted explanations", () => {
  const a = location(1, 40, { highlights: [{ startLine: 20, endLine: 40 }] });
  const b = location(21, 60, { highlights: [{ startLine: 21, endLine: 59 }] });
  const group = findingLocationGroups([a, b], "warning")[0];
  expect(group.blocks).toHaveLength(2);
  expect(group.blocks.map(block => block.code.split("\n").filter(line => line.startsWith("line_")).length)).toEqual([40, 20]);
  expect(group.blocks[0].code).toContain("line_20()  # [!code warning:21]");
  expect(group.blocks[1].code).toContain("line_41()  # [!code warning:19]");
  expect(group.blocks[1].code).toContain("# L41-60");
});

test("context labels split continuous markers; evidence-only contexts are valid", () => {
  const f = generatedFinding();
  f.locations = [location(1, 6), location(4, 6, { label: "返回路径", highlights: [] })];
  expect(generatedFindingSchema.safeParse(f).success).toBe(true);
  const body = renderFinding(f);
  expect(body.match(/\[!code error:3\]/gu)).toHaveLength(2);
  expect(body).toContain("# 返回路径 L4-6");
  f.locations.forEach(l => { l.highlights = []; });
  expect(generatedFindingSchema.safeParse(f).success).toBe(false);
});

test("label validation affects new generation only", () => {
  const f = generatedFinding(); f.locations[0].label = "字".repeat(40);
  expect(generatedFindingSchema.safeParse(f).success).toBe(true);
  f.locations[0].label += "字";
  expect(generatedFindingSchema.safeParse(f).success).toBe(false);
  expect(submissionSchema.safeParse({ schemaVersion: 1, summary: "完成", completion: "complete", limitations: [], findings: [f] }).success).toBe(true);
  f.locations[0].label = "read()\ncleanup()";
  expect(generatedFindingSchema.safeParse(f).success).toBe(false);
});

test("one textual replacement has no duplicated summary, recommendation or numbering", () => {
  const f = generatedFinding();
  f.solutions = [{ kind: "recommended", description: "重复的方案摘要", steps: [{ path: "api.py", description: "将 `WrongReq` 改为 `Req`，返回 `Reply()`。" }] }];
  const solution = renderFinding(f).split("**解决方案**：")[1].split("**预防措施**")[0];
  expect(solution.trim()).toBe("`api.py`：将 `WrongReq` 改为 `Req`，返回 `Reply()`。");
});

test("a single resource-management step shows a minimal branch without extra hierarchy", () => {
  const f = generatedFinding();
  f.solutions = [{ kind: "recommended", description: "补充释放分支", steps: [{ path: "dat.cpp", description: "在 `cleanup()` 中增加分支：", example: { language: "cpp", code: '} else if (key == "width") {\n    delete static_cast<uint32_t*>(value);\n}' } }] }];
  const body = renderFinding(f);
  expect(body).not.toContain("推荐方案"); expect(body).not.toContain("1. `dat.cpp`");
  expect(body).toContain('```cpp\n} else if (key == "width")');
});
