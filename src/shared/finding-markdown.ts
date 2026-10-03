import type { CodeExample, StructuredFinding } from "./review-contract";

const levels = { fatal: ["🔴", "Fatal"], major: ["🟠", "Major"], minor: ["🟡", "Minor"], suggestion: ["🟢", "Suggestion"] } as const;
const tick = String.fromCharCode(96);
const escape = (text: string) => text.replace(/\r\n?/gu, "\n").replace(/[\\`*_{}\[\]()<>#+.!|~\-]/gu, "\\$&");
const longest = (text: string) => Math.max(0, ...(text.match(new RegExp(tick + "+", "gu")) ?? []).map(s => s.length));
const inline = (text: string) => { const fence = tick.repeat(longest(text) + 1); return fence + " " + text.replace(/[\r\n]/gu, " ") + " " + fence; };
function code(example: CodeExample): string {
  const fence = tick.repeat(Math.max(3, longest(example.code) + 1));
  const language = example.language.replace(/[^a-zA-Z0-9_+#.-]/gu, "");
  return fence + language + "\n" + example.code.replace(/\r\n?/gu, "\n") + "\n" + fence;
}
export function paragraph(text: string): string { return escape(text).split("\n").join("  \n"); }
function bullet(label: string, text: string): string { return "- **" + label + "**：" + paragraph(text).replace(/\n/gu, "\n  "); }

/** The same immutable body is displayed, saved and sent. Models never compose Markdown. */
export function renderFinding(f: StructuredFinding): string {
  const [icon, level] = levels[f.severity];
  return [
    "### " + icon + " " + level + ": " + escape(f.title.replace(/[\r\n]+/gu, " ")), "",
    "**问题描述**：", "", "- 严重级别：" + level,
    "- 标签：" + (f.tags.length ? f.tags.map(t => inline("#" + t.replace(/^#+/u, ""))).join(" ") : "无"),
    bullet("简述", f.description), "", "**问题位置**：", "",
    ...f.locations.flatMap(l => [inline(l.path + ":" + l.startLine + "-" + l.endLine) + "（" + l.revision + "）", "", ...(l.snippet ? [code(l.snippet), ""] : [])]),
    "**影响分析**：", "", bullet("直接后果", f.impact.direct), bullet("影响范围", f.impact.scope), bullet("触发条件", f.impact.trigger), "",
    "**解决方案**：", "", ...f.solutions.flatMap((s, i) => [(i + 1) + ". " + paragraph(s.description).replace(/\n/gu, "\n   "), "", ...(s.example ? [code(s.example), ""] : [])]),
    "**预防措施**：", "", ...f.preventions.map(p => "- " + paragraph(p).replace(/\n/gu, "\n  ")),
  ].join("\n");
}
