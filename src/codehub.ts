import { z } from "zod";
import {
  codeHubErrorSchema,
  commentCommandOutputSchema,
  commentResultSchema,
  commitSchema,
  mergeRequestSchema,
  repositorySchema,
  type CodeHubErrorBody,
  type CommentResult,
  type Commit,
  type MergeRequest,
  type Repository,
} from "./contracts.js";
import { redactText, ReviewXError } from "./errors.js";
import { DefaultCommandRunner, type CommandRunner } from "./process.js";

export class CodeHubCommandError extends ReviewXError {
  constructor(
    readonly externalCode: string,
    message: string,
    readonly httpStatus?: number,
  ) {
    super("CODEHUB_ERROR", message, {
      details: { external_code: externalCode, ...(httpStatus === undefined ? {} : { http_status: httpStatus }) },
    });
    this.name = "CodeHubCommandError";
  }
}

function parseError(stderr: string): CodeHubErrorBody | undefined {
  try {
    return codeHubErrorSchema.parse(JSON.parse(stderr));
  } catch {
    return undefined;
  }
}

export class CodeHubClient {
  constructor(
    private readonly runner: CommandRunner = new DefaultCommandRunner(),
    private readonly executable = process.env.REVIEWX_CODEHUB_BIN ?? "codehub",
    private readonly timeoutMs = 60_000,
  ) {}

  private async json<T>(
    args: readonly string[],
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const result = await this.runner.run(this.executable, args, {
      timeoutMs: this.timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.exitCode !== 0) {
      const body = parseError(result.stderr.trim());
      if (body) {
        throw new CodeHubCommandError(body.code, redactText(body.message), body.http_status);
      }
      throw new CodeHubCommandError(
        "UNCLASSIFIED_ERROR",
        `CodeHub CLI failed with exit code ${result.exitCode ?? "unknown"}.`,
      );
    }
    if (result.stderr.trim() !== "") {
      throw new CodeHubCommandError("INVALID_OUTPUT", "CodeHub CLI wrote to stderr on success.");
    }
    try {
      return schema.parse(JSON.parse(result.stdout));
    } catch (error) {
      throw new CodeHubCommandError(
        "INVALID_OUTPUT",
        `CodeHub CLI returned invalid JSON for ${args.slice(0, 3).join(" ")}.`,
      );
    }
  }

  async repoView(repoId: string, signal?: AbortSignal): Promise<Repository> {
    return await this.json(
      ["repo", "view", repoId, "--output", "json"],
      repositorySchema,
      signal,
    );
  }

  async mrList(repoId: string, signal?: AbortSignal): Promise<MergeRequest[]> {
    return await this.json(
      ["mr", "list", "--project-id", repoId, "--state", "open", "--output", "json"],
      z.array(mergeRequestSchema),
      signal,
    );
  }

  async mrView(repoId: string, mrIid: string, signal?: AbortSignal): Promise<MergeRequest> {
    return await this.json(
      ["mr", "view", mrIid, "--project-id", repoId, "--output", "json"],
      mergeRequestSchema,
      signal,
    );
  }

  async mrCommits(repoId: string, mrIid: string, signal?: AbortSignal): Promise<Commit[]> {
    return await this.json(
      ["mr", "commits", mrIid, "--project-id", repoId, "--output", "json"],
      z.array(commitSchema),
      signal,
    );
  }

  async createComment(
    repoId: string,
    mrIid: string,
    body: string,
    severity: "suggestion" | "minor" | "major" | "fatal",
    signal?: AbortSignal,
  ): Promise<CommentResult> {
    const result = await this.json(
      [
        "mr",
        "comment",
        "create",
        mrIid,
        "--project-id",
        repoId,
        "--body",
        JSON.stringify(body),
        "--severity",
        severity,
        "--output",
        "json",
      ],
      commentCommandOutputSchema,
      signal,
    );
    if (result.comment_id === null) {
      throw new CodeHubCommandError(
        "WRITE_RESULT_UNKNOWN",
        "CodeHub CLI reported comment success without a comment ID.",
      );
    }
    return commentResultSchema.parse(result);
  }
}
