import { findingLocationGroups } from "./finding-locations";
import type { CodeExample, ReviewLocation, StructuredFinding } from "./review-contract";

const levels = { fatal: ["🔴", "Fatal"], major: ["🟠", "Major"], minor: ["🟡", "Minor"], suggestion: ["🟢", "Suggestion"] } as const;
const tick = String.fromCharCode(96);
const escape = (text: string) => text.replace(/\r\n?/gu, "\n").replace(/[\\`*_{}\[\]()<>#+.!|~\-]/gu, "\\$&");
const longest = (text: string) => Math.max(0, ...(text.match(new RegExp(tick + "+", "gu")) ?? []).map(s => s.length));
const inline = (text: string) => {
  const value = text.replace(/[\r\n]/gu, " "), fence = tick.repeat(longest(value) + 1);
  const padding = value.startsWith(tick) || value.endsWith(tick) || (/^ .* $/u.test(value) && value.trim()) ? " " : "";
  return fence + padding + value + padding + fence;
};
function code(example: CodeExample): string {
  const fence = tick.repeat(Math.max(3, longest(example.code) + 1));
  const language = example.language.replace(/[^a-zA-Z0-9_+#.-]/gu, "");
  return fence + language + "\n" + example.code.replace(/\r\n?/gu, "\n") + "\n" + fence;
}
export function paragraph(text: string): string { return escape(text).split("\n").join("  \n"); }
/** Only paired, single-line code spans are formatting; everything else remains escaped data. */
function prose(text: string): string {
  const runs = [...text.matchAll(/`+/gu)];
  let offset = 0, result = "";
  for (let i = 0; i < runs.length; i++) {
    const opening = runs[i];
    let closing = i + 1;
    while (closing < runs.length && runs[closing][0].length !== opening[0].length) closing++;
    if (closing === runs.length) continue;
    const end = runs[closing], value = text.slice(opening.index! + opening[0].length, end.index);
    if (!value.trim() || /[\r\n]/u.test(value)) continue;
    result += paragraph(text.slice(offset, opening.index)) + inline(value);
    offset = end.index! + end[0].length; i = closing;
  }
  return result + paragraph(text.slice(offset));
}
function bullet(label: string, text: string): string { return "- **" + label + "**：" + prose(text).replace(/\n/gu, "\n  "); }

function renderLocations(locations: ReviewLocation[], level: "error" | "warning"): string[] {
  const groups = findingLocationGroups(locations, level);
  return [...(groups.length > 1 ? ["**问题位置**：", ""] : []), ...groups.flatMap((group, i) => {
    const marker = groups.length === 1 ? "**问题位置**：" : (i + 1) + ". ";
    const indent = groups.length === 1 ? "" : " ".repeat(marker.length);
    return [marker + inline(group.path) + (group.revision === "base" ? "（基线版本）" : ""), "",
      ...group.blocks.flatMap(block => [code(block).split("\n").map(line => indent + line).join("\n"), ""]),
      ...group.notes.flatMap(note => [indent + paragraph(note), ""])];
  })];
}
function renderSolutions(solutions: StructuredFinding["solutions"]): string[] {
  if (!solutions.every(s => s.kind && s.steps?.length)) return solutions.flatMap((s, i) => [solutions.length === 1 ? paragraph(s.description) : (i + 1) + ". " + paragraph(s.description).replace(/\n/gu, "\n   "), "", ...(s.example ? [code(s.example), ""] : [])]);
  const alternatives = solutions.filter(s => s.kind === "alternative").length;
  let alternate = 0;
  return solutions.flatMap(s => {
    const heading = s.kind === "recommended" ? "推荐方案" : "备用方案" + (alternatives > 1 ? " " + (++alternate) : "");
    const multiple = s.steps!.length > 1;
    return [...(alternatives ? ["**" + heading + "**：" + prose(s.description), ""] : multiple ? [prose(s.description), ""] : []),
      ...(s.applicability ? ["适用条件与取舍：" + prose(s.applicability), ""] : []),
      ...s.steps!.flatMap((step, i) => {
        const marker = multiple ? (i + 1) + ". " : "", indent = " ".repeat(marker.length);
        return [marker + (step.path ? inline(step.path) + "：" : "") + prose(step.description).replace(/\n/gu, "\n" + indent), "",
          ...(step.example ? [code(step.example).split("\n").map(line => indent + line).join("\n"), ""] : [])];
      })];
  });
}

/** The same immutable body is displayed, saved and sent. Models never compose Markdown. */
export function renderFinding(f: StructuredFinding): string {
  const [icon, level] = levels[f.severity];
  return [
    "### " + icon + " " + level + ": " + escape(f.title.replace(/[\r\n]+/gu, " ")), "",
    "**问题描述**：", "", "- 严重级别：" + level,
    "- 标签：" + (f.tags.length ? f.tags.map(t => inline("#" + t.replace(/^#+/u, ""))).join(" ") : "无"),
    "- 简述：" + paragraph(f.description), "",
    ...renderLocations(f.locations, f.severity === "fatal" || f.severity === "major" ? "error" : "warning"),
    "**影响分析**：", "", bullet("直接后果", f.impact.direct), bullet("影响范围", f.impact.scope), bullet("触发条件", f.impact.trigger), "",
    "**解决方案**：", "", ...renderSolutions(f.solutions),
    "**预防措施**：", "", ...f.preventions.map(p => "- " + paragraph(p).replace(/\n/gu, "\n  ")),
  ].join("\n");
}
