import { createHash } from "node:crypto";
import { AppError, type AppErrorOptions } from "../errors";
import type { TextPage } from "./types";

export const REVIEW_LIMITS = Object.freeze({ pageLines: 200, pageBytes: 32 * 1024, contentBytes: 24 * 1024,
  blobBytes: 16 * 1024 * 1024, diffBytes: 64 * 1024 * 1024, deliveryBytes: 64 * 1024 * 1024,
  submissionBytes: 1024 * 1024, findings: 100, bodyBytes: 64 * 1024, timeoutMs: 60 * 60_000 });

export const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function reviewError(code: string, reason: string, details: Partial<Pick<AppErrorOptions, "technical" | "stderr" | "cause" | "classified">> = {}): AppError {
  return new AppError({ code, message: "ReviewX 多轮检视未完成。", reason, impact: "本次结果不可发布。",
    nextStep: "检查检视限制、规则和原生 OpenCode 环境后手动重新检视。", technical: code, ...details });
}

export function safeRepositoryPath(value: string): boolean {
  return !!value && !/[\\:<>"|?*\x00-\x1f\x7f]/u.test(value) && !value.startsWith("/") && value.split("/").every((part) =>
    !!part && part !== "." && part !== ".." && part.toLowerCase() !== ".git" && !/[. ]$/u.test(part) && !/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part));
}

export function textPages(text: string): TextPage[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const pages: TextPage[] = [];
  for (let i = 0; i < lines.length;) {
    const startLine = i + 1;
    let content = "";
    while (i < lines.length && i < startLine - 1 + REVIEW_LIMITS.pageLines) {
      if (Buffer.byteLength(lines[i]) > REVIEW_LIMITS.contentBytes) throw reviewError("REVIEW_INCOMPLETE", "单行超过页面上限，不能截断后作为完整证据。");
      if (Buffer.byteLength(content + lines[i]) > REVIEW_LIMITS.contentBytes) break;
      content += lines[i++];
    }
    pages.push({ startLine, endLine: i, content, hash: digest(content) });
  }
  return pages.length ? pages : [{ startLine: 0, endLine: 0, content: "", hash: digest("") }];
}
