import { z } from "zod";

const nonEmpty = z.string().trim().min(1);

export const positiveIdSchema = z
  .string()
  .regex(/^\d+$/u, "must be a positive integer string")
  .refine((value) => BigInt(value) > 0n, "must be greater than zero");

export function normalizePositiveId(value: string): string {
  return BigInt(positiveIdSchema.parse(value)).toString();
}

export const cloneUrlsSchema = z
  .object({
    ssh: z.string().trim().min(1).nullable().optional(),
    https: z.string().trim().min(1).nullable().optional(),
  })
  .passthrough();

export const repositorySchema = z
  .object({
    repo_id: positiveIdSchema,
    full_name: z.string().nullish(),
    clone_urls: cloneUrlsSchema,
    archived: z.boolean().nullish(),
    updated_at: z.string().nullish(),
    default_branch: z.string().nullable().optional(),
    web_url: z.string().nullable().optional(),
  })
  .passthrough();
export type Repository = z.infer<typeof repositorySchema>;

export const mergeRequestSchema = z
  .object({
    repo_id: positiveIdSchema,
    mr_id: positiveIdSchema.nullable(),
    iid: positiveIdSchema,
    title: z.string().nullable(),
    state: z.string(),
    is_draft: z.boolean().nullable(),
    author: z.unknown(),
    source_branch: nonEmpty,
    target_branch: nonEmpty,
    updated_at: nonEmpty,
    web_url: z.string().nullable(),
  })
  .passthrough();
export type MergeRequest = z.infer<typeof mergeRequestSchema>;

export const commitSchema = z
  .object({
    sha: nonEmpty.nullable(),
    title: z.string().nullable(),
    message: z.string().nullable(),
    author: z.unknown(),
    committer: z.unknown(),
    authored_at: z.string().nullable(),
    committed_at: z.string().nullable(),
    parent_shas: z.array(z.string()).nullable(),
  })
  .passthrough();
export type Commit = z.infer<typeof commitSchema>;

export const severitySchema = z.enum(["fatal", "major", "minor", "suggestion"]);
export type Severity = z.infer<typeof severitySchema>;

export const commentCommandOutputSchema = z
  .object({
    comment_id: nonEmpty.nullable(),
    repo_id: positiveIdSchema,
    mr_iid: positiveIdSchema,
    severity: severitySchema,
    resolved: z.boolean().nullable(),
    web_url: z.string().nullable(),
  })
  .passthrough();

export const commentResultSchema = z
  .object({
    ...commentCommandOutputSchema.shape,
    comment_id: nonEmpty,
  })
  .passthrough();
export type CommentResult = z.infer<typeof commentResultSchema>;

export const codeHubErrorSchema = z
  .object({
    code: nonEmpty,
    message: nonEmpty,
    http_status: z.number().int().optional(),
  })
  .passthrough();
export type CodeHubErrorBody = z.infer<typeof codeHubErrorSchema>;

export const expertNameSchema = z.enum([
  "design-reviewer",
  "business-reviewer",
  "code-reviewer",
]);
export type ExpertName = z.infer<typeof expertNameSchema>;

export const judgeDecisionSchema = z.discriminatedUnion("verdict", [
  z.strictObject({ verdict: z.literal("PASS") }),
  z.strictObject({
    verdict: z.literal("DUPLICATE"),
    duplicate_comment_id: z.string().trim().min(1).nullable(),
  }),
  z.strictObject({
    verdict: z.literal("NEW"),
    severity: severitySchema,
  }),
]);
export type JudgeDecision = z.infer<typeof judgeDecisionSchema>;

export interface ExpertReport {
  expert: ExpertName;
  markdown: string;
}

export interface JudgeReport {
  decision: JudgeDecision;
  markdown: string;
  document: string;
}

export const legacyFindingHistorySchema = z.strictObject({
  summary: z.strictObject({
    title: z.string(),
    file: z.string(),
    problem: z.string(),
  }),
  publication_status: z.enum(["confirmed", "unknown"]),
  comment_id: z.string().nullable(),
});

export const markdownFindingHistorySchema = z.strictObject({
  review_markdown: nonEmpty,
  publication_status: z.enum(["confirmed", "unknown"]),
  comment_id: z.string().nullable(),
});

export const findingHistorySchema = z.union([
  legacyFindingHistorySchema,
  markdownFindingHistorySchema,
]);
export type FindingHistory = z.infer<typeof findingHistorySchema>;

export const mergeRequestStateSchema = z.strictObject({
  last_processed_updated_at: z.string().optional(),
  finding_history: z.array(findingHistorySchema),
});
export type MergeRequestState = z.infer<typeof mergeRequestStateSchema>;

export const repositoryStateSchema = z.strictObject({
  merge_requests: z.record(z.string(), mergeRequestStateSchema),
});
export type RepositoryState = z.infer<typeof repositoryStateSchema>;

export const stateSchema = z.strictObject({
  repositories: z.record(z.string(), repositoryStateSchema),
});
export type State = z.infer<typeof stateSchema>;

export const expertInputSchema = z.strictObject({
  repo_id: positiveIdSchema,
  mr_iid: positiveIdSchema,
  merge_request: mergeRequestSchema,
  source_branch: nonEmpty,
  target_branch: nonEmpty,
  worktree_path: nonEmpty,
  commits: z.array(commitSchema),
});
export type ExpertInput = z.infer<typeof expertInputSchema>;

export const judgeContextSchema = expertInputSchema.safeExtend({
  finding_history: z.array(findingHistorySchema),
});
export type JudgeContext = z.infer<typeof judgeContextSchema>;

export const reviewResultSchema = z.enum([
  "pass",
  "duplicate_of",
  "new",
  "publication_unknown",
  "updated",
  "closed",
  "failed",
]);
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export type AgentOutputSource = "assistant_text" | "opencode_stdout";

export function emptyState(): State {
  return { repositories: {} };
}
