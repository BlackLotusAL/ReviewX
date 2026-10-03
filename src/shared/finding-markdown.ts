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
function bullet(label: string, text: string): string { return "- **" + label + "**：" + paragraph(text).replace(/\n/gu, "\n  "); }

const commentPrefixes: Record<string, string> = {
  c: "//", cpp: "//", csharp: "//", java: "//", kotlin: "//", go: "//", rust: "//", swift: "//", php: "//",
  javascript: "//", js: "//", jsx: "//", typescript: "//", ts: "//", tsx: "//",
  python: "#", py: "#", ruby: "#", bash: "#", sh: "#", powershell: "#", yaml: "#", yml: "#", toml: "#",
  sql: "--",
};
/** Decorations are presentation only; the host-extracted snippet is never mutated. */
function annotatedCode(location: ReviewLocation): CodeExample {
  const annotations = location.annotations ?? [];
  const label = (line: number, text: string) => `【检视注释·问题行 L${line}】${text.replace(/[\r\n\u2028\u2029]+/gu, " ")}`;
  if (!location.snippet) return { language: "text", code: ["源码未能读取；以下标注使用原始行号。", ...annotations.map(a => label(a.line, a.text))].join("\n") };
  const language = location.snippet.language.toLowerCase();
  const prefix = Object.hasOwn(commentPrefixes, language) ? commentPrefixes[language] : undefined;
  const lines = location.snippet.code.replace(/\r\n?/gu, "\n").split("\n");
  return { language: prefix ? location.snippet.language : "text", code: lines.flatMap((line, i) => {
    const indent = /^[\t ]*/u.exec(line)?.[0] ?? "";
    return [...annotations.filter(a => a.line === location.startLine + i).map(a => indent + (prefix ? prefix + " " : "") + label(a.line, a.text)), line];
  }).join("\n") };
}
function locationLines(location: ReviewLocation): string[] {
  const shownLines = location.snippet?.code.replace(/\r\n?/gu, "\n").split("\n").length ?? 0;
  const shownEnd = location.startLine + shownLines - 1;
  return [inline(location.path + ":" + location.startLine + "-" + location.endLine), "",
    ...(location.annotations?.length ? ["带检视标注的源码：", "", code(annotatedCode(location)), ""] : location.snippet ? [code(location.snippet), ""] : []),
    ...(location.snippet && shownEnd < location.endLine ? [`仅展示第 ${location.startLine}–${shownEnd} 行，其余源码已省略。`, ""] : [])];
}
function renderLocations(locations: ReviewLocation[]): string[] {
  // Legacy callers keep their original layout; persisted bodies are never regenerated.
  if (!locations.some(l => l.annotations?.length)) return locations.flatMap((l, i) => {
    const lines = locationLines(l); lines[0] = (i === 0 ? "**问题位置**：" : "") + lines[0] + (l.revision === "base" ? "（基线版本）" : ""); return lines;
  });
  const groups = new Map<string, ReviewLocation[]>();
  for (const location of locations) {
    const key = JSON.stringify([location.path, location.revision]);
    const group = groups.get(key); if (group) group.push(location); else groups.set(key, [location]);
  }
  if (locations.length === 1) {
    const lines = locationLines(locations[0]);
    lines[0] = "**问题位置**：" + lines[0] + (locations[0].revision === "base" ? "（基线版本）" : "（当前版本）"); return lines;
  }
  return ["**问题位置**：", "", ...[...groups.values()].flatMap((group, i) => {
    const marker = `${i + 1}. `, indent = " ".repeat(marker.length), first = group[0];
    return [marker + inline(first.path) + (first.revision === "base" ? "（基线版本）" : "（当前版本）"), "",
      ...group.flatMap(l => locationLines(l).flatMap(block => block.split("\n").map(line => line ? indent + line : line)))];
  })];
}
function renderSolutions(solutions: StructuredFinding["solutions"]): string[] {
  if (!solutions.every(s => s.kind && s.steps?.length)) return solutions.flatMap((s, i) => [solutions.length === 1 ? paragraph(s.description) : (i + 1) + ". " + paragraph(s.description).replace(/\n/gu, "\n   "), "", ...(s.example ? [code(s.example), ""] : [])]);
  const alternatives = solutions.filter(s => s.kind === "alternative").length;
  let alternate = 0;
  return solutions.flatMap(s => {
    const heading = s.kind === "recommended" ? "推荐方案" : "备用方案" + (alternatives > 1 ? " " + (++alternate) : "");
    return ["**" + heading + "**：" + paragraph(s.description), "", ...(s.applicability ? ["适用条件与取舍：" + paragraph(s.applicability), ""] : []),
      ...s.steps!.flatMap((step, i) => {
        const marker = `${i + 1}. `, indent = " ".repeat(marker.length);
        return [marker + (step.path ? inline(step.path) + "：" : "") + paragraph(step.description).replace(/\n/gu, "\n" + indent), "",
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
    ...renderLocations(f.locations),
    "**影响分析**：", "", bullet("直接后果", f.impact.direct), bullet("影响范围", f.impact.scope), bullet("触发条件", f.impact.trigger), "",
    "**解决方案**：", "", ...renderSolutions(f.solutions),
    "**预防措施**：", "", ...f.preventions.map(p => "- " + paragraph(p).replace(/\n/gu, "\n  ")),
  ].join("\n");
}
