import { judgeDecisionSchema, type JudgeDecision, type JudgeReport } from "./contracts.js";

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
  const bodyStart = normalized[headerEnd] === "\n" ? headerEnd + 1 : headerEnd;
  const markdown = normalized.slice(bodyStart);
  if (parsed.data.verdict !== "NEW") {
    return {
      decision: parsed.data,
      markdown: "",
      document: canonicalHeader,
    };
  }
  if (parsed.data.verdict === "NEW" && markdown.trim() === "") {
    throw new JudgeDocumentError("A NEW Judge decision requires a non-empty Markdown body.");
  }

  return {
    decision: parsed.data,
    markdown,
    document: normalized.slice(headerStart),
  };
}
