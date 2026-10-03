import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { populateSourceSnippets } from "@/src/server/review/source-snippets";
import { renderFinding } from "@/src/shared/finding-markdown";
import { structuredFinding } from "../helpers/runtime";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "reviewx-snippets-")); roots.push(root);
  await mkdir(join(root, "source")); await mkdir(join(root, "base"));
  return root;
}

test("exact fixed revision source replaces model code and matches reported lines", async () => {
  const root = await workspace(), f = structuredFinding();
  await writeFile(join(root, "source", "delay.py"), "def delay(seconds):\r\n    return seconds\r\n");
  await writeFile(join(root, "base", "delay.py"), "def delay(seconds):\n    return seconds * 1000\n");
  f.locations = ["source", "base"].map(revision => ({ path: "delay.py", revision: revision as "source" | "base", startLine: 2, endLine: 2,
    annotations: [{ line: 2, text: revision === "source" ? "缺少换算。" : "基线保留了毫秒换算。" }], snippet: { language: "invented", code: "fake model code" } }));
  expect(await populateSourceSnippets(root, [f])).toEqual([]);
  expect(f.locations.map(l => l.snippet)).toEqual([
    { language: "python", code: "    return seconds" }, { language: "python", code: "    return seconds * 1000" },
  ]);
  expect(renderFinding(f)).not.toContain("fake model code");
  expect(renderFinding(f)).toContain("# 【检视注释·问题行 L2】缺少换算。\n       return seconds");
  expect(f.locations[0].snippet!.code).not.toContain("检视注释");
});

test("long ranges show forty real lines and put omission notes outside the fence", async () => {
  const root = await workspace(), f = structuredFinding();
  await writeFile(join(root, "source", "fixture.ts"), Array.from({ length: 70 }, (_, i) => `const x${i + 1} = ${i + 1};`).join("\n"));
  f.locations[0].startLine = 5; f.locations[0].endLine = 65;
  f.locations[0].annotations = [{ line: 5, text: "范围开头的问题。" }, { line: 44, text: "最后一个展示行的问题。" }];
  expect(await populateSourceSnippets(root, [f])).toEqual([]);
  const snippet = f.locations[0].snippet!;
  expect(snippet.language).toBe("typescript");
  expect(snippet.code.split("\n")).toHaveLength(40);
  expect(snippet.code).toMatch(/^const x5 = 5;/u); expect(snippet.code).toMatch(/const x44 = 44;$/u);
  expect(snippet.code).not.toContain("省略");
  expect(renderFinding(f)).toContain("// 【检视注释·问题行 L44】最后一个展示行的问题。\nconst x44 = 44;");
  expect(renderFinding(f)).toContain("const x44 = 44;\n```\n\n仅展示第 5–44 行，其余源码已省略。");
});

test("unreadable, binary, invalid UTF-8, empty and out-of-range files remove model snippets", async () => {
  const root = await workspace(), f = structuredFinding();
  await writeFile(join(root, "source", "one.ts"), "one\n");
  await writeFile(join(root, "source", "binary.ts"), "a\0b");
  await writeFile(join(root, "source", "invalid.ts"), Buffer.from([0xff]));
  await writeFile(join(root, "source", "empty.ts"), "");
  await writeFile(join(root, "source", "large.ts"), "a".repeat(64 * 1024 + 1));
  f.locations = ["missing.ts", "one.ts", "binary.ts", "invalid.ts", "empty.ts", "large.ts"].map(path => ({ path, revision: "source", startLine: path === "one.ts" ? 2 : 1, endLine: path === "one.ts" ? 2 : 1, snippet: { language: "ts", code: "invented" } }));
  expect(await populateSourceSnippets(root, [f])).toHaveLength(6);
  expect(f.locations.every(l => l.snippet === undefined)).toBe(true);
  expect(renderFinding(f)).toContain("`one.ts:2-2`");
  expect(renderFinding(f)).not.toContain("invented");
});

test("directory links cannot expose another revision or a neighboring directory", async () => {
  const root = await workspace(), f = structuredFinding();
  await mkdir(join(root, "source-other")); await writeFile(join(root, "source-other", "outside.ts"), "secret");
  await writeFile(join(root, "base", "outside.ts"), "base secret");
  await symlink(join(root, "source-other"), join(root, "source", "linked"), "junction");
  await symlink(join(root, "base"), join(root, "source", "other-revision"), "junction");
  await mkdir(join(root, "source", "real")); await writeFile(join(root, "source", "real", "outside.ts"), "inside");
  await symlink(join(root, "source", "real"), join(root, "source", "alias"), "junction");
  f.locations = ["linked/outside.ts", "other-revision/outside.ts", "../source-other/outside.ts", "alias/outside.ts"].map(path => ({ path, revision: "source", startLine: 1, endLine: 1 }));
  expect(await populateSourceSnippets(root, [f])).toHaveLength(4);
  expect(f.locations.every(l => l.snippet === undefined)).toBe(true);
});

test("unknown language preserves raw whitespace and backticks; cancellation propagates", async () => {
  const root = await workspace(), f = structuredFinding();
  await writeFile(join(root, "source", "fixture.custom"), "\ufeff  value = '```';\t\n");
  f.locations[0].path = "fixture.custom";
  expect(await populateSourceSnippets(root, [f])).toEqual([]);
  expect(f.locations[0].snippet).toEqual({ language: "text", code: "\ufeff  value = '```';\t" });
  expect(renderFinding(f)).toContain("````text\n\ufeff  value = '```';\t\n````");
  const controller = new AbortController(); controller.abort(new Error("stopped"));
  await expect(populateSourceSnippets(root, [f], controller.signal)).rejects.toThrow("stopped");
});
