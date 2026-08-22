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

const freeMarkdown = `### 🟡 Minor: 构建选项无法生效

这是一份没有固定字段或章节要求的自由 Markdown 评论。

\`\`\`cmake
if(ENABLE_ASAN)
  add_compile_options(-fsanitize=address)
endif()
\`\`\``;

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

describe("Judge decision protocol and free Markdown body", () => {
  it.each([
    [{ verdict: "PASS" }, ""],
    [{ verdict: "DUPLICATE", duplicate_comment_id: "comment-1" }, ""],
    [{ verdict: "DUPLICATE", duplicate_comment_id: null }, ""],
    [{ verdict: "NEW", severity: "minor" }, freeMarkdown],
  ] as Array<[JudgeDecision, string]>)
  ("parses canonical %s", (decision, markdown) => {
    const header = formatJudgeDecisionHeader(decision);
    const document = `${header}${markdown === "" ? "" : `\n\n${markdown}`}`;

    expect(parseJudgeDocument(document)).toEqual({
      decision,
      markdown,
      document,
    });
  });

  it.each(["fatal", "major", "minor", "suggestion"] as const)(
    "accepts the CodeHub severity %s without inspecting the body",
    (severity) => {
      const header = formatJudgeDecisionHeader({ verdict: "NEW", severity });
      expect(parseJudgeDocument(`${header}\n\nAny non-empty Markdown.`)).toEqual({
        decision: { verdict: "NEW", severity },
        markdown: "Any non-empty Markdown.",
        document: `${header}\n\nAny non-empty Markdown.`,
      });
    },
  );

  it("accepts the reported narration and signaled body severity without field validation", () => {
    const header = '<!-- reviewx-decision: {"verdict":"NEW","severity":"minor"} -->';
    const markdown = `### 🟡 Minor: CMake 中 ASAN/TSAN 消毒器选项名不匹配

**问题描述**：

- 严重级别：🟡 Minor
- 标签：\`#correctness\` \`#maintainability\``;
    const raw = `The finding is confirmed across two expert reports.

Severity: minor is appropriate.

${header}

${markdown}`;

    expect(parseJudgeDocument(raw)).toEqual({
      decision: { verdict: "NEW", severity: "minor" },
      markdown,
      document: `${header}\n\n${markdown}`,
    });
  });

  it.each([
    "Plain text only.",
    "# A heading with no prescribed signal",
    "- one bullet",
    "中文、English、JSON-like {text} and no report sections",
  ])("accepts arbitrary non-empty NEW Markdown: %s", (markdown) => {
    const header = formatJudgeDecisionHeader({ verdict: "NEW", severity: "major" });
    expect(parseJudgeDocument(`${header}\n\n${markdown}`).markdown).toBe(markdown);
  });

  it("normalizes casing, multiline JSON, extra fields, and a fenced header", () => {
    const raw = `Narration.
\`\`\`html
<!-- REVIEWX-DECISION:
{
  "verdict": "new",
  "severity": "Minor",
  "explanation": "ignored"
}
-->
\`\`\`

Free body.`;

    expect(parseJudgeDocument(raw)).toEqual({
      decision: { verdict: "NEW", severity: "minor" },
      markdown: "Free body.",
      document: '<!-- reviewx-decision: {"verdict":"NEW","severity":"minor"} -->\n\nFree body.',
    });
  });

  it("normalizes a DUPLICATE without an ID to null and ignores extra fields", () => {
    expect(parseJudgeDocument(
      '<!-- reviewx-decision: {"verdict":"duplicate","reason":"already reported"} -->',
    )).toEqual({
      decision: { verdict: "DUPLICATE", duplicate_comment_id: null },
      markdown: "",
      document: '<!-- reviewx-decision: {"verdict":"DUPLICATE","duplicate_comment_id":null} -->',
    });
  });

  it("selects the last complete valid decision and ignores invalid candidates as body boundaries", () => {
    const first = '<!-- reviewx-decision: {"verdict":"NEW","severity":"minor"} -->';
    const last = '<!-- reviewx-decision: {"verdict":"NEW","severity":"major"} -->';
    const raw = `${first}\n\nFirst body.

<!-- reviewx-decision: {"verdict":"PASS",} -->

Still first body.

${last}\n\nFinal body.`;

    expect(parseJudgeDocument(raw)).toEqual({
      decision: { verdict: "NEW", severity: "major" },
      markdown: "Final body.",
      document: `${last}\n\nFinal body.`,
    });
  });

  it.each([
    "# Missing header",
    '<!-- reviewx-decision: {"verdict":"PASS",} -->',
    '<!-- reviewx-decision: {"verdict":"UNKNOWN"} -->',
    '<!-- reviewx-decision: {"verdict":"NEW","severity":"critical"} -->\n\nBody',
    '<!-- reviewx-decision: {"verdict":"NEW","severity":"minor"} -->\n\n   ',
    '<!-- reviewx-decision: {"verdict":"DUPLICATE","duplicate_comment_id":42} -->',
  ])("rejects only an invalid machine contract: %s", (document) => {
    expect(() => parseJudgeDocument(document)).toThrow();
  });

  it("reports machine-contract failure categories", () => {
    const document = [
      '<!-- reviewx-decision: {"verdict":"PASS",} -->',
      '<!-- reviewx-decision: {"verdict":"UNKNOWN"} -->',
      '<!-- reviewx-decision: {"verdict":"NEW","severity":"minor"} -->',
    ].join("\n");

    expect(() => parseJudgeDocument(document)).toThrow(
      /3 candidate\(s\), 1 invalid JSON, 1 protocol-invalid, 1 NEW-body-invalid/u,
    );
  });
});
