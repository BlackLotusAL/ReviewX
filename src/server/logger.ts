import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { SafeErrorView } from "@/src/shared/types";
import { AppError } from "./errors";
import type { DataPaths } from "./paths";
import { escapeSingleLine, Redactor } from "./redaction";

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function localTimestamp(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function fileTimestamp(date: Date): string {
  return localTimestamp(date).replace(/[-: ]/gu, "").replace(".", "-");
}

export function createLogFile(paths: DataPaths, now = new Date()): string {
  const target = path.join(paths.logs, `reviewx-${fileTimestamp(now)}-${process.pid}-${randomBytes(4).toString("hex")}.log`);
  try {
    fs.writeFileSync(target, "", { encoding: "utf8", flag: "wx" });
    return target;
  } catch (error) {
    throw new AppError({
      code: "LOG_CREATE_ERROR",
      message: "ReviewX 无法创建本次会话日志。",
      reason: "日志目录不可写或日志文件无法创建。",
      impact: "Web 服务未启动。",
      nextStep: "检查 ReviewX logs 目录权限后重试。",
      technical: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
}

export interface LogContext {
  projectId?: string;
  projectName?: string;
  mrIid?: string;
  mrTitle?: string;
  attemptId?: string;
  findingOrdinal?: number;
}

export class Logger {
  readonly redactor: Redactor;
  #failed = false;
  #onFailure?: (error: AppError) => void;

  constructor(readonly filePath: string, environment: Readonly<Record<string, string | undefined>> = process.env, private readonly now = () => new Date()) {
    this.redactor = new Redactor(environment);
  }

  setFailureHandler(handler: (error: AppError) => void): void {
    this.#onFailure = handler;
  }

  sanitize(value: string): string {
    return escapeSingleLine(this.redactor.redact(value));
  }

  info(context: LogContext, message: string): void {
    this.#append("INFO", context, this.sanitize(message));
  }

  error(context: LogContext, error: AppError): void {
    const diagnostic = error.toSafeView((value) => this.redactor.redact(value));
    const lines = [
      `${this.#prefix("ERROR", context)} ${this.sanitize(error.message)}`,
      `    Cause: ${this.sanitize(diagnostic.cause)}`,
      `    Impact: ${this.sanitize(diagnostic.impact)}`,
      `    Next step: ${this.sanitize(diagnostic.nextStep)}`,
      `    Technical details: ${this.sanitize(diagnostic.technicalDetails)}`,
    ];
    if (diagnostic.stderr) {
      lines.push("    Stderr:", ...this.redactor.redact(diagnostic.stderr).split(/\r?\n/gu).map((line) => `      ${escapeSingleLine(line)}`));
    }
    if (diagnostic.stack) {
      lines.push("    Stack:", ...this.redactor.redact(diagnostic.stack).split(/\r?\n/gu).map((line) => `      ${escapeSingleLine(line)}`));
    }
    this.#write(`${lines.join("\n")}\n`);
  }

  safeError(error: AppError): SafeErrorView {
    return error.toSafeView((value) => this.redactor.redact(value));
  }

  #prefix(level: "INFO" | "ERROR", context: LogContext): string {
    const fields: string[] = [`[${localTimestamp(this.now())}]`, `[${level}]`];
    if (context.projectId) fields.push(`[Project: ${this.sanitize(context.projectName ?? context.projectId)} (#${this.sanitize(context.projectId)})]`);
    if (context.mrIid) fields.push(`[MR: ${this.sanitize(context.mrTitle ?? "unknown")} (!${this.sanitize(context.mrIid)})]`);
    if (context.attemptId) fields.push(`[Attempt: ${this.sanitize(context.attemptId)}]`);
    if (context.findingOrdinal !== undefined) fields.push(`[Finding ${context.findingOrdinal}]`);
    return fields.join(" ");
  }

  #append(level: "INFO" | "ERROR", context: LogContext, message: string): void {
    this.#write(`${this.#prefix(level, context)} ${message}\n`);
  }

  #write(text: string): void {
    if (this.#failed) throw new Error("ReviewX session log is unavailable.");
    try {
      fs.appendFileSync(this.filePath, text, "utf8");
    } catch (cause) {
      this.#failed = true;
      const error = new AppError({
        code: "LOG_WRITE_ERROR",
        message: "ReviewX 无法继续写入本次会话日志。",
        reason: "运行期间日志文件变为不可写。",
        impact: "ReviewX 不再启动新的刷新、检视或发布操作。",
        nextStep: "恢复日志目录写入权限并重新启动 ReviewX。",
        technical: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
      this.#onFailure?.(error);
      throw error;
    }
  }
}
