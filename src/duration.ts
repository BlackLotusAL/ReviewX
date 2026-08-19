import { ReviewXError } from "./errors.js";

const durationPattern = /^(\d+)(ms|s|m)$/u;
const intervalPattern = /^(\d+)(m|h|d)$/u;

function parsePositiveDuration(
  value: string,
  optionName: string,
  pattern: RegExp,
  units: string,
  multiplierFor: (unit: string) => number,
): number {
  const match = pattern.exec(value);
  if (!match) {
    throw new ReviewXError(
      "INVALID_ARGUMENT",
      `${optionName} must be a positive integer followed by ${units}.`,
      { exitCode: 2 },
    );
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new ReviewXError("INVALID_ARGUMENT", `${optionName} must be greater than zero.`, {
      exitCode: 2,
    });
  }
  const result = amount * multiplierFor(match[2]!);
  if (!Number.isSafeInteger(result)) {
    throw new ReviewXError("INVALID_ARGUMENT", `${optionName} is too large.`, { exitCode: 2 });
  }
  return result;
}

export function parseDuration(value: string, optionName: string): number {
  return parsePositiveDuration(
    value,
    optionName,
    durationPattern,
    "ms, s, or m",
    (unit) => (unit === "ms" ? 1 : unit === "s" ? 1_000 : 60_000),
  );
}

export function parseInterval(value: string, optionName: string): number {
  return parsePositiveDuration(
    value,
    optionName,
    intervalPattern,
    "m, h, or d",
    (unit) => (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000),
  );
}
