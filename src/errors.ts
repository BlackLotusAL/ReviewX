export type ReviewXErrorCode =
  | "INVALID_ARGUMENT"
  | "DUPLICATE_REPOSITORY"
  | "STATE_ERROR"
  | "LOCK_ERROR"
  | "PROCESS_ERROR"
  | "PROCESS_TIMEOUT"
  | "PROCESS_ABORTED"
  | "CODEHUB_ERROR"
  | "GIT_ERROR"
  | "AGENT_ERROR"
  | "LOG_ERROR";

export class ReviewXError extends Error {
  readonly code: ReviewXErrorCode;
  readonly exitCode: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ReviewXErrorCode,
    message: string,
    options: {
      exitCode?: number;
      cause?: unknown;
      details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ReviewXError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.details = options.details;
  }
}

export function redactText(value: string): string {
  return value
    .replace(/:\/\/[^@/\s]+@/gu, "://***@")
    .replace(/\b(token|password|secret|appcode)\s*[:=]\s*[^\s,;]+/giu, "$1=***")
    .replace(/\b(private-token|x-auth-token)\b\s*[:=]\s*[^\s,;]+/giu, "$1=***")
    .slice(0, 1_000);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactText(error.message);
  }
  return redactText(String(error));
}
