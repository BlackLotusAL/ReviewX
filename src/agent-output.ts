export type AgentOutputStrategy =
  | "whole"
  | "trailing_raw"
  | "trailing_fence"
  | "single_fence";

export interface AgentOutputAttempt {
  strategy: AgentOutputStrategy;
  candidateText: string;
  processedText?: string;
  appendedClosers: string;
  error?: string;
}

export type AgentOutputProcessing =
  | (AgentOutputAttempt & { success: true; processedText: string; value: unknown })
  | { success: false; attempt?: AgentOutputAttempt; error: string };

interface TextLine {
  start: number;
  nextStart: number;
  text: string;
}

interface OpenMarkdownFence {
  delimiter: "`" | "~";
  length: number;
  language: string;
  openingStart: number;
  contentStart: number;
}

interface MarkdownFence extends OpenMarkdownFence {
  closingStart: number;
  closingEnd: number;
  content: string;
}

interface MarkdownFenceScan {
  blocks: MarkdownFence[];
  open?: OpenMarkdownFence;
}

function textLines(value: string): TextLine[] {
  if (value.length === 0) return [{ start: 0, nextStart: 0, text: "" }];
  const lines: TextLine[] = [];
  let start = 0;
  while (start < value.length) {
    const newline = value.indexOf("\n", start);
    const rawEnd = newline === -1 ? value.length : newline;
    const textEnd = rawEnd > start && value[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    const nextStart = newline === -1 ? value.length : newline + 1;
    lines.push({ start, nextStart, text: value.slice(start, textEnd) });
    start = nextStart;
  }
  return lines;
}

function scanMarkdownFences(value: string): MarkdownFenceScan {
  const blocks: MarkdownFence[] = [];
  let open: OpenMarkdownFence | undefined;

  for (const line of textLines(value)) {
    if (open) {
      const closing = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line.text);
      const closingRun = closing?.[1];
      if (
        closingRun &&
        closingRun[0] === open.delimiter &&
        closingRun.length >= open.length
      ) {
        blocks.push({
          ...open,
          closingStart: line.start,
          closingEnd: line.nextStart,
          content: value.slice(open.contentStart, line.start).trim(),
        });
        open = undefined;
      }
      continue;
    }

    const opening = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u.exec(line.text);
    const openingRun = opening?.[1];
    if (!openingRun) continue;
    open = {
      delimiter: openingRun[0] as "`" | "~",
      length: openingRun.length,
      language: (opening[2] ?? "").trim().toLowerCase(),
      openingStart: line.start,
      contentStart: line.nextStart,
    };
  }

  return { blocks, ...(open === undefined ? {} : { open }) };
}

function positionInsideFence(position: number, scan: MarkdownFenceScan): boolean {
  if (scan.open && position >= scan.open.openingStart) return true;
  return scan.blocks.some(
    (block) => position >= block.openingStart && position < block.closingEnd,
  );
}

function isUnescapedQuote(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 0;
}

function findCompleteTrailingObjectStart(value: string): number | undefined {
  const end = value.trimEnd().length;
  if (end === 0 || value[end - 1] !== "}") return undefined;

  let depth = 0;
  let inString = false;
  for (let index = end - 1; index >= 0; index -= 1) {
    const character = value[index]!;
    if (character === '"' && isUnescapedQuote(value, index)) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === "}") {
      depth += 1;
      continue;
    }
    if (character !== "{") continue;
    depth -= 1;
    if (depth < 0) return undefined;
    if (depth !== 0) continue;
    try {
      const parsed = JSON.parse(value.slice(index, end)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      return index;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isPlausibleRootStart(value: string, start: number): boolean {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const before = value.slice(lineStart, start);
  if (before.trim() === "" && before.length <= 3) return true;
  return /^\{\s*"(?:expert|verdict)"\s*:/u.test(value.slice(start));
}

function repairStructuralClosers(
  candidateText: string,
): { processedText: string; appendedClosers: string } | undefined {
  const candidate = candidateText.trim();
  if (!candidate.startsWith("{")) return undefined;

  const stack: Array<"}" | "]"> = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      stack.push("}");
      continue;
    }
    if (character === "[") {
      stack.push("]");
      continue;
    }
    if (character !== "}" && character !== "]") continue;
    if (stack.pop() !== character) return undefined;
    if (stack.length === 0 && candidate.slice(index + 1).trim() !== "") return undefined;
  }

  if (inString || escaped) return undefined;
  const appendedClosers = [...stack].reverse().join("");
  return { processedText: `${candidate}${appendedClosers}`, appendedClosers };
}

function attemptCandidate(
  strategy: AgentOutputStrategy,
  candidateText: string,
): AgentOutputProcessing {
  const repaired = repairStructuralClosers(candidateText);
  if (!repaired) {
    return {
      success: false,
      attempt: { strategy, candidateText, appendedClosers: "", error: "Unsafe JSON structure." },
      error: "Agent final text does not contain a safely repairable JSON object.",
    };
  }
  try {
    const value = JSON.parse(repaired.processedText) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        success: false,
        attempt: {
          strategy,
          candidateText,
          processedText: repaired.processedText,
          appendedClosers: repaired.appendedClosers,
          error: "Parsed value is not a JSON object.",
        },
        error: "Agent final text is not one valid JSON object.",
      };
    }
    return {
      success: true,
      strategy,
      candidateText,
      processedText: repaired.processedText,
      appendedClosers: repaired.appendedClosers,
      value,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      attempt: {
        strategy,
        candidateText,
        processedText: repaired.processedText,
        appendedClosers: repaired.appendedClosers,
        error: message,
      },
      error: "Agent final text is not one valid JSON object.",
    };
  }
}

function candidateObjectStarts(value: string, scan: MarkdownFenceScan): number[] {
  const schemaStarts = new Set<number>();
  for (const match of value.matchAll(/\{\s*"(?:expert|verdict)"\s*:/gu)) {
    const brace = match.index ?? 0;
    if (!positionInsideFence(brace, scan)) schemaStarts.add(brace);
  }
  const lineStarts: Array<{ start: number; indentation: number }> = [];
  for (const match of value.matchAll(/^[ \t]*(\{)/gmu)) {
    const indentation = match[0].lastIndexOf("{");
    const brace = (match.index ?? 0) + indentation;
    if (!positionInsideFence(brace, scan) && !schemaStarts.has(brace)) {
      lineStarts.push({ start: brace, indentation });
    }
  }
  return [
    ...[...schemaStarts].sort((left, right) => right - left),
    ...lineStarts
      .sort(
        (left, right) => left.indentation - right.indentation || right.start - left.start,
      )
      .map((entry) => entry.start),
  ];
}

function isJsonFenceLanguage(language: string): boolean {
  return language === "" || language === "json";
}

export function processAgentOutputText(value: string): AgentOutputProcessing {
  const combined = value.trim();
  let lastFailure: Extract<AgentOutputProcessing, { success: false }> | undefined;

  if (combined.startsWith("{")) {
    const whole = attemptCandidate("whole", combined);
    if (whole.success) return whole;
    lastFailure = whole;
  }

  const fences = scanMarkdownFences(combined);
  const trailingStart = findCompleteTrailingObjectStart(combined);
  if (
    trailingStart !== undefined &&
    isPlausibleRootStart(combined, trailingStart) &&
    !positionInsideFence(trailingStart, fences)
  ) {
    const prefix = combined.slice(0, trailingStart).trimEnd();
    if (findCompleteTrailingObjectStart(prefix) === undefined) {
      return attemptCandidate("trailing_raw", combined.slice(trailingStart));
    }
  }

  const terminalFence = [...fences.blocks]
    .reverse()
    .find((block) => combined.slice(block.closingEnd).trim() === "");
  if (terminalFence) {
    if (!isJsonFenceLanguage(terminalFence.language)) {
      return {
        success: false,
        attempt: {
          strategy: "trailing_fence",
          candidateText: terminalFence.content,
          appendedClosers: "",
          error: "Terminal Markdown fence language must be empty or json.",
        },
        error: "Agent terminal Markdown fence language must be empty or json.",
      };
    }
    return attemptCandidate("trailing_fence", terminalFence.content);
  }

  for (const start of candidateObjectStarts(combined, fences)) {
    if (start === 0) continue;
    if (findCompleteTrailingObjectStart(combined.slice(0, start).trimEnd()) !== undefined) {
      continue;
    }
    const attempt = attemptCandidate("trailing_raw", combined.slice(start));
    if (attempt.success) return attempt;
    lastFailure ??= attempt;
  }

  if (!fences.open && fences.blocks.length === 1) {
    const [single] = fences.blocks;
    if (!isJsonFenceLanguage(single!.language)) {
      return {
        success: false,
        attempt: {
          strategy: "single_fence",
          candidateText: single!.content,
          appendedClosers: "",
          error: "Markdown fence language must be empty or json.",
        },
        error: "Agent output Markdown fence language must be empty or json.",
      };
    }
    return attemptCandidate("single_fence", single!.content);
  }

  return (
    lastFailure ?? {
      success: false,
      error: fences.open
        ? "Agent output has an unterminated Markdown fence."
        : "Agent final text is not one valid JSON object.",
    }
  );
}
