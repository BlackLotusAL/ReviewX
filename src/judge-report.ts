import {
  judgeDecisionSchema,
  type JudgeDecision,
  type JudgeReport,
} from "./contracts.js";

const decisionPrefix = "<!-- reviewx-decision: ";
const decisionSuffix = " -->";
const decisionCandidatePattern =
  /<!--[ \t\r\n]*reviewx-decision[ \t\r\n]*:[ \t\r\n]*([\s\S]*?)[ \t\r\n]*-->/gimu;

export class JudgeDocumentError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "JudgeDocumentError";
  }
}

export function formatJudgeDecisionHeader(decision: JudgeDecision): string {
  return `${decisionPrefix}${JSON.stringify(decision)}${decisionSuffix}`;
}

interface DecisionCandidate {
  encoded: string;
  start: number;
  end: number;
}

interface ParsedDecisionCandidate extends DecisionCandidate {
  decision: JudgeDecision;
}

function findDecisionCandidates(document: string): DecisionCandidate[] {
  return [...document.matchAll(decisionCandidatePattern)].map((match) => ({
    encoded: match[1]!.trim(),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function normalizeRawDecision(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.verdict !== "string") return value;
  const verdict = record.verdict.trim().toUpperCase();

  if (verdict === "PASS") return { verdict };
  if (verdict === "DUPLICATE") {
    const duplicateCommentId = record.duplicate_comment_id;
    return {
      verdict,
      duplicate_comment_id:
        duplicateCommentId === undefined || duplicateCommentId === null
          ? null
          : typeof duplicateCommentId === "string"
            ? duplicateCommentId.trim()
            : duplicateCommentId,
    };
  }
  if (verdict === "NEW") {
    return {
      verdict,
      severity:
        typeof record.severity === "string"
          ? record.severity.trim().toLowerCase()
          : record.severity,
    };
  }
  return { verdict };
}

function extractFreeMarkdown(region: string): string {
  let markdown = region.trim();
  markdown = markdown.replace(/^(?:```|~~~)[ \t]*(?:\r?\n|$)/u, "").trim();
  return markdown;
}

export function parseJudgeDocument(document: string): JudgeReport {
  const normalized = document.replace(/^\uFEFF/u, "");
  const candidates = findDecisionCandidates(normalized);
  if (candidates.length === 0) {
    throw new JudgeDocumentError(
      "Judge document does not contain a reviewx-decision HTML comment candidate.",
    );
  }

  const parsedCandidates: ParsedDecisionCandidate[] = [];
  let invalidJson = 0;
  let invalidProtocol = 0;
  let invalidNewBody = 0;
  let lastFailure: JudgeDocumentError | undefined;

  for (const candidate of candidates) {
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

    const parsed = judgeDecisionSchema.safeParse(normalizeRawDecision(rawDecision));
    if (!parsed.success) {
      invalidProtocol += 1;
      lastFailure = new JudgeDocumentError(
        "Judge reviewx-decision header candidate does not match the protocol.",
        { cause: parsed.error },
      );
      continue;
    }
    parsedCandidates.push({ ...candidate, decision: parsed.data });
  }

  let selected: JudgeReport | undefined;
  for (const [index, candidate] of parsedCandidates.entries()) {
    const canonicalHeader = formatJudgeDecisionHeader(candidate.decision);
    if (candidate.decision.verdict !== "NEW") {
      selected = {
        decision: candidate.decision,
        markdown: "",
        document: canonicalHeader,
      };
      continue;
    }

    const bodyEnd = parsedCandidates[index + 1]?.start ?? normalized.length;
    const markdown = extractFreeMarkdown(normalized.slice(candidate.end, bodyEnd));
    if (markdown === "") {
      invalidNewBody += 1;
      lastFailure = new JudgeDocumentError(
        "A NEW Judge decision requires a non-empty Markdown body.",
      );
      continue;
    }
    selected = {
      decision: candidate.decision,
      markdown,
      document: `${canonicalHeader}\n\n${markdown}`,
    };
  }

  if (selected !== undefined) return selected;

  const summary = [
    `${candidates.length} candidate(s)`,
    `${invalidJson} invalid JSON`,
    `${invalidProtocol} protocol-invalid`,
    `${invalidNewBody} NEW-body-invalid`,
  ].join(", ");
  throw new JudgeDocumentError(
    `Judge document contains no extractable valid reviewx-decision decision/body pair (${summary}).${lastFailure === undefined ? "" : ` Last candidate error: ${lastFailure.message}`}`,
    { cause: lastFailure },
  );
}
