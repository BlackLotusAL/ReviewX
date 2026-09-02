import type { MergeRequestSnapshot, Severity } from "@/src/shared/types";
import { resolveCommand } from "@/src/cli/resolve-command";
import { AppError, isAppError } from "./errors";
import { runProcess, type ProcessResult, type ResolvedCommand } from "./process";
import {
  codeHubCommentSchema,
  codeHubErrorSchema,
  codeHubMrListSchema,
  codeHubMrSchema,
  codeHubRepoSchema,
  type CodeHubComment,
  type CodeHubMr,
  type CodeHubMrListEntry,
} from "./schemas";

const PROCESS_TIMEOUT_MS = 30_000;

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function commandError(operation: string, result: ProcessResult): AppError {
  let externalCode = "CODEHUB_ERROR";
  let reason = "CodeHub CLI 返回失败。";
  let httpStatus: number | undefined;
  try {
    const parsed = codeHubErrorSchema.safeParse(parseJson(result.stderr));
    if (parsed.success) {
      externalCode = parsed.data.code;
      reason = parsed.data.message || reason;
      httpStatus = parsed.data.http_status;
    }
  } catch {
    // Controlled stderr is attached to the diagnostic below.
  }
  if (result.timedOut) reason = "CodeHub 命令执行超时。";
  if (result.aborted) reason = "CodeHub 命令被当前操作取消。";
  if (result.outputLimitExceeded) reason = "CodeHub 命令输出超过安全上限。";
  return new AppError({
    code: externalCode,
    message: `ReviewX 无法完成${operation}。`,
    reason,
    impact: `${operation}未完成，ReviewX 不会自动重试。`,
    nextStep: "检查 CodeHub CLI 配置、认证、网络和目标资源后重新操作。",
    technical: `CodeHub exited with ${String(result.exitCode)}${httpStatus === undefined ? "" : `; HTTP ${httpStatus}`}.`,
    httpStatus: 502,
    stderr: result.stderr,
  });
}

function parseSuccess<T>(
  operation: string,
  result: ProcessResult,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown } },
): T {
  if (result.exitCode !== 0 || result.timedOut || result.aborted || result.outputLimitExceeded) {
    throw commandError(operation, result);
  }
  try {
    const parsed = schema.safeParse(parseJson(result.stdout));
    if (parsed.success) return parsed.data;
    throw new Error(String(parsed.error));
  } catch (error) {
    throw new AppError({
      code: "CODEHUB_INVALID_RESPONSE",
      message: `ReviewX 无法解析${operation}结果。`,
      reason: "CodeHub CLI 成功输出不符合 PRD JSON 契约。",
      impact: `${operation}未完成，既有本地数据保持不变。`,
      nextStep: "确认 CodeHub CLI 版本兼容后重新操作。",
      technical: error instanceof Error ? error.message : String(error),
      httpStatus: 502,
      cause: error,
    });
  }
}

export function normalizeCommentBody(body: string): string {
  return body.replace(/\r\n|\r|\n/gu, "\r\n");
}

export function isOpenMrState(state: string): boolean {
  const normalized = state.trim().toLowerCase();
  return normalized === "open" || normalized === "opened";
}

export function projectNameFromCloneUrl(cloneUrl: string): string {
  const url = new URL(cloneUrl);
  const decoded = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "");
  if (!decoded) throw new Error("Clone URL does not contain a repository path.");
  return decoded;
}

export type CommentCreateResult =
  | { kind: "success"; comment: CodeHubComment }
  | { kind: "failed"; error: AppError }
  | { kind: "unknown"; error: AppError };

export interface CodeHubPort {
  viewRepo(projectId: string, signal?: AbortSignal): Promise<{ cloneUrl: string; name: string }>;
  listOpenMrs(projectId: string, signal?: AbortSignal): Promise<CodeHubMrListEntry[]>;
  viewMr(projectId: string, mrIid: string, title?: string, signal?: AbortSignal): Promise<MergeRequestSnapshot>;
  createComment(projectId: string, mrIid: string, body: string, severity: Severity): Promise<CommentCreateResult>;
}

export class CodeHubClient implements CodeHubPort {
  #command?: Promise<ResolvedCommand>;

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async #resolved(): Promise<ResolvedCommand> {
    this.#command ??= resolveCommand("codehub", this.environment);
    return this.#command;
  }

  async #run(args: string[], signal?: AbortSignal): Promise<ProcessResult> {
    return runProcess(await this.#resolved(), args, {
      timeoutMs: PROCESS_TIMEOUT_MS,
      env: this.environment,
      signal,
      maxOutputBytes: 16 * 1024 * 1024,
    });
  }

  async viewRepo(projectId: string, signal?: AbortSignal): Promise<{ cloneUrl: string; name: string }> {
    const repo = parseSuccess("Project 验证", await this.#run(["repo", "view", projectId, "--output", "json"], signal), codeHubRepoSchema);
    if (repo.repo_id !== undefined && repo.repo_id !== projectId) {
      throw new AppError({
        code: "CODEHUB_IDENTITY_MISMATCH",
        message: "CodeHub 返回了不匹配的 Project。",
        reason: "repo view 响应中的 Project ID 与请求不一致。",
        impact: "Project 未添加。",
        nextStep: "核对 Project ID 和 CodeHub CLI 配置后重试。",
        technical: `Expected Project ${projectId}; received ${repo.repo_id}.`,
        httpStatus: 502,
      });
    }
    return { cloneUrl: repo.clone_urls.https, name: projectNameFromCloneUrl(repo.clone_urls.https) };
  }

  async listOpenMrs(projectId: string, signal?: AbortSignal): Promise<CodeHubMrListEntry[]> {
    return parseSuccess(
      "open MR 列表读取",
      await this.#run(["mr", "list", "--project-id", projectId, "--state", "open", "--output", "json"], signal),
      codeHubMrListSchema,
    );
  }

  async viewMr(projectId: string, mrIid: string, title?: string, signal?: AbortSignal): Promise<MergeRequestSnapshot> {
    const mr: CodeHubMr = parseSuccess(
      "MR 详情读取",
      await this.#run(["mr", "view", mrIid, "--project-id", projectId, "--output", "json"], signal),
      codeHubMrSchema,
    );
    if ((mr.repo_id !== undefined && mr.repo_id !== projectId) || mr.iid !== mrIid) {
      throw new AppError({
        code: "CODEHUB_IDENTITY_MISMATCH",
        message: "CodeHub 返回了不匹配的 MR。",
        reason: "mr view 响应与请求的 Project 或 MR IID 不一致。",
        impact: "当前操作停止，既有状态保持不变。",
        nextStep: "核对 CodeHub CLI 输出后重试。",
        technical: `Expected ${projectId}!${mrIid}; received ${mr.repo_id ?? projectId}!${mr.iid}.`,
        httpStatus: 502,
      });
    }
    return {
      projectId,
      iid: mrIid,
      title: mr.title?.trim() || title?.trim() || `MR !${mrIid}`,
      state: mr.state,
      updatedAt: mr.updated_at,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
    };
  }

  async createComment(projectId: string, mrIid: string, body: string, severity: Severity): Promise<CommentCreateResult> {
    let result: ProcessResult;
    try {
      result = await this.#run([
        "mr", "comment", "create", mrIid,
        "--project-id", projectId,
        "--body", normalizeCommentBody(body),
        "--severity", severity,
        "--output", "json",
      ]);
    } catch (error) {
      const appError = isAppError(error) ? error : new AppError({
        code: "COMMENT_PROCESS_START_ERROR",
        message: "ReviewX 无法启动评论命令。",
        reason: "CodeHub 评论进程未启动。",
        impact: "该 Finding 明确未发布。",
        nextStep: "修复 CodeHub CLI 后重新检视。",
        technical: error instanceof Error ? error.message : String(error),
        cause: error,
      });
      return { kind: "failed", error: appError };
    }

    if (result.exitCode === 0 && !result.timedOut && !result.aborted && !result.outputLimitExceeded) {
      try {
        const comment = codeHubCommentSchema.parse(parseJson(result.stdout));
        if ((comment.repo_id && comment.repo_id !== projectId) || (comment.mr_iid && comment.mr_iid !== mrIid) || (comment.severity && comment.severity !== severity)) {
          throw new Error("Comment response identity mismatch.");
        }
        return { kind: "success", comment };
      } catch (error) {
        return { kind: "unknown", error: new AppError({
          code: "WRITE_RESULT_UNKNOWN",
          message: "ReviewX 无法确认评论是否已创建。",
          reason: "CodeHub 返回成功退出码，但成功 JSON 无法验证。",
          impact: "该 Finding 记录为 unknown，后续选中项不会执行。",
          nextStep: "在 CodeHub 人工核对评论，再重新检视处理剩余问题。",
          technical: error instanceof Error ? error.message : String(error),
          httpStatus: 502,
          cause: error,
        }) };
      }
    }

    const failure = commandError("Finding 发布", result);
    let knownCode: string | undefined;
    try {
      const parsed = codeHubErrorSchema.safeParse(parseJson(result.stderr));
      if (parsed.success) knownCode = parsed.data.code;
    } catch {
      // An unclassified result from a started write is unknown.
    }
    if (result.started && (result.timedOut || result.aborted || result.outputLimitExceeded || !knownCode || knownCode === "WRITE_RESULT_UNKNOWN")) {
      return { kind: "unknown", error: new AppError({
        ...failure,
        code: "WRITE_RESULT_UNKNOWN",
        message: "ReviewX 无法确认评论是否已创建。",
        reason: failure.reason,
        impact: "该 Finding 记录为 unknown，后续选中项不会执行。",
        nextStep: "在 CodeHub 人工核对评论，再重新检视处理剩余问题。",
        technical: failure.technical,
        httpStatus: 502,
        stderr: failure.stderr,
      }) };
    }
    return { kind: "failed", error: failure };
  }
}
