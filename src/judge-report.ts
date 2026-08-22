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

const severityMarkers = {
  fatal: "🔴 fatal",
  major: "🟠 major",
  minor: "🟡 minor",
  suggestion: "🔵 suggestion",
} as const satisfies Record<Severity, string>;

const narrativeHeadings = ["**问题描述**", "**影响**", "**修复建议**"] as const;

function requireSingleLine(lines: readonly string[], expected: string): number {
  const indexes = lines.flatMap((line, index) => line === expected ? [index] : []);
  if (indexes.length !== 1) {
    throw new JudgeDocumentError(`NEW Judge Markdown must contain exactly one ${expected} section.`);
  }
  return indexes[0]!;
}

function validateTags(line: string): void {
  const prefix = "**问题类型**：";
  if (!line.startsWith(prefix)) {
    throw new JudgeDocumentError("NEW Judge Markdown must place 问题类型 after 严重等级.");
  }
  const raw = line.slice(prefix.length);
  const tags = [...raw.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
  if (tags.length === 0 || tags.map((tag) => `\`${tag}\``).join(", ") !== raw) {
    throw new JudgeDocumentError("NEW Judge Markdown 问题类型 must be comma-separated backtick tags.");
  }
  for (const tag of tags) {
    if (!standardTags.includes(tag as (typeof standardTags)[number]) && !/^domain:[a-z0-9][a-z0-9-]*$/u.test(tag)) {
      throw new JudgeDocumentError(`NEW Judge Markdown contains unsupported tag ${tag}.`);
    }
  }
}

function validateLocation(line: string): void {
  const match = /^\*\*位置\*\*：`([^`]+)` L\d+(?:-L\d+)?$/u.exec(line);
  if (!match?.[1]) {
    throw new JudgeDocumentError("NEW Judge Markdown 位置 must use a repository-relative path and line number.");
  }
  const file = match[1];
  if (file.startsWith("/") || /^[A-Za-z]:/u.test(file) || file.includes("\\") || file.split("/").includes("..")) {
    throw new JudgeDocumentError("NEW Judge Markdown 位置 path must be repository-relative.");
  }
}

function validateNarrative(lines: readonly string[], start: number, end: number, heading: string): void {
  const content = lines.slice(start + 1, end);
  const first = content.find((line) => line.trim() !== "");
  if (first === undefined || !first.startsWith("> ")) {
    throw new JudgeDocumentError(`NEW Judge Markdown ${heading} content must start with a blockquote.`);
  }
}

function validateNewMarkdown(markdown: string, severity: Severity): void {
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n");
  const title = /^### 【(fatal|major|minor|suggestion)】\S.*$/u.exec(lines[0] ?? "");
  if (title?.[1] !== severity) {
    throw new JudgeDocumentError("NEW Judge Markdown title severity must match the decision header.");
  }
  if (lines[1] !== "") {
    throw new JudgeDocumentError("NEW Judge Markdown must place one blank line after the title.");
  }
  if (lines[2] !== `**严重等级**：${severityMarkers[severity]}`) {
    throw new JudgeDocumentError("NEW Judge Markdown 严重等级 does not match the required marker.");
  }
  validateTags(lines[3] ?? "");
  validateLocation(lines[4] ?? "");
  if (lines[5] !== "") {
    throw new JudgeDocumentError("NEW Judge Markdown must place one blank line after metadata.");
  }

  const problem = requireSingleLine(lines, narrativeHeadings[0]);
  const impact = requireSingleLine(lines, narrativeHeadings[1]);
  const recommendation = requireSingleLine(lines, narrativeHeadings[2]);
  if (problem !== 6 || !(problem < impact && impact < recommendation)) {
    throw new JudgeDocumentError("NEW Judge Markdown sections must follow the reference-template order.");
  }
  validateNarrative(lines, problem, impact, narrativeHeadings[0]);
  validateNarrative(lines, impact, recommendation, narrativeHeadings[1]);
  validateNarrative(lines, recommendation, lines.length, narrativeHeadings[2]);

  const extraHeadings = lines.filter((line, index) =>
    index !== 0 && (/^#{1,6}\s/u.test(line) || /^\*\*[^*]+\*\*$/u.test(line))
  ).filter((line) => !narrativeHeadings.includes(line as (typeof narrativeHeadings)[number]));
  if (extraHeadings.length > 0) {
    throw new JudgeDocumentError("NEW Judge Markdown must not contain extra headings or sections.");
  }
  if (lines.some((line) => /^\*\*[^*]+\*\*：/u.test(line)) &&
      lines.filter((line) => /^\*\*[^*]+\*\*：/u.test(line)).length !== 3) {
    throw new JudgeDocumentError("NEW Judge Markdown must contain only the three reference metadata fields.");
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
