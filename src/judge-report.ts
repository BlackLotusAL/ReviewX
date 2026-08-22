import {
  judgeDecisionSchema,
  standardTags,
  type JudgeDecision,
  type JudgeReport,
  type Severity,
} from "./contracts.js";

const decisionPrefix = "<!-- reviewx-decision: ";
const decisionSuffix = " -->";

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

function validateNewMarkdown(markdown: string, severity: Severity): void {
  const normalized = markdown.replace(/\r\n/gu, "\n").replace(/\n$/u, "");
  const lines = normalized.split("\n");
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

  if (cursor >= lines.length) {
    throw new JudgeDocumentError("NEW Judge Markdown 预防措施 must contain at least one bullet.");
  }
  for (; cursor < lines.length; cursor += 1) {
    requireContent(lines[cursor], "- ", "预防措施");
  }
}

export function parseJudgeDocument(document: string): JudgeReport {
  const normalized = document.replace(/^\uFEFF/u, "");
  const matches = [...normalized.matchAll(
    /^<!-- reviewx-decision: (\{[^\r\n]*\}) -->[ \t]*\r?$/gmu,
  )];
  if (matches.length !== 1) {
    throw new JudgeDocumentError(
      "Judge document must contain exactly one standalone reviewx-decision HTML comment.",
    );
  }

  const match = matches[0]!;
  const headerStart = match.index;
  const prefix = normalized.slice(0, headerStart);
  const previousLine = prefix.trimEnd().split(/\r?\n/u).at(-1) ?? "";
  if (/^[ \t]*(`{3,}|~{3,})/u.test(previousLine)) {
    throw new JudgeDocumentError("Judge reviewx-decision header must not be fenced.");
  }

  const encoded = match[1]!;
  let rawDecision: unknown;
  try {
    rawDecision = JSON.parse(encoded);
  } catch (error) {
    throw new JudgeDocumentError("Judge reviewx-decision header is not valid JSON.", {
      cause: error,
    });
  }

  const parsed = judgeDecisionSchema.safeParse(rawDecision);
  if (!parsed.success) {
    throw new JudgeDocumentError("Judge reviewx-decision header does not match the protocol.", {
      cause: parsed.error,
    });
  }

  const headerEnd = headerStart + match[0].length;
  const canonicalHeader = normalized.slice(headerStart, headerEnd);
  if (parsed.data.verdict !== "NEW") {
    return {
      decision: parsed.data,
      markdown: "",
      document: canonicalHeader,
    };
  }
  const bodyWithSeparator = normalized.slice(headerEnd);
  const separator = /^(?:\r?\n){2}/u.exec(bodyWithSeparator)?.[0];
  if (separator === undefined) {
    throw new JudgeDocumentError("A NEW Judge decision requires one blank line before its Markdown body.");
  }
  const markdown = bodyWithSeparator.slice(separator.length);
  if (markdown.trim() === "") {
    throw new JudgeDocumentError("A NEW Judge decision requires a non-empty Markdown body.");
  }
  validateNewMarkdown(markdown, parsed.data.severity);

  return {
    decision: parsed.data,
    markdown,
    document: normalized.slice(headerStart),
  };
}
