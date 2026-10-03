import { createHash } from "node:crypto";
import { AppError, type AppErrorOptions } from "../errors";
export const REVIEW_LIMITS = Object.freeze({ timeoutMs: 60 * 60_000, softTargetMs: 5 * 60_000, outputBytes: 4 * 1024 * 1024 });
export const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export function reviewError(code: string, reason: string, details: Partial<Pick<AppErrorOptions, "technical" | "stderr" | "cause" | "classified">> = {}): AppError {
  return new AppError({ code, message: "ReviewX 检视未完成。", reason, impact: "本次任务未完整完成，已保存结果不受影响。",
    nextStep: "查看具体原因后重试该任务。", technical: code, ...details });
}
export function safeRepositoryPath(value: string): boolean {
  return !!value && !/[\\:<>"|?*\x00-\x1f\x7f]/u.test(value) && !value.startsWith("/") && value.split("/").every(part =>
    !!part && part !== "." && part !== ".." && part.toLowerCase() !== ".git" && !/[. ]$/u.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}
