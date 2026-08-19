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
    [{ verdict: "pass" }, "# Internal rationale"],
    [{ verdict: "duplicate_of", duplicate_comment_id: "comment-1" }, ""],
    [{ verdict: "duplicate_of", duplicate_comment_id: null }, "# Unknown publication"],
    [{ verdict: "new", severity: "Major" }, "\n# Flexible comment\n\n{braces} and prose"],
  ] as Array<[JudgeDecision, string]>)
  ("parses %s while preserving the Markdown body", (decision, markdown) => {
    const document = `${formatJudgeDecisionHeader(decision)}${markdown === "" ? "" : `\n${markdown}`}`;
    expect(parseJudgeDocument(document)).toEqual({ decision, markdown, document });
  });

  it("discards transient narration before the single standalone control header", () => {
    const canonical = '<!-- reviewx-decision: {"verdict":"pass"} -->\n\n# Rationale';
    expect(parseJudgeDocument(`I inspected the worktree.\n\n${canonical}`)).toEqual({
      decision: { verdict: "pass" },
      markdown: "\n# Rationale",
      document: canonical,
    });
  });

  it.each([
    "# Missing header",
    '<!-- reviewx-decision: {"verdict":"pass",} -->',
    '<!-- reviewx-decision: {"verdict":"pass","extra":true} -->',
    '<!-- reviewx-decision: {"verdict":"new","severity":"High"} -->\n# Comment',
    '<!-- reviewx-decision: {"verdict":"new","severity":"Major"} -->',
    '```html\n<!-- reviewx-decision: {"verdict":"pass"} -->\n```',
    '<!-- reviewx-decision: {"verdict":"pass"} -->\n<!-- reviewx-decision: {"verdict":"pass"} -->',
  ])("rejects an invalid control document", (document) => {
    expect(() => parseJudgeDocument(document)).toThrow();
  });
});
