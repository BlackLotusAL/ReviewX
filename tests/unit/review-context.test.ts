import { describe, expect, test } from "vitest";
import { changedLineIndex, isInstructionPath, isReviewPath } from "@/src/server/review-context";

describe("review evidence indexing", () => {
  test("indexes real changed lines, distinguishes removed/source lines and decodes quoted UTF-8 paths", () => {
    const index = changedLineIndex('diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -3,3 +3,4 @@\n same\n-old\n+new\n+extra\n tail\ndiff --git a/x b/x\n--- /dev/null\n+++ "b/\\344\\270\\255.ts"\n@@ -0,0 +1 @@\n+new file\n');
    expect(index.get("base:old.ts")).toEqual([{ start: 4, end: 4 }]);
    expect(index.get("source:new.ts")).toEqual([{ start: 4, end: 5 }]);
    expect(index.get("source:中.ts")).toEqual([{ start: 1, end: 1 }]);
    expect(index.has("base:dev/null")).toBe(false);
  });
  test("rejects traversal, alternate data streams, Windows separators and agent configuration", () => {
    for (const path of ["../a", "/a", "C:/a", "a\\b", "a:secret", "a/../b", "a//b", "a. /b", "a\0b"]) expect(isReviewPath(path)).toBe(false);
    expect(isReviewPath("src/中文 file.ts")).toBe(true);
    for (const path of [".git/config", "src/AGENTS.md", "a/.opencode/tool.ts", "CLAUDE.md", "opencode.jsonc", "skills/demo/SKILL.md"]) expect(isInstructionPath(path)).toBe(true);
    expect(isInstructionPath("src/ordinary.ts")).toBe(false);
  });
});
