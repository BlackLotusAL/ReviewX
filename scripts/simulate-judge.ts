import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  judgeContextSchema,
  type ExpertName,
  type FindingHistory,
  type JudgeReport,
} from "../src/contracts.js";
import { OpenCodeClient } from "../src/opencode.js";
import { DefaultCommandRunner } from "../src/process.js";

const runner = new DefaultCommandRunner();
const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
const simulationRoot = path.resolve(
  process.env.REVIEWX_JUDGE_SIMULATION_DIR ??
    path.join("runtime", "judge-simulations", `${timestamp}-${randomUUID().slice(0, 8)}`),
);
const model = process.env.REVIEWX_SIMULATION_MODEL ?? "deepseek/deepseek-chat";
const rawTimeout = process.env.REVIEWX_SIMULATION_AGENT_TIMEOUT_MS ?? "1200000";
const timeoutMs = Number(rawTimeout);

if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error("REVIEWX_SIMULATION_AGENT_TIMEOUT_MS must be a positive integer.");
}

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const result = await runner.run("git", args, {
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Git Judge simulation setup failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

interface Fixture {
  worktree: string;
  benignSha: string;
  bugSha: string;
}

async function createFixture(): Promise<Fixture> {
  const setupRoot = path.join(simulationRoot, "setup");
  const remote = path.join(setupRoot, "remote.git");
  const source = path.join(setupRoot, "source");
  const worktree = path.join(setupRoot, "worktree");
  await mkdir(setupRoot, { recursive: true });
  await git(["init", "--bare", remote]);
  await mkdir(source, { recursive: true });
  await git(["init", "-b", "main"], source);
  await git(["config", "user.name", "ReviewX Judge Simulation"], source);
  await git(["config", "user.email", "reviewx-judge@example.test"], source);
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(
    path.join(source, "src", "withdraw.ts"),
    `export function withdraw(balance: number, amount: number): number {
  if (amount > balance) throw new Error("insufficient funds");
  return balance - amount;
}
`,
    "utf8",
  );
  await writeFile(path.join(source, "README.md"), "# Account service\n", "utf8");
  await git(["add", "."], source);
  await git(["commit", "-m", "base withdrawal invariant"], source);

  await git(["checkout", "-b", "feature/benign"], source);
  await writeFile(
    path.join(source, "README.md"),
    "# Account service\n\nProvides account balance operations.\n",
    "utf8",
  );
  await git(["add", "README.md"], source);
  await git(["commit", "-m", "document account service"], source);
  const benignSha = await git(["rev-parse", "HEAD"], source);

  await git(["checkout", "main"], source);
  await git(["checkout", "-b", "feature/overdraft-bug"], source);
  await writeFile(
    path.join(source, "src", "withdraw.ts"),
    `export function withdraw(balance: number, amount: number): number {
  return balance - amount;
}
`,
    "utf8",
  );
  await git(["add", "src/withdraw.ts"], source);
  await git(["commit", "-m", "simplify withdrawal"], source);
  const bugSha = await git(["rev-parse", "HEAD"], source);
  await git(["remote", "add", "origin", remote], source);
  await git(["push", "origin", "main", "feature/benign", "feature/overdraft-bug"], source);
  await git(["clone", remote, worktree]);
  return { worktree, benignSha, bugSha };
}

const expertNames: ExpertName[] = [
  "design-reviewer",
  "business-reviewer",
  "code-reviewer",
];

const passReports = [
  "# PASS\n\nNo architecture defect is present in the documentation-only change.",
  "# PASS\n\nNo repository-evidenced business invariant is changed.",
  "# PASS\n\nNo correctness defect is present in the documentation-only change.",
];

const findingReports = [
  "# PASS\n\nNo independent architecture issue was found.",
  `# [Major][business-rule] Withdrawal permits an overdraft

- **Location:** \`src/withdraw.ts:2\`
- **Problem:** The final change removes the established insufficient-funds guard.
- **Trigger:** \`amount > balance\`.
- **Impact:** A withdrawal returns a negative balance instead of rejecting the operation.
- **Evidence:** The target branch throws for this condition; the source branch immediately subtracts the amount.
- **Recommendation:** Restore the guard before subtracting.
- **Confidence:** 100`,
  `# [Major][correctness] Missing insufficient-funds guard

The final diff deletes the \`amount > balance\` check in \`src/withdraw.ts\`. Calling \`withdraw(10, 20)\` now returns \`-10\`. Restore the guard. Confidence: 100.`,
];

async function checkout(worktree: string, branch: string): Promise<void> {
  await git(["checkout", "-B", branch, `origin/${branch}`], worktree);
}

async function runCase(
  client: OpenCodeClient,
  fixture: Fixture,
  name: "pass" | "new" | "duplicate",
  branch: string,
  sha: string,
  reports: readonly string[],
  history: readonly FindingHistory[],
): Promise<JudgeReport> {
  await checkout(fixture.worktree, branch);
  const inputDir = path.join(simulationRoot, "inputs", name);
  const artifactDir = path.join(simulationRoot, "agent-output", name);
  await mkdir(inputDir, { recursive: true });
  const context = judgeContextSchema.parse({
    repo_id: "1",
    mr_iid: name === "pass" ? "1" : "2",
    merge_request: {
      repo_id: "1",
      mr_id: name === "pass" ? "1" : "2",
      iid: name === "pass" ? "1" : "2",
      title: name === "pass" ? "Document account service" : "Simplify withdrawal",
      state: "opened",
      is_draft: false,
      author: { name: "ReviewX Simulation" },
      source_branch: branch,
      target_branch: "main",
      updated_at: "2026-08-20T00:00:00Z",
      web_url: null,
    },
    source_branch: branch,
    target_branch: "main",
    worktree_path: fixture.worktree,
    commits: [
      {
        sha,
        title: name === "pass" ? "document account service" : "simplify withdrawal",
        message: name === "pass" ? "document account service" : "simplify withdrawal",
        author: { name: "ReviewX Simulation" },
        committer: { name: "ReviewX Simulation" },
        authored_at: null,
        committed_at: null,
        parent_shas: [],
      },
    ],
    finding_history: history,
  });
  const contextPath = path.join(inputDir, "judge-context.json");
  await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  const reportPaths = await Promise.all(
    expertNames.map(async (expert, index) => {
      const reportPath = path.join(inputDir, `${expert}.md`);
      await writeFile(reportPath, reports[index]!, "utf8");
      return reportPath;
    }),
  );
  return await client.runJudge(fixture.worktree, [contextPath, ...reportPaths], {
    artifactDir,
    timeoutMs,
  });
}

async function main(): Promise<void> {
  await mkdir(simulationRoot, { recursive: true });
  const fixture = await createFixture();
  const client = new OpenCodeClient(
    runner,
    process.env.REVIEWX_OPENCODE_BIN ?? "opencode",
    path.resolve("opencode"),
    model,
  );

  const pass = await runCase(
    client,
    fixture,
    "pass",
    "feature/benign",
    fixture.benignSha,
    passReports,
    [],
  );
  if (pass.decision.verdict !== "pass") {
    throw new Error(`Expected pass verdict, received ${pass.decision.verdict}.`);
  }

  const fresh = await runCase(
    client,
    fixture,
    "new",
    "feature/overdraft-bug",
    fixture.bugSha,
    findingReports,
    [],
  );
  if (fresh.decision.verdict !== "new" || fresh.markdown.trim() === "") {
    throw new Error(`Expected non-empty new verdict, received ${fresh.decision.verdict}.`);
  }

  const duplicate = await runCase(
    client,
    fixture,
    "duplicate",
    "feature/overdraft-bug",
    fixture.bugSha,
    findingReports,
    [
      {
        review_markdown: fresh.markdown,
        publication_status: "confirmed",
        comment_id: "simulation-comment-1",
      },
    ],
  );
  if (
    duplicate.decision.verdict !== "duplicate_of" ||
    duplicate.decision.duplicate_comment_id !== "simulation-comment-1"
  ) {
    throw new Error(
      `Expected duplicate_of simulation-comment-1, received ${JSON.stringify(duplicate.decision)}.`,
    );
  }

  for (const name of ["pass", "new", "duplicate"]) {
    const artifactDir = path.join(simulationRoot, "agent-output", name);
    await access(path.join(artifactDir, "input-manifest.json"));
    await access(path.join(artifactDir, "decision.json"));
    await access(path.join(artifactDir, "report.md"));
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        simulation_dir: simulationRoot,
        model,
        verdicts: {
          pass: pass.decision,
          new: fresh.decision,
          duplicate: duplicate.decision,
        },
        codehub_calls: 0,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Real Judge simulation failed; artifacts preserved at ${simulationRoot}: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
