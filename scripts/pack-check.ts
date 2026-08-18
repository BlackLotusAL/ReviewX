import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { DefaultCommandRunner } from "../src/process.js";

const runner = new DefaultCommandRunner();
const root = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), "reviewx-pack-"));

async function requireSuccess(
  command: string,
  args: string[],
  cwd = root,
  env = process.env,
): Promise<void> {
  const result = await runner.run(command, args, { cwd, env, timeoutMs: 5 * 60_000 });
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
}

async function waitForText(target: string, expected: RegExp): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const value = await readFile(target, "utf8");
      if (expected.test(value)) return value;
    } catch {
      // The installed process has not created the log yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for packed CLI scan log: ${target}`);
}

try {
  await requireSuccess("pnpm", ["build"]);
  await requireSuccess("pnpm", ["pack", "--pack-destination", temp]);
  const tarball = (await readdir(temp)).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack did not create a tarball.");
  const installRoot = path.join(temp, "install");
  await mkdir(installRoot, { recursive: true });
  await requireSuccess("npm", ["init", "--yes"], installRoot);
  await requireSuccess(
    "npm",
    ["install", "--ignore-scripts", path.join(temp, tarball)],
    installRoot,
  );
  const bin = path.join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "reviewx.cmd" : "reviewx",
  );
  await requireSuccess(bin, ["--help"], installRoot);
  const fakeSource = path.join(temp, "fake-codehub.mjs");
  await writeFile(
    fakeSource,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({repo_id:"1",full_name:"test/repo",clone_urls:{ssh:null,https:"https://example.test/repo.git"},archived:false,updated_at:"2026-08-12T00:00:00Z",default_branch:"main",web_url:null}) + "\\n");
  process.exit(0);
}
if (args[0] === "mr" && args[1] === "list") {
  process.stdout.write("[]\\n");
  process.exit(0);
}
process.stderr.write(JSON.stringify({code:"UNEXPECTED",message:args.join(" ")}) + "\\n");
process.exit(2);
`,
    "utf8",
  );
  await chmod(fakeSource, 0o755);
  let fakeBin = fakeSource;
  if (process.platform === "win32") {
    fakeBin = path.join(temp, "fake-codehub.cmd");
    await writeFile(fakeBin, `@"${process.execPath}" "${fakeSource}" %*\r\n`, "utf8");
  }
  const statePath = path.join(temp, "packed-runtime", "state.json");
  await requireSuccess(
    bin,
    ["repo", "add", "0001", "--state", statePath],
    installRoot,
    { ...process.env, REVIEWX_CODEHUB_BIN: fakeBin },
  );
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (!state.repositories?.["1"]) throw new Error("Packed CLI did not persist normalized repo ID.");
  for (const agent of ["design-reviewer", "business-reviewer", "code-reviewer", "review-judge"]) {
    await access(path.join(installRoot, "node_modules", "reviewx", "opencode", "agents", `${agent}.md`));
  }

  const logPath = path.join(temp, "packed-runtime", "reviewx.log");
  const installedCli = path.join(installRoot, "node_modules", "reviewx", "dist", "cli.js");
  const child = crossSpawn(
    process.execPath,
    [
      installedCli,
      "run",
      "--interval",
      "10m",
      "--agent-timeout",
      "1s",
      "--state",
      statePath,
      "--log",
      logPath,
    ],
    {
      cwd: installRoot,
      env: { ...process.env, REVIEWX_CODEHUB_BIN: fakeBin },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  await waitForText(logPath, /\[INFO\] \[scan_finished\]/u);
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  child.kill("SIGTERM");
  await closed;
  const logLines = (await readFile(logPath, "utf8")).trim().split(/\r?\n/u);
  if (!logLines.some((line) => line.includes("[INFO] [scan_started]"))) {
    throw new Error(`Packed CLI did not start a scan: ${Buffer.concat(stderr).toString("utf8")}`);
  }
  process.stdout.write("Package install check passed.\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}
