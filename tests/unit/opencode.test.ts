import { describe, expect, it } from "vitest";
import { openCodeInlineConfig, parseOpenCodeText } from "../../src/opencode.js";

function event(text: string): string {
  return JSON.stringify({ type: "text", part: { text } });
}

describe("OpenCode event parsing and permissions", () => {
  it("reassembles every completed text part in event order", () => {
    const value = parseOpenCodeText(
      `${JSON.stringify({ type: "step_start", part: {} })}\n${event('{"verdict":')}\n${event('"pass"}')}\n`,
    );
    expect(value).toEqual({ verdict: "pass" });
  });

  it.each([
    '```json\n{"verdict":"pass"}\n```',
    '```JSON\r\n{"verdict":"pass"}\r\n```',
    '```\n{"verdict":"pass"}\n```',
    'Result follows.\n```json\n{"verdict":"pass"}\n```\nEnd of result.',
    '  ```` json\n{"verdict":"pass"}\n  ````',
    '~~~JSON\n{"verdict":"pass"}\n~~~',
  ])("extracts one JSON Markdown fenced block", (text) => {
    expect(parseOpenCodeText(`${event(text)}\n`)).toEqual({ verdict: "pass" });
  });

  it("extracts a fenced result split across OpenCode text events", () => {
    expect(
      parseOpenCodeText(
        `${event("Result follows.\n```json\n{\"verdict\":")}\n${event(
          '"pass"}\n```\nEnd of result.',
        )}\n`,
      ),
    ).toEqual({ verdict: "pass" });
  });

  it("extracts a trailing JSON object after analysis text split across events", () => {
    const result = {
      expert: "design-reviewer",
      verdict: "findings",
      findings: [{ body: 'Keep {value}, "quoted" text, and C:\\temp\\', confidence: 55 }],
    };
    expect(
      parseOpenCodeText(
        `${event(
          "The base of this MR is develop. Let me inspect function { return \\\"value\\\"; }.\n\n",
        )}\n${event(
          `Let me compose the JSON.\n\n${JSON.stringify(result)}`,
        )}\n`,
      ),
    ).toEqual(result);
  });

  it("allows whitespace but not prose after a trailing raw JSON object", () => {
    expect(
      parseOpenCodeText(`${event('Analysis first.\n{"verdict":"pass"}\n\t')}\n`),
    ).toEqual({ verdict: "pass" });
    expect(() =>
      parseOpenCodeText(`${event('Analysis first.\n{"verdict":"pass"}\nDone.')}\n`),
    ).toThrow();
  });

  it.each([
    "plain text\n",
    `${JSON.stringify({ type: "step_start" })}\n`,
    `${JSON.stringify({ type: "error", error: {} })}\n`,
    `${event('```javascript\n{"verdict":"pass"}\n```')}\n`,
    `${event('```json\n{"verdict":"pass"}\n```\n```json\n{"verdict":"pass"}\n```')}\n`,
    `${event('```json\n{"verdict":"pass"}{"verdict":"pass"}\n```')}\n`,
    `${event("```json\n\n```")}\n`,
    `${event('```json\n{"verdict":"pass"}')}\n`,
    `${event('{"verdict":"pass"}{"verdict":"pass"}')}\n`,
    `${event('Analysis.\n{"verdict":"pass"}\n{"verdict":"pass"}')}\n`,
    `${event('Analysis.\n{"verdict":}')}\n`,
    `${JSON.stringify({ type: "text", part: {} })}\n`,
  ])("rejects malformed event output", (output) => {
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
