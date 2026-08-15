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

function redactSecrets(value: string): string {
  return value
    .replace(/:\/\/[^@/\s]+@/gu, "://***@")
    .replace(
      /(["'])(token|password|secret|appcode|private-token|x-auth-token)\1\s*:\s*(["'])[^"'\r\n]*\3/giu,
      (_match, keyQuote: string, key: string, valueQuote: string) =>
        `${keyQuote}${key}${keyQuote}:${valueQuote}***${valueQuote}`,
    )
    .replace(/\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu, "authorization=***")
    .replace(/\b(token|password|secret|appcode)\s*[:=]\s*[^\s,;]+/giu, "$1=***")
    .replace(/\b(private-token|x-auth-token)\b\s*[:=]\s*[^\s,;]+/giu, "$1=***");
}

export function redactText(value: string): string {
  return redactSecrets(value).slice(0, 1_000);
}

export interface DiagnosticTextPreview {
  text: string;
  originalCharacters: number;
  truncated: boolean;
}

export function diagnosticTextPreview(
  value: string,
  maxCharacters = 16 * 1_024,
): DiagnosticTextPreview {
  const redacted = redactSecrets(value);
  const limit = Math.max(0, maxCharacters);
  if (redacted.length <= limit) {
    return { text: redacted, originalCharacters: value.length, truncated: false };
  }
  const marker = "\n...[truncated]...\n";
  if (limit <= marker.length) {
    return {
      text: marker.slice(0, limit),
      originalCharacters: value.length,
      truncated: true,
    };
  }
  const available = limit - marker.length;
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return {
    text: `${redacted.slice(0, headLength)}${marker}${redacted.slice(-tailLength)}`,
    originalCharacters: value.length,
    truncated: true,
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactText(error.message);
  }
  return redactText(String(error));
}
