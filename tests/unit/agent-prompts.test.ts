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
    if (file === "review-judge.md") {
      expect(prompt).toContain("`suggestion` = `🟢 Suggestion`");
    } else {
      expect(prompt).toContain("Never use `Blocker`, `Critical`, `Major`, or `Minor`");
    }
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
    expect(prompt).toContain("Follow exactly the template below");
    expect(prompt).not.toContain("## 检视结论：PASS");
    expect(prompt).not.toContain("## 检视结论：重复问题");
    expect(prompt).not.toContain("### 变更摘要");
    expect(prompt).not.toContain("### 判定依据");
    expect(prompt).not.toContain("| 项目 | 内容 |");
    expect(prompt).toContain("`fatal` = `🔴 Fatal`");
    expect(prompt).toContain("`major` = `🟠 Major`");
    expect(prompt).toContain("`minor` = `🟡 Minor`");
    expect(prompt).toContain("`suggestion` = `🟢 Suggestion`");
    expect(prompt).toContain("Every one of the three code blocks is required");
    expect(prompt).not.toContain("<br>");
    expect(prompt).not.toContain("**置信度**");
    expect(prompt).not.toContain("**适用规则**");
    expect(prompt).not.toContain("**证据**");

    expectInOrder(prompt, [
      "For `PASS` and `DUPLICATE`",
      "For `NEW`",
      "### <signal> <display-severity>: <问题标题>",
      "**问题描述**：",
      "- 严重级别：<display-severity>",
      "- 标签：`#<tag-1>` `#<tag-2>`",
      "- 简述：",
      "**问题位置**： `path/to/file.ext:<start-line>-<end-line>`",
      "**影响分析**：",
      "- **直接后果**：",
      "- **影响范围**：",
      "- **触发条件**：",
      "**解决方案**：",
      "**方案1（推荐）**：",
      "**方案2**：",
      "**预防措施**：",
    ]);
  });
});
