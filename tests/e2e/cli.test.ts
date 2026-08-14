import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DefaultCommandRunner } from "../../src/process.js";

const runner = new DefaultCommandRunner();
let root: string;
let fakeCodeHub: string;
const cli = path.resolve("dist", "cli.js");

async function command(args: string[], cwd = root) {
  return await runner.run(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, REVIEWX_CODEHUB_BIN: fakeCodeHub },
    timeoutMs: 20_000,
  });
}

async function waitForFileText(target: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(target, "utf8");
      if (pattern.test(text)) return text;
    } catch {
      // The process has not created the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${target}`);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "reviewx-cli-"));
  const build = await runner.run("pnpm", ["build"], { cwd: path.resolve("."), timeoutMs: 60_000 });
  if (build.exitCode !== 0) throw new Error(build.stderr || build.stdout);
  const source = path.join(root, "fake-codehub.mjs");
  await writeFile(
    source,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  if (args[2] === "404") {
    process.stderr.write(JSON.stringify({code:"HTTP_ERROR",message:"not found",http_status:404}) + "\\n");
    process.exit(4);
  }
  process.stdout.write(JSON.stringify({repo_id:String(BigInt(args[2])),full_name:"test/repo",clone_urls:{ssh:null,https:"https://example.test/repo.git"},archived:false,updated_at:"2026-08-12T00:00:00Z",default_branch:"main",web_url:null}) + "\\n");
  process.exit(0);
}
if (args[0] === "mr" && args[1] === "list") {
  process.stdout.write("[]\\n");
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

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("built CLI", () => {
  it("prints help and version", async () => {
    expect(await command(["--help"])).toMatchObject({ exitCode: 0 });
    const version = await command(["--version"]);
    expect(version).toMatchObject({ exitCode: 0, stdout: "0.1.0\n" });
  });

  it("adds a canonical repository and rejects duplicates or invalid IDs", async () => {
    const statePath = path.join(root, "repo-add", "state.json");
    const first = await command(["repo", "add", "0007", "--state", statePath]);
    expect(first).toMatchObject({ exitCode: 0, stdout: '{"added":true,"repo_id":"7"}\n' });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      repositories: { "7": { merge_requests: {} } },
    });
    const duplicate = await command(["repo", "add", "7", "--state", statePath]);
    expect(duplicate.exitCode).toBe(2);
    expect(JSON.parse(duplicate.stderr)).toMatchObject({ code: "DUPLICATE_REPOSITORY" });
    const invalid = await command(["repo", "add", "zero", "--state", statePath]);
    expect(invalid.exitCode).toBe(2);
    expect(JSON.parse(invalid.stderr)).toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("preserves corrupt state and surfaces external validation errors", async () => {
    const statePath = path.join(root, "corrupt", "state.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, "broken", "utf8");
    const corrupt = await command(["repo", "add", "8", "--state", statePath]);
    expect(corrupt.exitCode).toBe(1);
    expect(JSON.parse(corrupt.stderr)).toMatchObject({ code: "STATE_ERROR" });
    expect(await readFile(statePath, "utf8")).toBe("broken");

    const missing = await command(["repo", "add", "404", "--state", path.join(root, "missing.json")]);
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stderr)).toMatchObject({ code: "CODEHUB_ERROR" });
  });

  it("runs immediately, rejects a second instance, and exits cleanly on SIGTERM", async () => {
    const runtime = path.join(root, "run");
    const statePath = path.join(runtime, "state.json");
    const logPath = path.join(runtime, "events.jsonl");
    await mkdir(runtime, { recursive: true });
    await writeFile(statePath, '{"repositories":{}}\n', "utf8");
    const child = spawn(
      process.execPath,
      [cli, "run", "--interval", "5s", "--state", statePath, "--log", logPath],
      {
        cwd: root,
        env: { ...process.env, REVIEWX_CODEHUB_BIN: fakeCodeHub },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    await waitForFileText(logPath, /"scan_finished"/u);
    const second = await command([
      "run",
      "--interval",
      "5s",
      "--state",
      statePath,
      "--log",
      path.join(runtime, "second.jsonl"),
    ]);
    expect(second.exitCode).toBe(1);
    expect(JSON.parse(second.stderr)).toMatchObject({ code: "LOCK_ERROR" });
    child.kill("SIGTERM");
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
    );
    if (process.platform === "win32") {
      expect(closed).toMatchObject({ code: null, signal: "SIGTERM" });
    } else {
      expect(closed.code).toBe(130);
    }
    const file = await readFile(logPath, "utf8");
    expect(Buffer.concat(stdout).toString("utf8")).toBe(file);
    if (process.platform === "win32") {
      await writeFile(statePath, "broken", "utf8");
      const recovered = await command([
        "run",
        "--interval",
        "5s",
        "--state",
        statePath,
        "--log",
        path.join(runtime, "recovery.jsonl"),
      ]);
      expect(recovered.exitCode).toBe(1);
    }
    await expect(readFile(path.join(runtime, "reviewx.run.lock"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
