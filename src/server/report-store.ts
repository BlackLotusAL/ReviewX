import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MergeRequestSnapshot, ReviewerResult, ReviewAttempt } from "@/src/shared/types";
import { AppError } from "./errors";
import type { PreparedReview } from "./git";
import type { DataPaths } from "./paths";

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
    prepared: PreparedReview,
    result: ReviewerResult,
  ): Promise<string> {
    const directory = resolve(this.paths.reports, attempt.id);
    const target = resolve(directory, "report.md");
    const lines = [
      "# ReviewX Report",
      "",
      `- Attempt ID: ${inlineCode(attempt.id)}`,
      `- Project ID: ${inlineCode(attempt.projectId)}`,
      `- MR IID: ${inlineCode(attempt.mrIid)}`,
      `- Updated at: ${inlineCode(details.updatedAt)}`,
      `- Source: ${inlineCode(details.sourceBranch)} (${inlineCode(prepared.sourceSha)})`,
      `- Target: ${inlineCode(details.targetBranch)} (${inlineCode(prepared.targetSha)})`,
      `- Result: **${result.findings.length === 0 ? "PASS" : "FINDINGS"}**`,
      "",
    ];
    if (result.findings.length === 0) {
      lines.push("No findings.", "");
    } else {
      lines.push("## Findings", "");
      result.findings.forEach((finding, index) => {
        lines.push(`## ${index + 1}. ${finding.severity}`, "", finding.body, "");
      });
    }
    try {
      await mkdir(directory, { recursive: false });
      await writeFile(target, `${lines.join("\n").trimEnd()}\n`, { encoding: "utf8", flag: "wx" });
      const fromRoot = relative(this.paths.root, target);
      if (!fromRoot || isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error("Report escaped data root.");
      return fromRoot.split(sep).join("/");
    } catch (error) {
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
}
