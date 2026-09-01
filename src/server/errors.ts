import type { SafeErrorView } from "@/src/shared/types";

export interface AppErrorOptions {
  code: string;
  message: string;
  reason: string;
  impact: string;
  nextStep: string;
  technical: string;
  httpStatus?: number;
  stderr?: string;
  cause?: unknown;
  classified?: boolean;
}

const appErrorBrand = Symbol.for("reviewx.app-error");

export class AppError extends Error {
  readonly code: string;
  readonly reason: string;
  readonly impact: string;
  readonly nextStep: string;
  readonly technical: string;
  readonly httpStatus: number;
  readonly stderr?: string;
  readonly classified: boolean;

  constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.reason = options.reason;
    this.impact = options.impact;
    this.nextStep = options.nextStep;
    this.technical = options.technical;
    this.httpStatus = options.httpStatus ?? 500;
    this.stderr = options.stderr;
    this.classified = options.classified ?? true;
    Object.defineProperty(this, appErrorBrand, { value: true });
  }

  toSafeView(sanitize: (value: string) => string = (value) => value): SafeErrorView {
    const view: SafeErrorView = {
      code: this.code,
      message: sanitize(this.message),
      cause: sanitize(this.reason),
      impact: sanitize(this.impact),
      nextStep: sanitize(this.nextStep),
      technicalDetails: sanitize(this.technical),
    };
    if (this.stderr?.trim()) view.stderr = sanitize(this.stderr);
    if (!this.classified && this.stack) view.stack = sanitize(this.stack);
    return view;
  }
}

export function isAppError(error: unknown): error is AppError {
  return Boolean(error && typeof error === "object" && (error as Record<symbol, unknown>)[appErrorBrand] === true);
}

export function unexpectedError(error: unknown, operation: string): AppError {
  if (isAppError(error)) {
    return error;
  }

  const cause = error instanceof Error ? error : new Error(String(error));
  return new AppError({
    code: "INTERNAL_ERROR",
    message: `ReviewX 无法完成${operation}。`,
    reason: "发生了非预期内部错误。",
    impact: "当前操作已停止，未确认的外部写入不会自动重试。",
    nextStep: "查看日志中的技术详情，修复问题后重新操作。",
    technical: cause.message,
    cause,
    classified: false,
  });
}

export function conflictError(code: string, message: string, nextStep: string): AppError {
  return new AppError({
    code,
    message,
    reason: message,
    impact: "本次请求未执行外部命令。",
    nextStep,
    technical: `请求因状态冲突被拒绝（${code}）。`,
    httpStatus: 409,
  });
}

export function validationError(message: string): AppError {
  return new AppError({
    code: "INVALID_ARGUMENT",
    message,
    reason: message,
    impact: "本次请求未执行外部命令。",
    nextStep: "修正输入后重试。",
    technical: "请求参数未通过 ReviewX 校验。",
    httpStatus: 422,
  });
}

export function notFoundError(message: string): AppError {
  return new AppError({
    code: "NOT_FOUND",
    message,
    reason: message,
    impact: "本次请求未执行外部命令。",
    nextStep: "刷新页面后重试。",
    technical: "Requested ReviewX resource was not found.",
    httpStatus: 404,
  });
}
