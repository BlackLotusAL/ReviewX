import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const expertFiles = [
  "design-reviewer.md",
  "business-reviewer.md",
  "code-reviewer.md",
] as const;

async function prompt(file: string): Promise<string> {
  return await readFile(new URL(`../../opencode/agents/${file}`, import.meta.url), "utf8");
}

describe("OpenCode agent prompts", () => {
  it.each(expertFiles)("keeps %s evidence-focused but output-format free", async (file) => {
    const value = await prompt(file);

    expect(value).toContain("final aggregate change");
    expect(value).toContain("Return one free-form Markdown report");
    expect(value).toContain("there are no required fields, tags, severity vocabulary");
    expect(value).toContain("Never edit");
    expect(value).not.toContain("Allowed standard tags");
    expect(value).not.toContain("Use only CodeHub's exact lowercase severity values");
    expect(value).not.toContain("confidence from 0 to 100");
  });

  it("keeps only the Judge machine protocol and a free Markdown body", async () => {
    const value = await prompt("review-judge.md");

    expect(value).toContain('<!-- reviewx-decision: {"verdict":"PASS"} -->');
    expect(value).toContain('<!-- reviewx-decision: {"verdict":"NEW","severity":"minor"} -->');
    expect(value).toContain("non-empty free-form Markdown comment");
    expect(value).toContain("no required language, heading, field, tag, severity display");
    expect(value).toContain("control header is the only source of the verdict and severity");
    expect(value).toContain("`fatal`, `major`, `minor`, or `suggestion`");
    expect(value).not.toContain("Follow exactly the template below");
    expect(value).not.toContain("Allowed standard tags");
    expect(value).not.toContain("Every one of the three code blocks is required");
    expect(value).not.toContain("### <signal> <display-severity>");
    expect(value).not.toContain("**问题描述**：");
  });
});
