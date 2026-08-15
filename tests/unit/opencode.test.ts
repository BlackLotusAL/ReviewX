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
