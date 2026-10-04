import type { CodeExample, ReviewHighlight, ReviewLocation } from "./review-contract";
import { SOURCE_SNIPPET_LINE_LIMIT } from "./review-output-policy";

const prefixes: Record<string, string> = {
  c: "//", cpp: "//", csharp: "//", java: "//", kotlin: "//", go: "//", rust: "//", swift: "//", php: "//",
  javascript: "//", js: "//", jsx: "//", typescript: "//", ts: "//", tsx: "//",
  python: "#", py: "#", ruby: "#", bash: "#", sh: "#", powershell: "#", yaml: "#", yml: "#", toml: "#", sql: "--",
};
const singleLine = (text: string) => text.replace(/[\r\n\u2028\u2029]+/gu, " ");
const rangeText = ({ startLine, endLine }: ReviewHighlight) => startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
function merge(ranges: ReviewHighlight[], adjacent = false): ReviewHighlight[] {
  const result: ReviewHighlight[] = [];
  for (const range of ranges.map(r => ({ ...r })).sort((a, b) => a.startLine - b.startLine)) {
    const previous = result.at(-1);
    if (previous && range.startLine <= previous.endLine + Number(adjacent)) previous.endLine = Math.max(previous.endLine, range.endLine);
    else result.push(range);
  }
  return result;
}
interface Row { number: number; source: string; explanations: Set<string>; labels: Set<string> }
interface LocationGroup { path: string; revision: ReviewLocation["revision"]; blocks: CodeExample[]; notes: string[] }

/** A display projection only: never change the host's original snippets or line numbers. */
function projectGroup(locations: ReviewLocation[], level: "error" | "warning"): LocationGroup {
  const rows = new Map<number, Row>(), highlights: ReviewHighlight[] = [], blocks: CodeExample[] = [], notes: string[] = [];
  const languages = new Set(locations.flatMap(l => l.snippet ? [l.snippet.language.toLowerCase()] : []));
  const language = languages.size === 1 ? [...languages][0] : "text";
  const nativePrefix = Object.hasOwn(prefixes, language) ? prefixes[language] : undefined;
  const prefix = nativePrefix ?? "//";
  for (const location of locations) {
    if (!location.snippet) continue;
    const source = location.snippet.code.replace(/\r\n?/gu, "\n").split("\n").slice(0, SOURCE_SNIPPET_LINE_LIMIT);
    const end = Math.min(location.endLine, location.startLine + source.length - 1);
    source.forEach((line, i) => {
      const number = location.startLine + i;
      if (number > end) return;
      const row = rows.get(number) ?? { number, source: line, explanations: new Set<string>(), labels: new Set<string>() };
      for (const annotation of location.annotations ?? []) if (annotation.line === number) row.explanations.add(singleLine(annotation.text));
      if (i === 0 && location.label) row.labels.add(singleLine(location.label));
      rows.set(number, row);
    });
    highlights.push(...(location.highlights ?? []).filter(h => h.startLine >= location.startLine && h.endLine >= h.startLine && h.endLine <= end));
    if (end < location.endLine) notes.push(`仅展示第 ${location.startLine}–${end} 行，其余源码已省略。`);
  }
  const ordered = [...rows.values()].sort((a, b) => a.number - b.number), ranges = merge(highlights);
  let previous: number | undefined;
  for (let offset = 0; offset < ordered.length; offset += SOURCE_SNIPPET_LINE_LIMIT) {
    const page = ordered.slice(offset, offset + SOURCE_SNIPPET_LINE_LIMIT), output: string[] = [];
    for (let start = 0; start < page.length;) {
      let end = start;
      while (end + 1 < page.length && page[end + 1].number === page[end].number + 1 && !page[end + 1].labels.size) end++;
      const first = page[start], last = page[end];
      if (previous !== undefined && first.number > previous + 1) output.push(`${prefix} … 省略原始 L${previous + 1}–${first.number - 1} …`);
      if (first.labels.size || locations.length > 1 || ordered.length > SOURCE_SNIPPET_LINE_LIMIT) {
        output.push(`${prefix} ${[...first.labels].join("；")}${first.labels.size ? " " : ""}L${rangeText({ startLine: first.number, endLine: last.number })}`);
      }
      // Clip to this continuous segment and page: notation never spans a gap or an inserted context comment.
      const clipped = ranges.filter(h => h.startLine <= last.number && h.endLine >= first.number)
        .map(h => ({ startLine: Math.max(h.startLine, first.number), endLine: Math.min(h.endLine, last.number) }));
      for (let i = start; i <= end; i++) {
        const row = page[i], range = clipped.find(h => h.startLine === row.number);
        const marker = range ? `[!code ${level}:${range.endLine - range.startLine + 1}]` : "";
        const suffix = [...row.explanations, marker].filter(Boolean).join(" ");
        output.push(row.source + (suffix ? `  ${prefix} ${suffix}` : ""));
      }
      previous = last.number; start = end + 1;
    }
    blocks.push({ language: nativePrefix ? language : "text", code: output.join("\n") });
  }
  for (const location of locations.filter(l => !l.snippet)) {
    if (!location.annotations?.length && !location.highlights?.length && !location.label) continue;
    blocks.push({ language: "text", code: [
      `源码未能读取：L${rangeText(location)}${location.label ? "（" + singleLine(location.label) + "）" : ""}；以下范围和说明使用原始行号。`,
      ...(location.highlights ?? []).map(h => `问题范围：L${h.startLine}–L${h.endLine}`),
      ...(location.annotations ?? []).map(a => `L${a.line}：${singleLine(a.text)}`),
    ].join("\n") });
  }
  return { path: locations[0].path + ":" + merge(locations, true).map(rangeText).join(","), revision: locations[0].revision, blocks, notes: [...new Set(notes)] };
}

export function findingLocationGroups(locations: ReviewLocation[], level: "error" | "warning"): LocationGroup[] {
  const groups = new Map<string, ReviewLocation[]>();
  for (const location of locations) {
    const key = JSON.stringify([location.path, location.revision]);
    const group = groups.get(key); if (group) group.push(location); else groups.set(key, [location]);
  }
  return [...groups.values()].map(group => projectGroup(group, level));
}
