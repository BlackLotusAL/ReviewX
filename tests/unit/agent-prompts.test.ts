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

describe("OpenCode agent prompts", () => {
  it.each(agentFiles)("keeps %s synchronized with the controlled tag schema", async (file) => {
    const prompt = await readFile(new URL(`../../opencode/agents/${file}`, import.meta.url), "utf8");

    expect(prompt).toContain(controlledTagInstruction);
    expect(prompt).toContain("use `architecture` instead of `layering`");
    expect(prompt).toContain("`compatibility` instead of `migration`");
  });
});
