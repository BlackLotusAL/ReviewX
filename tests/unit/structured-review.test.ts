import { expect, test } from "vitest";
import { parseReviewOutput, submissionSchema } from "@/src/server/review/schema";
import { renderFinding } from "@/src/shared/finding-markdown";
import { structuredFinding } from "../helpers/runtime";
const document = () => ({ schemaVersion: 1, summary: "完成", completion: "complete", limitations: [], findings: [structuredFinding()] });
test("accepts complete documents and isolates malformed findings without losing valid ones", () => {
  const input = { ...document(), findings: [structuredFinding(), { severity: "wrong" }] };
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
  expect(body).toContain(String.fromCharCode(96).repeat(4) + "tsmalicious");
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
