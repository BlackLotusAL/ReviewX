import { parseArgs } from "node:util";
import path from "node:path";
import {
  addRepository,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  defaultStatePath,
  runService,
} from "./app.js";
import { parseDuration } from "./duration.js";
import { errorMessage, ReviewXError } from "./errors.js";

const VERSION = "0.1.0";

const usage = `ReviewX ${VERSION}

Usage:
  reviewx repo add <repo-id> [--state runtime/state.json]
  reviewx run [--interval 10m] [--agent-timeout 20m] [--max-consecutive-failures 3] [--state runtime/state.json] [--log runtime/reviewx.log]
  reviewx --help
  reviewx --version
`;

function invalid(message: string): never {
  throw new ReviewXError("INVALID_ARGUMENT", message, { exitCode: 2 });
}

function absoluteFromCwd(value: string): string {
  return path.resolve(process.cwd(), value);
}

function optionString(value: unknown, optionName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(`${optionName} requires one string value.`);
  return value;
}

function positiveInteger(value: string, optionName: string): number {
  if (!/^[1-9]\d*$/u.test(value)) invalid(`${optionName} requires a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalid(`${optionName} is too large.`);
  return parsed;
}

async function repoCommand(argv: string[]): Promise<number> {
  if (argv[0] !== "add") invalid("Expected: reviewx repo add <repo-id>.");
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      options: { state: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    invalid(errorMessage(error));
  }
  if (parsed.positionals.length !== 1) invalid("repo add requires exactly one repository ID.");
  const statePath = absoluteFromCwd(
    optionString(parsed.values.state, "--state") ?? defaultStatePath(),
  );
  const repoId = await addRepository(parsed.positionals[0]!, statePath);
  process.stdout.write(`${JSON.stringify({ added: true, repo_id: repoId })}\n`);
  return 0;
}

async function runCommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        interval: { type: "string", default: "10m" },
        "agent-timeout": { type: "string", default: "20m" },
        "max-consecutive-failures": {
          type: "string",
          default: String(DEFAULT_MAX_CONSECUTIVE_FAILURES),
        },
        state: { type: "string" },
        log: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    invalid(errorMessage(error));
  }
  const statePath = absoluteFromCwd(
    optionString(parsed.values.state, "--state") ?? defaultStatePath(),
  );
  const rawLogPath = optionString(parsed.values.log, "--log");
  const logPath = rawLogPath ? absoluteFromCwd(rawLogPath) : undefined;
  const intervalMs = parseDuration(
    optionString(parsed.values.interval, "--interval") ?? "10m",
    "--interval",
  );
  const agentTimeoutMs = parseDuration(
    optionString(parsed.values["agent-timeout"], "--agent-timeout") ?? "20m",
    "--agent-timeout",
  );
  const maxConsecutiveFailures = positiveInteger(
    optionString(parsed.values["max-consecutive-failures"], "--max-consecutive-failures") ??
      String(DEFAULT_MAX_CONSECUTIVE_FAILURES),
    "--max-consecutive-failures",
  );
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await runService({
      statePath,
      ...(logPath === undefined ? {} : { logPath }),
      intervalMs,
      agentTimeoutMs,
      maxConsecutiveFailures,
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  return interrupted ? 130 : 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage);
    return 0;
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (argv[0] === "repo") return await repoCommand(argv.slice(1));
  if (argv[0] === "run") return await runCommand(argv.slice(1));
  invalid(`Unknown command: ${argv[0] ?? ""}`);
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const body = {
      code: error instanceof ReviewXError ? error.code : "INTERNAL_ERROR",
      message: errorMessage(error),
    };
    process.stderr.write(`${JSON.stringify(body)}\n`);
    process.exitCode = error instanceof ReviewXError ? error.exitCode : 1;
  });
