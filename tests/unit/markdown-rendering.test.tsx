// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Markdown } from "@/app/components/markdown";

afterEach(cleanup);

test("highlights labeled TypeScript while preserving code, whitespace and literal HTML", () => {
  const source = '// Keep this comment\nfunction check(value: number) {\n  if (value === 42) return "<script>alert(1)</script>";\n}\n';
  const view = render(<Markdown>{`\`\`\`ts\n${source}\`\`\``}</Markdown>);
  const code = view.container.querySelector("pre code")!;
  expect(code.textContent).toBe(source);
  for (const token of ["keyword", "string", "number", "comment", "title"]) expect(code.querySelector(`.hljs-${token}`)).not.toBeNull();
  expect(view.container.querySelector("script")).toBeNull();
  const token = code.querySelector(".hljs-keyword");
  view.rerender(<Markdown>{`\`\`\`ts\n${source}\`\`\``}</Markdown>);
  expect(view.container.querySelector(".hljs-keyword")).toBe(token);
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
