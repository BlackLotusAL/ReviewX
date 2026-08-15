import path from "node:path";
import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const singleLine = nonEmpty.refine((value) => !/[\r\n]/u.test(value), "must be one line");

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
    http: z.string().trim().min(1).nullable().optional(),
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

export const commentCommandOutputSchema = z
  .object({
    comment_id: nonEmpty.nullable(),
    repo_id: positiveIdSchema,
    mr_iid: positiveIdSchema,
    severity: z.enum(["suggestion", "minor", "major", "fatal"]),
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

export const severitySchema = z.enum(["Blocker", "Critical", "Major", "Minor"]);
export type Severity = z.infer<typeof severitySchema>;

export const standardTags = [
  "security",
  "correctness",
  "business-rule",
  "concurrency",
  "transaction",
  "performance",
  "resource-leak",
  "compatibility",
  "api-contract",
  "architecture",
  "maintainability",
  "test-coverage",
  "observability",
] as const;
const standardTagSet = new Set<string>(standardTags);

export const tagSchema = singleLine.refine(
  (value) => standardTagSet.has(value) || /^domain:[a-z0-9][a-z0-9._-]*$/u.test(value),
  "tag is not controlled",
);

const relativeFileSchema = singleLine.refine(
  (value) =>
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/u).some((segment) => segment === "..") &&
    value !== ".",
  "file must be a safe relative path",
);

export const evidenceSchema = z.strictObject({
  file: relativeFileSchema,
  line: z.number().int().positive(),
  description: nonEmpty,
});

export const findingSchema = z
  .strictObject({
    title: singleLine,
    file: relativeFileSchema,
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    severity: severitySchema,
    tags: z.array(tagSchema).min(1),
    rule_ids: z.array(singleLine),
    problem: nonEmpty,
    trigger: nonEmpty,
    impact: nonEmpty,
    evidence: z.array(evidenceSchema).min(1),
    recommendation: nonEmpty,
    confidence: z.number().int().min(0).max(100),
  })
  .refine((value) => value.end_line >= value.start_line, {
    message: "end_line must be greater than or equal to start_line",
    path: ["end_line"],
  });
export type Finding = z.infer<typeof findingSchema>;

export const expertNameSchema = z.enum([
  "design-reviewer",
  "business-reviewer",
  "code-reviewer",
]);
export type ExpertName = z.infer<typeof expertNameSchema>;

const findingsResultSchema = z.strictObject({
  expert: expertNameSchema,
  verdict: z.literal("findings"),
  findings: z.array(findingSchema).min(1),
});
const emptyExpertResultSchema = z.strictObject({
  expert: expertNameSchema,
  verdict: z.enum(["pass", "insufficient_evidence"]),
  findings: z.array(findingSchema).length(0),
});
export const expertResultSchema = z.discriminatedUnion("verdict", [
  findingsResultSchema,
  emptyExpertResultSchema,
]);
export type ExpertResult = z.infer<typeof expertResultSchema>;

export const selectedFindingSchema = findingSchema.safeExtend({
  example_code: z.string().trim().min(1),
});
export type SelectedFinding = z.infer<typeof selectedFindingSchema>;

export const judgeResultSchema = z.discriminatedUnion("verdict", [
  z.strictObject({ verdict: z.literal("pass") }),
  z.strictObject({
    verdict: z.literal("duplicate_of"),
    duplicate_comment_id: z.string().trim().min(1).nullable(),
  }),
  z.strictObject({
    verdict: z.literal("new"),
    selected_finding: selectedFindingSchema,
    comment_markdown: z.string().trim().min(1),
  }),
]);
export type JudgeResult = z.infer<typeof judgeResultSchema>;

export const findingHistorySchema = z.strictObject({
  summary: z.strictObject({
    title: z.string(),
    file: z.string(),
    problem: z.string(),
  }),
  publication_status: z.enum(["confirmed", "unknown"]),
  comment_id: z.string().nullable(),
});
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

export const judgeInputSchema = expertInputSchema.safeExtend({
  expert_results: z.array(expertResultSchema).length(3),
  finding_history: z.array(findingHistorySchema),
});
export type JudgeInput = z.infer<typeof judgeInputSchema>;

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

export interface LogRecord {
  time: string;
  level: "info" | "error";
  event:
    | "scan_started"
    | "repository_scan_failed"
    | "review_run_started"
    | "review_run_finished"
    | "scan_finished"
    | "runtime_error";
  run_id?: string;
  repo_id?: string;
  mr_iid?: string;
  updated_at?: string;
  result?: ReviewResult;
  error?: string;
  duplicate_of_comment_id?: string | null;
  comment_id?: string | null;
}

export const severityToCodeHub = {
  Blocker: "fatal",
  Critical: "major",
  Major: "minor",
  Minor: "suggestion",
} as const satisfies Record<Severity, "suggestion" | "minor" | "major" | "fatal">;

export function emptyState(): State {
  return { repositories: {} };
}
