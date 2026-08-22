import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { standardTags } from "../../src/contracts.js";

const agentFiles = [
  "design-reviewer.md",
  "business-reviewer.md",
  "code-reviewer.md",
  "review-judge.md",
] as const;

const controlledTagInstruction = `Allowed standard tags (case-sensitive): ${standardTags
  .map((tag) => `\`${tag}\``)
  .join(", ")}.`;

function expectInOrder(text: string, markers: readonly string[]): void {
  let offset = 0;
  for (const marker of markers) {
    const index = text.indexOf(marker, offset);
    expect(index, `Expected ${JSON.stringify(marker)} after offset ${offset}`).toBeGreaterThanOrEqual(0);
    offset = index + marker.length;
  }
}

describe("OpenCode agent prompts", () => {
  it.each(agentFiles)("keeps %s synchronized with the controlled tag schema", async (file) => {
    const prompt = await readFile(new URL(`../../opencode/agents/${file}`, import.meta.url), "utf8");

    expect(prompt).toContain(controlledTagInstruction);
    expect(prompt).toContain("use `architecture` instead of `layering`");
    expect(prompt).toContain("`compatibility` instead of `migration`");
  });

  it.each(agentFiles)("requires CodeHub severity values in %s", async (file) => {
    const prompt = await readFile(new URL(`../../opencode/agents/${file}`, import.meta.url), "utf8");

    expect(prompt).toContain("`fatal`, `major`, `minor`, or `suggestion`");
    expect(prompt).toContain("Never use `Blocker`, `Critical`, `Major`, or `Minor`");
  });

  it("keeps non-new verdicts header-only and defines the ordered Chinese new template", async () => {
    const prompt = await readFile(
      new URL("../../opencode/agents/review-judge.md", import.meta.url),
      "utf8",
    );

    expect(prompt).toContain(
      "For `PASS` and `DUPLICATE`, output only the matching control-header line.",
    );
    expect(prompt).toContain("Do not add a blank line, Markdown body, rationale, heading, table, or prose.");
    expect(prompt).toContain("After the control header, add one blank line");
    expect(prompt).toContain("Write the body in Chinese");
    expect(prompt).toContain("based on the supplied reference document");
    expect(prompt).not.toContain("## 检视结论：PASS");
    expect(prompt).not.toContain("## 检视结论：重复问题");
    expect(prompt).not.toContain("### 变更摘要");
    expect(prompt).not.toContain("### 判定依据");
    expect(prompt).not.toContain("| 项目 | 内容 |");
    expect(prompt).toContain("`🔴 fatal`, `🟠 major`, `🟡 minor`, and `🔵 suggestion`");
    expect(prompt).toContain("Keep each narrative section to one concise blockquote paragraph");
    expect(prompt).toContain("**严重等级**：<severity-icon> <severity>");
    expect(prompt).not.toContain("<br>");
    expect(prompt).not.toContain("**置信度**");
    expect(prompt).not.toContain("**适用规则**");
    expect(prompt).not.toContain("**触发条件**");
    expect(prompt).not.toContain("**证据**");

    expectInOrder(prompt, [
      "For `PASS` and `DUPLICATE`",
      "For `NEW`",
      "### 【<severity>】<问题标题>",
      "**严重等级**：<severity-icon> <severity>",
      "**问题类型**：`<tag-1>`, `<tag-2>`",
      "**位置**：`path/to/file.ext` L<line-or-range>",
      "**问题描述**",
      "**影响**",
      "**修复建议**",
    ]);
  });
});
