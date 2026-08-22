import {
  judgeDecisionSchema,
  standardTags,
  type JudgeDecision,
  type JudgeReport,
  type Severity,
} from "./contracts.js";

const decisionPrefix = "<!-- reviewx-decision: ";
const decisionSuffix = " -->";
const decisionCandidatePattern =
  /<!--[ \t]*reviewx-decision[ \t]*:[ \t]*(\{[^\r\n]*\})[ \t]*-->/gmu;

export class JudgeDocumentError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "JudgeDocumentError";
  }
}

export function formatJudgeDecisionHeader(decision: JudgeDecision): string {
  return `${decisionPrefix}${JSON.stringify(decision)}${decisionSuffix}`;
}

const severityDisplays = {
  fatal: { signal: "🔴", label: "Fatal" },
  major: { signal: "🟠", label: "Major" },
  minor: { signal: "🟡", label: "Minor" },
  suggestion: { signal: "🟢", label: "Suggestion" },
} as const satisfies Record<Severity, { signal: string; label: string }>;

function requireExact(line: string | undefined, expected: string): void {
  if (line !== expected) {
    throw new JudgeDocumentError(`NEW Judge Markdown must contain ${expected} at the required position.`);
  }
}

function requireContent(line: string | undefined, prefix: string, field: string): void {
  if (line === undefined || !line.startsWith(prefix) || line.slice(prefix.length).trim() === "") {
    throw new JudgeDocumentError(`NEW Judge Markdown ${field} must be non-empty.`);
  }
}

function validateTags(line: string): void {
  const prefix = "- 标签：";
  if (!line.startsWith(prefix)) {
    throw new JudgeDocumentError("NEW Judge Markdown must place 标签 after 严重级别.");
  }
  const raw = line.slice(prefix.length);
  const tags = [...raw.matchAll(/`#([^`]+)`/gu)].map((match) => match[1]!);
  if (tags.length === 0 || tags.map((tag) => `\`#${tag}\``).join(" ") !== raw) {
    throw new JudgeDocumentError("NEW Judge Markdown 标签 must be space-separated backtick #tags.");
  }
  for (const tag of tags) {
    if (!standardTags.includes(tag as (typeof standardTags)[number]) && !/^domain:[a-z0-9][a-z0-9-]*$/u.test(tag)) {
      throw new JudgeDocumentError(`NEW Judge Markdown contains unsupported tag ${tag}.`);
    }
  }
}

function validateLocation(line: string): void {
  const match = /^\*\*问题位置\*\*： `([^`]+):(\d+)(?:-(\d+))?`$/u.exec(line);
  if (!match?.[1]) {
    throw new JudgeDocumentError("NEW Judge Markdown 问题位置 must use repository/relative/path:start-end.");
  }
  const file = match[1];
  if (file.startsWith("/") || /^[A-Za-z]:/u.test(file) || file.includes("\\") || file.split("/").includes("..")) {
    throw new JudgeDocumentError("NEW Judge Markdown 问题位置 path must be repository-relative.");
  }
  const start = Number(match[2]);
  const end = Number(match[3] ?? match[2]);
  if (start < 1 || end < start) {
    throw new JudgeDocumentError("NEW Judge Markdown 问题位置 line range is invalid.");
  }
}

function validateCodeBlock(lines: readonly string[], start: number, field: string): number {
  if (!/^```[A-Za-z0-9][A-Za-z0-9_+.#-]*$/u.test(lines[start] ?? "")) {
    throw new JudgeDocumentError(`NEW Judge Markdown ${field} must start with a language-tagged code fence.`);
  }
  const end = lines.indexOf("```", start + 1);
  if (end <= start + 1) {
    throw new JudgeDocumentError(`NEW Judge Markdown ${field} code fence must be non-empty and closed.`);
  }
  return end;
}

interface MarkdownLine {
  text: string;
  contentEnd: number;
}

function splitMarkdownLines(markdown: string): MarkdownLine[] {
  const records: MarkdownLine[] = [];
  let start = 0;
  while (true) {
    const newline = markdown.indexOf("\n", start);
    if (newline === -1) {
      records.push({ text: markdown.slice(start), contentEnd: markdown.length });
      break;
    }
    const contentEnd = newline > start && markdown[newline - 1] === "\r" ? newline - 1 : newline;
    records.push({ text: markdown.slice(start, contentEnd), contentEnd });
    start = newline + 1;
    if (start === markdown.length) {
      records.push({ text: "", contentEnd: start });
      break;
    }
  }
  if (records.length > 1 && records.at(-1)!.text === "") {
    records.pop();
  }
  return records;
}

function extractNewMarkdown(markdown: string, severity: Severity): string {
  const records = splitMarkdownLines(markdown);
  const lines = records.map((record) => record.text);
  const display = severityDisplays[severity];
  const titlePrefix = `### ${display.signal} ${display.label}: `;
  requireContent(lines[0], titlePrefix, "title");
  requireExact(lines[1], "");
  requireExact(lines[2], "**问题描述**：");
  requireExact(lines[3], "");
  requireExact(lines[4], `- 严重级别：${display.label}`);
  validateTags(lines[5] ?? "");
  requireContent(lines[6], "- 简述：", "简述");
  requireExact(lines[7], "");
  validateLocation(lines[8] ?? "");
  requireExact(lines[9], "");

  let cursor = validateCodeBlock(lines, 10, "问题位置") + 1;
  requireExact(lines[cursor++], "");
  requireExact(lines[cursor++], "**影响分析**：");
  requireExact(lines[cursor++], "");
  requireContent(lines[cursor++], "- **直接后果**：", "直接后果");
  requireContent(lines[cursor++], "- **影响范围**：", "影响范围");
  requireContent(lines[cursor++], "- **触发条件**：", "触发条件");
  requireExact(lines[cursor++], "");
  requireExact(lines[cursor++], "**解决方案**：");
  requireExact(lines[cursor++], "");
  requireContent(lines[cursor++], "**方案1（推荐）**：", "方案1");
  requireExact(lines[cursor++], "");

  cursor = validateCodeBlock(lines, cursor, "方案1") + 1;
  requireExact(lines[cursor++], "");
  requireContent(lines[cursor++], "**方案2**：", "方案2");
  requireExact(lines[cursor++], "");
  cursor = validateCodeBlock(lines, cursor, "方案2") + 1;
  requireExact(lines[cursor++], "");
  requireExact(lines[cursor++], "**预防措施**：");
  requireExact(lines[cursor++], "");

  const preventionStart = cursor;
  while (cursor < lines.length && lines[cursor]!.startsWith("- ")) {
    requireContent(lines[cursor], "- ", "预防措施");
    cursor += 1;
  }
  if (cursor === preventionStart) {
    throw new JudgeDocumentError("NEW Judge Markdown 预防措施 must contain at least one bullet.");
  }
  if (cursor === lines.length) {
    return markdown;
  }

  requireExact(lines[cursor], "");
  return markdown.slice(0, records[cursor - 1]!.contentEnd);
}

interface FieldMatch {
  index: number;
  value: string;
}

interface CodeBlockMatch {
  end: number;
  markdown: string;
}

function isSectionHeading(line: string, label: string): boolean {
  const value = line.trim();
  return [
    `**${label}**：`,
    `**${label}**:`,
    `**${label}**`,
    `${label}：`,
    `${label}:`,
    `### ${label}`,
  ].includes(value);
}

function findSectionHeading(
  lines: readonly string[],
  label: string,
  start: number,
): number {
  const index = lines.findIndex((line, candidate) =>
    candidate >= start && isSectionHeading(line, label)
  );
  if (index === -1) {
    throw new JudgeDocumentError(`NEW Judge Markdown must contain the ${label} section.`);
  }
  return index;
}

function parseFieldValue(line: string, label: string): string | undefined {
  const value = line.trim().replace(/^[-*+]\s+/u, "");
  for (const prefix of [
    `**${label}**：`,
    `**${label}**:`,
    `${label}：`,
    `${label}:`,
  ]) {
    if (value.startsWith(prefix)) return value.slice(prefix.length).trim();
  }
  return undefined;
}

function findRequiredField(
  lines: readonly string[],
  label: string,
  start: number,
  end: number,
): FieldMatch {
  for (let index = start; index < end; index += 1) {
    const value = parseFieldValue(lines[index] ?? "", label);
    if (value === undefined) continue;
    if (value === "") {
      throw new JudgeDocumentError(`NEW Judge Markdown ${label} must be non-empty.`);
    }
    return { index, value };
  }
  throw new JudgeDocumentError(`NEW Judge Markdown must contain the ${label} field.`);
}

function findCodeBlock(
  lines: readonly string[],
  start: number,
  end: number,
  field: string,
): CodeBlockMatch {
  for (let index = start; index < end; index += 1) {
    if (!/^```[A-Za-z0-9][A-Za-z0-9_+.#-]*$/u.test(lines[index] ?? "")) continue;
    const close = lines.indexOf("```", index + 1);
    if (close <= index + 1 || close >= end) {
      throw new JudgeDocumentError(
        `NEW Judge Markdown ${field} code fence must be non-empty and closed within its section.`,
      );
    }
    return {
      end: close,
      markdown: lines.slice(index, close + 1).join("\n"),
    };
  }
  throw new JudgeDocumentError(
    `NEW Judge Markdown ${field} must contain a language-tagged code fence.`,
  );
}

function normalizeLocation(value: string): string {
  const trimmed = value.trim();
  const backticked = /^`([^`]+)`$/u.exec(trimmed)?.[1];
  const location = backticked ?? trimmed;
  validateLocation(`**问题位置**： \`${location}\``);
  return location;
}

function normalizeTags(value: string): string[] {
  const tags = [...value.matchAll(/#([^`\s,，]+)/gu)]
    .map((match) => match[1]!);
  const unique = [...new Set(tags)];
  validateTags(`- 标签：${unique.map((tag) => `\`#${tag}\``).join(" ")}`);
  return unique;
}

function normalizeSeverity(value: string, severity: Severity): void {
  const normalized = value.replace(/[`*_]/gu, "").trim().toLowerCase();
  if (normalized !== severity) {
    throw new JudgeDocumentError(
      `NEW Judge Markdown severity field ${JSON.stringify(value)} does not match ${severity}.`,
    );
  }
}

function collectPreventionItems(lines: readonly string[], start: number): string[] {
  const items: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "") {
      if (items.length > 0) break;
      continue;
    }
    const match = /^(?:[-*+]|\d+[.)])\s+(.+)$/u.exec(line);
    if (!match?.[1]) {
      if (items.length > 0) break;
      continue;
    }
    items.push(match[1].trim());
  }
  if (items.length === 0) {
    throw new JudgeDocumentError("NEW Judge Markdown 预防措施 must contain at least one list item.");
  }
  return items;
}

function extractCanonicalNewMarkdown(markdown: string, severity: Severity): string {
  const lines = splitMarkdownLines(markdown).map((record) => record.text);
  const display = severityDisplays[severity];
  const titlePrefix = `### ${display.signal} ${display.label}: `;
  requireContent(lines[0], titlePrefix, "title");
  const title = `${titlePrefix}${lines[0]!.slice(titlePrefix.length).trim()}`;

  const problem = findSectionHeading(lines, "问题描述", 1);
  const impact = findSectionHeading(lines, "影响分析", problem + 1);
  const solutions = findSectionHeading(lines, "解决方案", impact + 1);
  const prevention = findSectionHeading(lines, "预防措施", solutions + 1);
  const location = findRequiredField(lines, "问题位置", problem + 1, impact);

  const severityField = findRequiredField(lines, "严重级别", problem + 1, location.index);
  normalizeSeverity(severityField.value, severity);
  const tags = normalizeTags(
    findRequiredField(lines, "标签", severityField.index + 1, location.index).value,
  );
  const summary = findRequiredField(lines, "简述", severityField.index + 1, location.index).value;
  const normalizedLocation = normalizeLocation(location.value);
  const locationCode = findCodeBlock(lines, location.index + 1, impact, "问题位置");

  const directImpact = findRequiredField(lines, "直接后果", impact + 1, solutions).value;
  const impactScope = findRequiredField(lines, "影响范围", impact + 1, solutions).value;
  const trigger = findRequiredField(lines, "触发条件", impact + 1, solutions).value;

  const preferred = findRequiredField(lines, "方案1（推荐）", solutions + 1, prevention);
  const alternative = findRequiredField(lines, "方案2", preferred.index + 1, prevention);
  const preferredCode = findCodeBlock(lines, preferred.index + 1, alternative.index, "方案1");
  const alternativeCode = findCodeBlock(lines, alternative.index + 1, prevention, "方案2");
  const preventionItems = collectPreventionItems(lines, prevention + 1);

  return [
    title,
    "",
    "**问题描述**：",
    "",
    `- 严重级别：${display.label}`,
    `- 标签：${tags.map((tag) => `\`#${tag}\``).join(" ")}`,
    `- 简述：${summary}`,
    "",
    `**问题位置**： \`${normalizedLocation}\``,
    "",
    locationCode.markdown,
    "",
    "**影响分析**：",
    "",
    `- **直接后果**：${directImpact}`,
    `- **影响范围**：${impactScope}`,
    `- **触发条件**：${trigger}`,
    "",
    "**解决方案**：",
    "",
    `**方案1（推荐）**：${preferred.value}`,
    "",
    preferredCode.markdown,
    "",
    `**方案2**：${alternative.value}`,
    "",
    alternativeCode.markdown,
    "",
    "**预防措施**：",
    "",
    ...preventionItems.map((item) => `- ${item}`),
  ].join("\n");
}

function extractNewMarkdownFromRegion(region: string, severity: Severity): string {
  const display = severityDisplays[severity];
  const titlePattern = new RegExp(`^### ${display.signal} ${display.label}: `, "gmu");
  let extracted: string | undefined;
  let lastError: JudgeDocumentError | undefined;

  for (const title of region.matchAll(titlePattern)) {
    try {
      extracted = extractNewMarkdown(region.slice(title.index), severity);
    } catch (error) {
      if (!(error instanceof JudgeDocumentError)) throw error;
      try {
        extracted = extractCanonicalNewMarkdown(region.slice(title.index), severity);
      } catch (fallbackError) {
        if (!(fallbackError instanceof JudgeDocumentError)) throw fallbackError;
        lastError = new JudgeDocumentError(
          `${error.message} Semantic extraction also failed: ${fallbackError.message}`,
          { cause: fallbackError },
        );
      }
    }
  }

  if (extracted !== undefined) return extracted;
  if (lastError !== undefined) {
    throw new JudgeDocumentError(lastError.message, { cause: lastError });
  }
  throw new JudgeDocumentError(
    `NEW Judge Markdown must contain a ${display.signal} ${display.label} title after its decision header.`,
  );
}

interface DecisionCandidate {
  encoded: string;
  start: number;
  end: number;
}

function findDecisionCandidates(document: string): DecisionCandidate[] {
  return [...document.matchAll(decisionCandidatePattern)].map((match) => ({
    encoded: match[1]!,
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function parseJudgeDocument(document: string): JudgeReport {
  const normalized = document.replace(/^\uFEFF/u, "");
  const candidates = findDecisionCandidates(normalized);
  if (candidates.length === 0) {
    throw new JudgeDocumentError(
      "Judge document does not contain a reviewx-decision HTML comment candidate.",
    );
  }

  let selected: JudgeReport | undefined;
  let invalidJson = 0;
  let invalidProtocol = 0;
  let invalidNewBody = 0;
  let lastFailure: JudgeDocumentError | undefined;

  for (const [index, candidate] of candidates.entries()) {
    let rawDecision: unknown;
    try {
      rawDecision = JSON.parse(candidate.encoded);
    } catch (error) {
      invalidJson += 1;
      lastFailure = new JudgeDocumentError(
        "Judge reviewx-decision header candidate is not valid JSON.",
        { cause: error },
      );
      continue;
    }

    const parsed = judgeDecisionSchema.safeParse(rawDecision);
    if (!parsed.success) {
      invalidProtocol += 1;
      lastFailure = new JudgeDocumentError(
        "Judge reviewx-decision header candidate does not match the protocol.",
        { cause: parsed.error },
      );
      continue;
    }

    const canonicalHeader = formatJudgeDecisionHeader(parsed.data);
    if (parsed.data.verdict !== "NEW") {
      selected = {
        decision: parsed.data,
        markdown: "",
        document: canonicalHeader,
      };
      continue;
    }

    const bodyEnd = candidates[index + 1]?.start ?? normalized.length;
    const bodyRegion = normalized.slice(candidate.end, bodyEnd);
    try {
      const markdown = extractNewMarkdownFromRegion(bodyRegion, parsed.data.severity);
      selected = {
        decision: parsed.data,
        markdown,
        document: `${canonicalHeader}\n\n${markdown}`,
      };
    } catch (error) {
      if (!(error instanceof JudgeDocumentError)) throw error;
      invalidNewBody += 1;
      lastFailure = error;
    }
  }

  if (selected !== undefined) return selected;

  const summary = [
    `${candidates.length} candidate(s)`,
    `${invalidJson} invalid JSON`,
    `${invalidProtocol} protocol-invalid`,
    `${invalidNewBody} NEW-body-invalid`,
  ].join(", ");
  throw new JudgeDocumentError(
    `Judge document contains no extractable valid reviewx-decision decision/report pair (${summary}).${lastFailure === undefined ? "" : ` Last candidate error: ${lastFailure.message}`}`,
    { cause: lastFailure },
  );
}
