import type { SelectedFinding } from "./contracts.js";
import { ReviewXError } from "./errors.js";

function includesLabeledValue(markdown: string, label: string, value: string): boolean {
  const index = markdown.indexOf(`**${label}**`);
  return index >= 0 && markdown.slice(index).includes(value);
}

export function validateCommentMarkdown(markdown: string, finding: SelectedFinding): void {
  const heading = `### [${finding.severity}]${finding.tags.map((tag) => `[${tag}]`).join("")} ${finding.title}`;
  const firstContentLine = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  const location =
    finding.start_line === finding.end_line
      ? `${finding.file}:${finding.start_line}`
      : `${finding.file}:${finding.start_line}-${finding.end_line}`;
  const requiredValues: Array<[string, string]> = [
    ["位置", location],
    ["问题", finding.problem],
    ["触发条件", finding.trigger],
    ["影响", finding.impact],
    ["修改建议", finding.recommendation],
    ["置信度", `${finding.confidence}%`],
  ];

  const validRules =
    finding.rule_ids.length === 0
      ? includesLabeledValue(markdown, "规则", "无")
      : finding.rule_ids.every((rule) => includesLabeledValue(markdown, "规则", rule));
  const fencedCode = /```[^\r\n]*\r?\n[\s\S]*?```/u.test(markdown);

  if (
    firstContentLine !== heading ||
    !requiredValues.every(([label, value]) => includesLabeledValue(markdown, label, value)) ||
    !validRules ||
    !fencedCode ||
    !markdown.includes(finding.example_code)
  ) {
    throw new ReviewXError(
      "AGENT_ERROR",
      "Judge comment_markdown does not match the selected finding or required comment format.",
    );
  }
}
