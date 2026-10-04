// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Markdown } from "@/app/components/markdown";
import { renderFinding } from "@/src/shared/finding-markdown";
import { generatedFinding } from "../helpers/runtime";

afterEach(cleanup);

test("impact and repair prose allow only inline code while escaping active markup and formatting", () => {
  const finding = generatedFinding();
  finding.impact.direct = "导入 `FitReq` 失败，``x`y`` 保留反引号。<script>alert(1)</script> **bold** [link](https://example.com)";
  finding.solutions[0].steps = [{ path: "api.py", description: "将 `WrongReq` 改为 `Req`。未闭合 ` <img src=x onerror=alert(1)>" }];
  const view = render(<Markdown>{renderFinding(finding)}</Markdown>);
  const inline = [...view.container.querySelectorAll("code")].filter(code => !code.closest("pre"));
  expect(inline.map(code => code.textContent)).toEqual(expect.arrayContaining(["FitReq", "x`y", "WrongReq", "Req"]));
  expect(view.container.querySelector("script, img, a, [onerror]")).toBeNull();
  expect(view.container.textContent).toContain("**bold**");
  expect(view.container.textContent).toContain("未闭合 `");
});

test("annotated file groups and solution steps remain readable nested Markdown blocks", () => {
  const finding = generatedFinding();
  finding.locations = [{ path: "delay.py", revision: "source", startLine: 2, endLine: 2,
    snippet: { language: "python", code: "    return seconds" }, annotations: [{ line: 2, text: "缺少换算，包含 ``` 和 <script>。" }] },
  { path: "data.json", revision: "source", startLine: 1, endLine: 1,
    snippet: { language: "json", code: '{"delay": 0}' }, annotations: [{ line: 1, text: "延迟值错误。" }] }];
  finding.solutions[0].steps = [{ description: "恢复换算。", path: "delay.py", example: { language: "python", code: "def delay(seconds):\n    return seconds * 1000" } }];
  finding.solutions.push({ kind: "alternative", description: "迁移调用契约。", applicability: "全部调用方可同步迁移时适用。", steps: [{ description: "同步修改调用方。" }] });
  const view = render(<Markdown>{renderFinding(finding)}</Markdown>);
  const blocks = view.container.querySelectorAll("pre code");
  expect(blocks).toHaveLength(3);
  expect(blocks[0].textContent).toBe("    return seconds  # 缺少换算，包含 ``` 和 <script>。\n");
  expect(blocks[0].querySelector(".hljs-comment")).not.toBeNull();
  expect(blocks[1].textContent).toBe('{"delay": 0}  // 延迟值错误。\n');
  expect(blocks[1].querySelector("span")).toBeNull();
  expect(blocks[2].textContent).toBe("def delay(seconds):\n    return seconds * 1000\n");
  expect(blocks[0].closest("li")).not.toBeNull();
  expect(blocks[1].closest("li")).not.toBeNull();
  expect(blocks[2].closest("li")).toBeNull();
  expect(view.container.querySelector("script")).toBeNull();
  expect(view.container.textContent).toContain("推荐方案"); expect(view.container.textContent).toContain("备用方案");
});

test("highlights labeled TypeScript while preserving code, whitespace and literal HTML", () => {
  const source = '// Keep this comment\nfunction check(value: number) {\n  if (value === 42) return "<script>alert(1)</script>";\n}\n';
  const view = render(<Markdown>{`\`\`\`ts\n${source}\`\`\``}</Markdown>);
  const code = view.container.querySelector("pre code")!;
  expect(code.textContent).toBe(source);
  for (const token of ["keyword", "string", "number", "comment", "title"]) expect(code.querySelector(`.hljs-${token}`)).not.toBeNull();
  expect(view.container.querySelector("script")).toBeNull();
});

test.each(["", "unknown-reviewx-language", "text", "txt", "plaintext"])("keeps %s blocks as plain text", language => {
  const source = 'if (value < 10) {\n  return "<b>literal</b>";\n}\n';
  const view = render(<Markdown>{`\`\`\`${language}\n${source}\`\`\``}</Markdown>);
  const code = view.container.querySelector("pre code")!;
  expect(code.textContent).toBe(source);
  expect(code.querySelector("span")).toBeNull();
  expect(code.querySelector("b")).toBeNull();
});

test("continues to drop unsafe HTML and URLs and never loads Markdown images", () => {
  const view = render(<Markdown>{[
    '<script>alert(1)</script>', '<iframe src="https://evil.example"></iframe>',
    '<span class="hljs-keyword" onclick="alert(1)">unsafe HTML</span>',
    '[danger](javascript:alert(1))', '[local](file:///C:/secret)',
    '![image](https://example.com/image.png)',
    '| Name | Value |', '| --- | --- |', '| safe | **text** |',
  ].join('\n\n')}</Markdown>);
  expect(view.container.querySelector("script, iframe, img, [onclick]")).toBeNull();
  expect(view.container.querySelector('a[href^="javascript:"], a[href^="file:"]')).toBeNull();
  expect(view.container.querySelector(".image-link")?.getAttribute("href")).toBe("https://example.com/image.png");
});
