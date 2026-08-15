import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DefaultCommandRunner } from "../../src/process.js";

const runner = new DefaultCommandRunner();
let root: string;
let fakeCodeHub: string;
let callLog: string;

async function runSmoke(environment: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...environment,
    REVIEWX_CODEHUB_BIN: fakeCodeHub,
    CODEHUB_CALL_LOG: callLog,
  };
  delete env.REVIEWX_SMOKE_REPO_ID;
  delete env.FAKE_AUTH_INVALID;
  if (environment.REVIEWX_SMOKE_REPO_ID !== undefined) {
    env.REVIEWX_SMOKE_REPO_ID = environment.REVIEWX_SMOKE_REPO_ID;
  }
  if (environment.FAKE_AUTH_INVALID !== undefined) {
    env.FAKE_AUTH_INVALID = environment.FAKE_AUTH_INVALID;
  }
  return await runner.run("pnpm", ["exec", "tsx", path.resolve("tests", "smoke.ts")], {
    cwd: path.resolve("."),
    env,
    timeoutMs: 20_000,
  });
}

async function calls(): Promise<string[][]> {
  const text = await readFile(callLog, "utf8");
  return text.trim() === ""
    ? []
    : text.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as string[]);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "reviewx-smoke-"));
  callLog = path.join(root, "calls.jsonl");
  const source = path.join(root, "fake-codehub.mjs");
  await writeFile(
    source,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.CODEHUB_CALL_LOG, JSON.stringify(args) + "\\n");
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write("CodeHub help\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(process.env.FAKE_AUTH_INVALID === "true" ? "not-json\\n" : '{"configured":false}\\n');
  process.exit(0);
}
process.stderr.write(JSON.stringify({code:"UNEXPECTED_COMMAND",message:args.join(" ")}) + "\\n");
process.exit(2);
`,
    "utf8",
  );
  await chmod(source, 0o755);
  if (process.platform === "win32") {
    fakeCodeHub = path.join(root, "fake-codehub.cmd");
    await writeFile(fakeCodeHub, `@"${process.execPath}" "${source}" %*\r\n`, "utf8");
  } else {
    fakeCodeHub = source;
  }
});

beforeEach(async () => {
  await writeFile(callLog, "", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("live smoke preflight", () => {
  it("probes CodeHub with the documented help option", async () => {
    const result = await runSmoke();
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "SKIP: REVIEWX_SMOKE_REPO_ID is not set.\n",
      stderr: "",
    });
    expect(await calls()).toEqual([["--help"]]);
  });

  it("skips an unauthenticated CodeHub without calling repository commands", async () => {
    const result = await runSmoke({ REVIEWX_SMOKE_REPO_ID: "1" });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "SKIP: codehub is not authenticated.\n",
      stderr: "",
    });
    expect(await calls()).toEqual([
      ["--help"],
      ["auth", "status", "--output", "json"],
    ]);
  });

  it("fails when auth status succeeds with invalid JSON", async () => {
    const result = await runSmoke({
      REVIEWX_SMOKE_REPO_ID: "1",
      FAKE_AUTH_INVALID: "true",
    });
    expect(result).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: "Live smoke check failed: codehub auth status returned invalid JSON.\n",
    });
  });
});
