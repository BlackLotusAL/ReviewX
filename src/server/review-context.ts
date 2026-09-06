import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ReviewEvidence, ReviewerFinding } from "@/src/shared/types";
import { AppError } from "./errors";
import { Redactor } from "./redaction";

export interface ReviewFile {
  side: ReviewEvidence["side"];
  path: string;
  lines: number;
  changedLines: Array<{ start: number; end: number }>;
}

export function isReviewPath(value: string): boolean {
  return Boolean(value) && !/[\\:\x00-\x1f\x7f]/u.test(value) && !value.startsWith("/") &&
    value.split("/").every(part => part !== "" && part !== "." && part !== ".." && !/[. ]$/u.test(part));
}

export function isInstructionPath(value: string): boolean {
  return value.split("/").some(part => /^(?:\.git|\.opencode|\.claude|\.agents|AGENTS\.md|CLAUDE\.md|CONTEXT\.md|SKILL\.md|opencode\.jsonc?)$/iu.test(part));
}

function decodeDiffPath(value: string): string {
  if (value === "/dev/null") return "";
  let decoded = value;
  if (value.startsWith('"') && value.endsWith('"')) {
    const bytes: number[] = [];
    const content = value.slice(1, -1);
    for (let i = 0; i < content.length;) {
      if (content[i] === "\\") {
        const octal = /^[0-7]{1,3}/u.exec(content.slice(i + 1));
        if (octal) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length + 1; continue; }
        const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", a: "\x07" };
        bytes.push(...Buffer.from(escapes[content[i + 1]] ?? content[i + 1] ?? "", "utf8"));
        i += 2;
      } else {
        const character = String.fromCodePoint(content.codePointAt(i)!);
        bytes.push(...Buffer.from(character, "utf8"));
        i += character.length;
      }
    }
    decoded = Buffer.from(bytes).toString("utf8");
  }
  return decoded.replace(/^[ab]\//u, "");
}

/** Index only added/deleted lines, never unchanged context inside a hunk. */
export function changedLineIndex(patch: string): Map<string, ReviewFile["changedLines"]> {
  const result = new Map<string, ReviewFile["changedLines"]>();
  let source = "", base = "", sourceLine = 0, baseLine = 0, inHunk = false;
  const add = (side: string, path: string, line: number) => {
    if (!isReviewPath(path)) return;
    const key = `${side}:${path}`;
    const ranges = result.get(key) ?? [];
    const last = ranges.at(-1);
    if (last && last.end + 1 === line) last.end = line;
    else ranges.push({ start: line, end: line });
    result.set(key, ranges);
  };
  for (const line of patch.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) { source = ""; base = ""; inHunk = false; continue; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) { baseLine = Number(hunk[1]); sourceLine = Number(hunk[2]); inHunk = true; continue; }
    if (!inHunk) {
      if (line.startsWith("--- ")) base = decodeDiffPath(line.slice(4));
      if (line.startsWith("+++ ")) source = decodeDiffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+")) add("source", source, sourceLine++);
    else if (line.startsWith("-")) add("base", base, baseLine++);
    else if (line.startsWith(" ")) { sourceLine++; baseLine++; }
  }
  return result;
}

export async function copyReviewSnapshot(options: {
  repository: string;
  destination: string;
  side: ReviewEvidence["side"];
  tree: string;
  changed: Map<string, ReviewFile["changedLines"]>;
  redactor: Redactor;
  budget: { remaining: number };
  signal: AbortSignal;
}): Promise<{ files: ReviewFile[]; limitations: string[]; omitted: Set<string> }> {
  const files: ReviewFile[] = [], limitations: string[] = [];
  const omitted = new Set<string>();
  const root = await realpath(options.repository);
  await mkdir(options.destination, { recursive: true });
  for (const entry of options.tree.split("\0").filter(Boolean)) {
    options.signal.throwIfAborted();
    const match = /^(\d+) \w+ [a-f0-9]+\t([\s\S]+)$/u.exec(entry);
    if (!match) throw new Error("Invalid Git tree entry");
    const [, mode, gitPath] = match;
    if (options.redactor.containsCredential(gitPath)) throw new Error("Credential-bearing repository path");
    const omit = (reason: string) => {
      omitted.add(gitPath);
      limitations.push(`${options.side}/${gitPath}: ${reason}`);
    };
    if (!isReviewPath(gitPath) || isInstructionPath(gitPath)) { omit("excluded path or agent configuration"); continue; }
    if (mode !== "100644" && mode !== "100755") { omit("not a regular file (link or submodule)"); continue; }
    const candidate = resolve(root, gitPath);
    const resolved = await realpath(/* turbopackIgnore: true */ candidate);
    const fromRoot = relative(root, resolved);
    const metadata = await lstat(/* turbopackIgnore: true */ candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink() || isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      omit("not a contained regular file"); continue;
    }
    if (metadata.size > 8 * 1024 * 1024 || metadata.size > options.budget.remaining) { omit("snapshot size limit"); continue; }
    const buffer = await readFile(/* turbopackIgnore: true */ candidate);
    if (buffer.includes(0)) { omit("binary content"); continue; }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { omit("invalid UTF-8"); continue; }
    if (options.redactor.containsCredential(text)) { omit("credential detector blocked file"); continue; }
    const target = resolve(options.destination, gitPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, { encoding: "utf8", flag: "wx" });
    options.budget.remaining -= buffer.length;
    files.push({
      side: options.side, path: gitPath,
      lines: text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
      changedLines: options.changed.get(`${options.side}:${gitPath}`) ?? [],
    });
  }
  return { files, limitations, omitted };
}

export function assertFindingEvidence(findings: ReviewerFinding[], files: readonly ReviewFile[]): void {
  const index = new Map(files.map(file => [`${file.side}:${file.path}`, file]));
  for (const finding of findings) {
    let touchesChange = false;
    for (const evidence of finding.evidence) {
      const file = index.get(`${evidence.side}:${evidence.path}`);
      if (!isReviewPath(evidence.path) || !file || evidence.startLine < 1 || evidence.endLine < evidence.startLine || evidence.endLine > file.lines) {
        throw invalidEvidence("An evidence reference is outside the readable snapshot or its line range.");
      }
      touchesChange ||= file.changedLines.some(range => evidence.startLine <= range.end && evidence.endLine >= range.start);
    }
    if (!touchesChange) throw invalidEvidence("Finding evidence does not intersect an added or deleted line.");
  }
}

function invalidEvidence(technical: string): AppError {
  return new AppError({ code: "INVALID_REVIEW_EVIDENCE", message: "检视意见的代码依据无法核实。",
    reason: "证据位置必须存在于检视副本中，且至少一处涉及本次改动。", impact: "本次结果尚不可处理。",
    nextStep: "等待一次结果纠正；若仍失败，请重新检视。", technical });
}
