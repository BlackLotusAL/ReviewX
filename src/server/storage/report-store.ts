import { mkdir, readFile, realpath, lstat, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MergeRequestSnapshot, ReviewerResult, ReviewAttempt } from "@/src/shared/types";
import { AppError } from "../errors";
import type { PreparedReview } from "../integrations/git";
import type { DataPaths } from "../platform/paths";

function inlineCode(value: string): string {
  const runs = value.match(/`+/gu) ?? [];
  const size = Math.max(1, ...runs.map((run) => run.length + 1));
  const fence = "`".repeat(size);
  return `${fence} ${value} ${fence}`;
}

async function assertContained(root: string, target: string): Promise<string> {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  const fromRoot = relative(realRoot, realTarget);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new AppError({
      code: "UNSAFE_FILE_PATH",
      message: "ReviewX 拒绝读取数据目录外的文件。",
      reason: "解析后的文件路径越过 ReviewX 数据目录。",
      impact: "文件内容未返回给网页。",
      nextStep: "检查本地状态中的文件引用。",
      technical: "Resolved path containment check failed.",
      httpStatus: 403,
    });
  }
  return realTarget;
}

export async function readContainedFile(root: string, relativePath: string): Promise<string> {
  if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\")) {
    throw new AppError({
      code: "UNSAFE_FILE_PATH",
      message: "ReviewX 拒绝无效文件引用。",
      reason: "文件引用不是数据目录内的相对路径。",
      impact: "文件内容未返回给网页。",
      nextStep: "检查本地状态中的文件引用。",
      technical: "Stored path was absolute or traversed upward.",
      httpStatus: 403,
    });
  }
  const target = resolve(root, relativePath.replace(/\//gu, sep));
  return readFile(await assertContained(root, target), "utf8");
}

export class ReportStore {
  constructor(private readonly paths: DataPaths) {}

  async save(
    attempt: ReviewAttempt,
    details: MergeRequestSnapshot,
    prepared: Pick<PreparedReview, "sourceSha" | "targetSha" | "baseSha">,
    result: ReviewerResult,
  ): Promise<string> {
    const directory = resolve(this.paths.reports, attempt.id);
    if (!/^[a-zA-Z0-9_-]+$/u.test(attempt.id)) throw new Error("Invalid attempt ID");
    const staging = resolve(this.paths.reports, `.pending-${attempt.id}-${randomUUID()}`);
    const target = resolve(directory, "report.md");
    const fromRoot = relative(this.paths.root, target);
    if (!fromRoot || isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error("Report escaped data root.");
    await assertContained(this.paths.root, this.paths.reports);
    const relativeTarget = fromRoot.split(sep).join("/");
    const lines = [
      "# ReviewX Report",
      "",
      `- Attempt ID: ${inlineCode(attempt.id)}`,
      `- Project ID: ${inlineCode(attempt.projectId)}`,
      `- MR IID: ${inlineCode(attempt.mrIid)}`,
      `- Updated at: ${inlineCode(details.updatedAt)}`,
      `- Source: ${inlineCode(details.sourceBranch)} (${inlineCode(prepared.sourceSha)})`,
      `- Target: ${inlineCode(details.targetBranch)} (${inlineCode(prepared.targetSha)})`,
      `- Base: ${inlineCode(prepared.baseSha)}`,
      `- Result: **${result.submission.completion === "incomplete" ? "PARTIAL" : result.findings.length === 0 ? "PASS" : "FINDINGS"}**`,
      "",
    ];
    const limitations = result.execution?.progress.limitations ?? [];
    if (limitations.length) {
      lines.push("## Review limitations", "", "Result applies only to the supported review scope.", "",
        ...limitations.map(limitation => `- ${inlineCode(limitation)}`), "");
    }
    if (result.findings.length === 0) {
      lines.push("No findings.", "");
    } else {
      lines.push("## Findings", "");
      result.findings.forEach((finding, index) => {
        lines.push(`## ${index + 1}. ${finding.severity}`, "", finding.body, "");
      });
    }
    const files: Record<string, string> = {
      "report.md": `${lines.join("\n")}\n`,
      "submission.v1.json": JSON.stringify(result.submission, null, 2),
      "execution.v1.json": JSON.stringify(result.execution, null, 2),
    };
    const existingMatches = async () => {
      const entry = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (!entry) return false;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Invalid existing report directory");
      for (const [file, content] of Object.entries(files)) {
        const filePath = resolve(directory, file);
        const fileEntry = await lstat(filePath);
        if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) throw new Error("Invalid existing report file");
        if (await readFile(await assertContained(this.paths.root, filePath), "utf8") !== content) throw new Error("Existing immutable report differs from this result");
      }
      return true;
    };
    try {
      if (await existingMatches()) return relativeTarget;
      await mkdir(staging, { recursive: false });
      for (const [file, content] of Object.entries(files)) await writeFile(resolve(staging, file), content, { encoding: "utf8", flag: "wx" });
      try { await rename(staging, directory); }
      catch (error) {
        if (!(await existingMatches())) throw error;
        await rm(staging, { recursive: true, force: true });
      }
      return relativeTarget;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw new AppError({
        code: "REPORT_WRITE_ERROR",
        message: "ReviewX 无法保存 Markdown 报告。",
        reason: "唯一 attempt 报告文件无法创建。",
        impact: "本次 attempt 不会进入可发布状态。",
        nextStep: "检查 ReviewX reports 目录权限和磁盘空间后重新检视。",
        technical: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  }

  async read(relativePath: string): Promise<string> {
    return readContainedFile(this.paths.root, relativePath);
  }

  async execution(reportPath: string): Promise<import("@/src/shared/types").AttemptView["execution"]> {
    try {
      const record = JSON.parse(await readContainedFile(this.paths.root, reportPath.replace(/report\.md$/u, "execution.v1.json")));
      if (record.version !== 1 || record.status !== "ACCEPTED") return undefined;
      const { version, status, actualModel, sessionID, durationMs, progress, opencodeVersion } = record;
      return { version, status, actualModel, sessionID, durationMs, progress, opencodeVersion };
    } catch { return undefined; }
  }
}
