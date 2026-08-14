import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mergeRequestSchema, repositorySchema } from "../src/contracts.js";
import { z } from "zod";
import { DefaultCommandRunner } from "../src/process.js";

const runner = new DefaultCommandRunner();
const codehub = process.env.REVIEWX_CODEHUB_BIN ?? "codehub";
const opencode = process.env.REVIEWX_OPENCODE_BIN ?? "opencode";

async function success(command: string, args: string[], env = process.env) {
  return await runner.run(command, args, { env, timeoutMs: 60_000 });
}

let version;
try {
  version = await success(codehub, ["--version"]);
} catch {
  process.stdout.write("SKIP: codehub is not installed or executable.\n");
  process.exit(0);
}
if (version.exitCode !== 0) {
  process.stdout.write("SKIP: codehub is not available.\n");
  process.exit(0);
}

const repoId = process.env.REVIEWX_SMOKE_REPO_ID;
if (!repoId) {
  process.stdout.write("SKIP: REVIEWX_SMOKE_REPO_ID is not set.\n");
  process.exit(0);
}

const auth = await success(codehub, ["auth", "status", "--output", "json"]);
if (auth.exitCode !== 0) {
  process.stdout.write("SKIP: codehub is not authenticated.\n");
  process.exit(0);
}

try {
  const view = await success(codehub, ["repo", "view", repoId, "--output", "json"]);
  if (view.exitCode !== 0) throw new Error("codehub repo view failed");
  const repository = repositorySchema.parse(JSON.parse(view.stdout));
  const list = await success(codehub, [
    "mr",
    "list",
    "--project-id",
    repoId,
    "--state",
    "open",
    "--output",
    "json",
  ]);
  if (list.exitCode !== 0) throw new Error("codehub mr list failed");
  z.array(mergeRequestSchema).parse(JSON.parse(list.stdout));

  const cloneUrl = repository.clone_urls.ssh ?? repository.clone_urls.https ?? repository.clone_urls.http;
  if (!cloneUrl) throw new Error("repository has no usable clone URL");
  const git = await success(process.env.REVIEWX_GIT_BIN ?? "git", ["ls-remote", cloneUrl, "HEAD"]);
  if (git.exitCode !== 0) throw new Error("read-only Git access failed");

  const configDir = fileURLToPath(new URL("../opencode/", import.meta.url));
  await access(path.join(configDir, "agents", "review-judge.md"));
  const agents = await success(opencode, ["agent", "list"], {
    ...process.env,
    OPENCODE_CONFIG_DIR: configDir,
  });
  if (agents.exitCode !== 0) throw new Error("OpenCode agent discovery failed");
  for (const agent of ["design-reviewer", "business-reviewer", "code-reviewer", "review-judge"]) {
    if (!agents.stdout.includes(agent)) throw new Error(`OpenCode did not discover ${agent}`);
  }
  process.stdout.write("Read-only live smoke check passed; no comment command was invoked.\n");
} catch (error) {
  process.stderr.write(`Live smoke check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
