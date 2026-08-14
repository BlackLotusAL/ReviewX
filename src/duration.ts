import { ReviewXError } from "./errors.js";

const durationPattern = /^(\d+)(ms|s|m)$/u;

export function parseDuration(value: string, optionName: string): number {
  const match = durationPattern.exec(value);
  if (!match) {
    throw new ReviewXError(
      "INVALID_ARGUMENT",
      `${optionName} must be a positive integer followed by ms, s, or m.`,
      { exitCode: 2 },
    );
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new ReviewXError("INVALID_ARGUMENT", `${optionName} must be greater than zero.`, {
      exitCode: 2,
    });
  }
  const unit = match[2];
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : 60_000;
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result)) {
    throw new ReviewXError("INVALID_ARGUMENT", `${optionName} is too large.`, { exitCode: 2 });
  }
  return result;
}
