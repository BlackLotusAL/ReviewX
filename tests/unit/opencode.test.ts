import { describe, expect, it } from "vitest";
import type { JudgeDecision } from "../../src/contracts.js";
import {
  formatJudgeDecisionHeader,
  parseJudgeDocument,
} from "../../src/judge-report.js";
import { openCodeInlineConfig, parseOpenCodeText } from "../../src/opencode.js";

function event(text: string): string {
  return JSON.stringify({ type: "text", part: { text } });
}

const validNewMarkdown = `### 🟡 Minor: 终止消息可能丢失已有报告

**问题描述**：

- 严重级别：Minor
- 标签：\`#correctness\` \`#observability\`
- 简述：终止消息没有文本时，解析器不会回退到前一条已有报告的消息

**问题位置**： \`src/opencode.ts:105-116\`

\`\`\`ts
const text = terminalMessage.text; // [!code warning] 空文本会覆盖已有报告
return text;
\`\`\`

**影响分析**：

- **直接后果**：有效报告会被丢弃，整次检视失败
- **影响范围**：所有以空终止消息结束的 Agent 调用
- **触发条件**：终止消息不含文本但之前已经产生有效报告

**解决方案**：

**方案1（推荐）**：空终止消息回退到最后一条有效文本

\`\`\`ts
return terminalMessage.text || lastTextMessage.text;
\`\`\`

**方案2**：忽略不含文本的终止消息

\`\`\`ts
if (terminalMessage.text) return terminalMessage.text;
return previousReport;
\`\`\`

**预防措施**：

- 增加空终止消息的回归测试
- 统一最终文本选择逻辑`;

const severityDisplay = {
  fatal: ["🔴", "Fatal"],
  major: ["🟠", "Major"],
  minor: ["🟡", "Minor"],
  suggestion: ["🟢", "Suggestion"],
} as const;

function markdownForSeverity(severity: keyof typeof severityDisplay): string {
  const [signal, label] = severityDisplay[severity];
  return validNewMarkdown
    .replace("🟡 Minor", `${signal} ${label}`)
    .replace("严重级别：Minor", `严重级别：${label}`);
}

describe("OpenCode Markdown event parsing and permissions", () => {
  it("reassembles every completed text part in event order", () => {
    const value = parseOpenCodeText(
      `${JSON.stringify({ type: "step_start", part: {} })}\n${event("# Report\n")}\n${event("Body {with JSON-like text}")}\n`,
    );
    expect(value).toBe("# Report\nBody {with JSON-like text}");
  });

  it("accepts arbitrary non-empty Markdown without extraction or repair", () => {
    const markdown = `Analysis first.

\`\`\`json
{"not":"a protocol"}
\`\`\`

Trailing prose.`;
    expect(parseOpenCodeText(`${event(markdown)}\n`)).toBe(markdown);
  });

  it("preserves leading and trailing whitespace in assistant Markdown", () => {
    const markdown = "\n# Report\n\nBody.  \n";
    expect(parseOpenCodeText(`${event(markdown)}\n`)).toBe(markdown);
  });

  it("uses only the final assistant message after tool-call narration", () => {
    const firstMessage = "msg-first";
    const finalMessage = "msg-final";
    const output = [
      { type: "text", part: { messageID: firstMessage, text: "I will inspect." } },
      { type: "step_finish", part: { messageID: firstMessage, reason: "tool-calls" } },
      { type: "text", part: { messageID: finalMessage, text: "Final " } },
      { type: "text", part: { messageID: finalMessage, text: "report" } },
      { type: "step_finish", part: { messageID: finalMessage, reason: "stop" } },
    ].map((value) => JSON.stringify(value)).join("\n");
    expect(parseOpenCodeText(`${output}\n`)).toBe("Final report");
  });

  it.each([
    "plain text\n",
    `${JSON.stringify({ type: "step_start" })}\n`,
    `${JSON.stringify({ type: "error", error: {} })}\n`,
    `${JSON.stringify({ type: "text", part: {} })}\n`,
    `${event("   ")}\n`,
  ])("rejects malformed or empty event output", (output) => {
    expect(() => parseOpenCodeText(output)).toThrow();
  });

  it("uses deny-first permissions with only four read-only Git families", () => {
    const permission = openCodeInlineConfig.permission;
    expect(permission["*"]).toBe("deny");
    expect(permission.edit).toBe("deny");
    expect(permission.webfetch).toBe("deny");
    expect(permission.external_directory).toBe("deny");
    expect(permission.bash).toMatchObject({
      "*": "deny",
      "git status *": "allow",
      "git log *": "allow",
      "git show *": "allow",
      "git diff *": "allow",
    });
  });
});

describe("Judge Markdown control header", () => {
  it.each([
    [{ verdict: "PASS" }, "# Internal rationale"],
    [{ verdict: "DUPLICATE", duplicate_comment_id: "comment-1" }, ""],
    [{ verdict: "DUPLICATE", duplicate_comment_id: null }, "# Unknown publication"],
    [{ verdict: "NEW", severity: "minor" }, validNewMarkdown],
  ] as Array<[JudgeDecision, string]>)
  ("parses %s while preserving the Markdown body", (decision, markdown) => {
    const document = `${formatJudgeDecisionHeader(decision)}${markdown === "" ? "" : decision.verdict === "NEW" ? `\n\n${markdown}` : `\n${markdown}`}`;
    const isNew = decision.verdict === "NEW";
    expect(parseJudgeDocument(document)).toEqual({
      decision,
      markdown: isNew ? markdown : "",
      document: isNew ? document : formatJudgeDecisionHeader(decision),
    });
  });

  it.each([
    "fatal",
    "major",
    "minor",
    "suggestion",
  ] as const)("accepts the CodeHub severity %s and its marker", (severity) => {
    const markdown = markdownForSeverity(severity);
    const document = `${formatJudgeDecisionHeader({ verdict: "NEW", severity })}\n\n${markdown}`;

    expect(parseJudgeDocument(document)).toMatchObject({
      decision: { verdict: "NEW", severity },
      markdown,
    });
  });

  it("rejects the legacy blue Suggestion signal", () => {
    const markdown = markdownForSeverity("suggestion").replace("🟢 Suggestion", "🔵 Suggestion");
    const document = `${formatJudgeDecisionHeader({ verdict: "NEW", severity: "suggestion" })}\n\n${markdown}`;

    expect(() => parseJudgeDocument(document)).toThrow();
  });

  it("extracts a canonical NEW report from surrounding assistant narration", () => {
    const header = formatJudgeDecisionHeader({ verdict: "NEW", severity: "minor" });
    const document = `I have sufficient evidence.\n\n${header}\n\n${validNewMarkdown}\n\nI need to fix a typo. Let me re-output the final answer cleanly.`;

    expect(parseJudgeDocument(document)).toEqual({
      decision: { verdict: "NEW", severity: "minor" },
      markdown: validNewMarkdown,
      document: `${header}\n\n${validNewMarkdown}`,
    });
  });

  it("discards transient narration before the single standalone control header", () => {
    const canonical = '<!-- reviewx-decision: {"verdict":"PASS"} -->\n\n# Rationale';
    expect(parseJudgeDocument(`I inspected the worktree.\n\n${canonical}`)).toEqual({
      decision: { verdict: "PASS" },
      markdown: "",
      document: '<!-- reviewx-decision: {"verdict":"PASS"} -->',
    });
  });

  it.each([
    '  <!-- reviewx-decision: {"verdict":"PASS"} -->',
    '```html\n<!-- reviewx-decision: {"verdict":"PASS"} -->\n```',
    'Narration <!--  reviewx-decision : {"verdict":"PASS"}-->',
  ])("extracts and canonicalizes a wrapped control header from %s", (document) => {
    expect(parseJudgeDocument(document)).toEqual({
      decision: { verdict: "PASS" },
      markdown: "",
      document: '<!-- reviewx-decision: {"verdict":"PASS"} -->',
    });
  });

  it("selects the last complete valid decision/report combination", () => {
    const minorHeader = formatJudgeDecisionHeader({ verdict: "NEW", severity: "minor" });
    const majorHeader = formatJudgeDecisionHeader({ verdict: "NEW", severity: "major" });
    const minorMarkdown = markdownForSeverity("minor");
    const majorMarkdown = markdownForSeverity("major");
    const document = [
      `${minorHeader}\n\n${minorMarkdown}`,
      "I need to correct the final decision.",
      `${majorHeader}\n\n${majorMarkdown}`,
      '<!-- reviewx-decision: {"verdict":"PASS",} -->',
    ].join("\n\n");

    expect(parseJudgeDocument(document)).toEqual({
      decision: { verdict: "NEW", severity: "major" },
      markdown: majorMarkdown,
      document: `${majorHeader}\n\n${majorMarkdown}`,
    });
  });

  it.each([
    "# Missing header",
    '<!-- reviewx-decision: {"verdict":"PASS",} -->',
    '<!-- reviewx-decision: {"verdict":"PASS","extra":true} -->',
    '<!-- reviewx-decision: {"verdict":"NEW","severity":"High"} -->\n\n# Comment',
    '<!-- reviewx-decision: {"verdict":"NEW","severity":"minor"} -->',
    '<!-- reviewx-decision: {"verdict":"pass"} -->',
  ])("rejects an invalid control document", (document) => {
    expect(() => parseJudgeDocument(document)).toThrow();
  });

  it("reports candidate failure categories when extraction finds no valid combination", () => {
    const document = [
      '<!-- reviewx-decision: {"verdict":"PASS",} -->',
      '<!-- reviewx-decision: {"verdict":"NEW","severity":"High"} -->',
      '<!-- reviewx-decision: {"verdict":"NEW","severity":"minor"} -->',
    ].join("\n");

    expect(() => parseJudgeDocument(document)).toThrow(
      /3 candidate\(s\), 1 invalid JSON, 1 protocol-invalid, 1 NEW-body-invalid/u,
    );
  });

  it.each([
    validNewMarkdown.replace("**影响分析**：", "**额外章节**：\n\n内容\n\n**影响分析**："),
    validNewMarkdown.replace("`src/opencode.ts:105-116`", "`C:\\src\\opencode.ts:105-116`"),
    validNewMarkdown.replace(
      "- 简述：终止消息没有文本时，解析器不会回退到前一条已有报告的消息",
      "- 简述：",
    ),
    validNewMarkdown.replace("`#correctness`", "`#缺陷`"),
    validNewMarkdown.replace("### 🟡 Minor:", "### 🟢 Suggestion:"),
    validNewMarkdown.replace("```ts\nconst text", "const text"),
    `${validNewMarkdown}\nI need to fix a typo.`,
  ])("rejects NEW Markdown that diverges from the reference template", (markdown) => {
    const document = `${formatJudgeDecisionHeader({ verdict: "NEW", severity: "minor" })}\n\n${markdown}`;
    expect(() => parseJudgeDocument(document)).toThrow();
  });
});
