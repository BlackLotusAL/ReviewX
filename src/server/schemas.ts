import { z } from "zod";
import { severityValues } from "@/src/shared/types";
import { isReviewPath } from "./review-context";

export const positiveIdSchema = z.string().regex(/^[1-9]\d*$/u);

export function isCredentialFreeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export const credentialFreeHttpsUrlSchema = z.string().url().refine(isCredentialFreeHttpsUrl, "URL must be credential-free HTTPS");

export const codeHubRepoSchema = z.object({
  repo_id: positiveIdSchema.optional(),
  clone_urls: z.object({
    https: z.string().url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    }, "clone URL must be credential-free HTTPS"),
  }),
}).passthrough();

export const codeHubMrListEntrySchema = z.object({
  iid: positiveIdSchema,
  title: z.string().trim().min(1),
}).passthrough();

export const codeHubMrListSchema = z.array(codeHubMrListEntrySchema);

export const codeHubMrSchema = z.object({
  repo_id: positiveIdSchema.optional(),
  iid: positiveIdSchema,
  title: z.string().optional(),
  state: z.string().min(1),
  source_branch: z.string().min(1),
  target_branch: z.string().min(1),
  updated_at: z.string().min(1),
  web_url: credentialFreeHttpsUrlSchema,
}).passthrough();

export const codeHubCommentSchema = z.object({
  comment_id: z.string().min(1),
  repo_id: positiveIdSchema.optional(),
  mr_iid: positiveIdSchema.optional(),
  severity: z.enum(severityValues).optional(),
}).passthrough();

export const codeHubErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  http_status: z.number().int().optional(),
}).passthrough();

const reviewText = z.string().min(1).refine(value => value.trim().length > 0 && !value.includes("\0"), "non-empty safe text required");
export const reviewEvidenceSchema = z.strictObject({
  side: z.enum(["source", "base"]),
  path: z.string().min(1).refine(isReviewPath, "relative repository path required"),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).refine(value => value.endLine >= value.startLine, "invalid line range");
export const reviewerFindingSchema = z.strictObject({
  severity: z.enum(severityValues), body: reviewText,
  confidence: z.number().int().min(0).max(100),
  verificationSummary: reviewText,
  evidence: z.array(reviewEvidenceSchema).min(1),
});
export const reviewerResultSchema = z.strictObject({
  findings: z.array(reviewerFindingSchema),
  limitations: z.array(reviewText).optional(),
});
export const reviewCheckpointSchema = z.strictObject({
  status: z.enum(["complete", "needs_context"]),
  nextChecks: z.array(reviewText),
  findings: z.array(reviewerFindingSchema),
  limitations: z.array(reviewText),
}).superRefine((value, context) => {
  if (value.status === "complete" && value.nextChecks.length !== 0) context.addIssue({ code: "custom", path: ["nextChecks"], message: "complete requires no outstanding checks" });
  if (value.status === "needs_context" && (value.nextChecks.length === 0 || value.findings.length !== 0)) context.addIssue({ code: "custom", message: "needs_context requires outstanding checks and no publishable findings" });
});

export const reviewCheckpointJsonSchema = z.toJSONSchema(reviewCheckpointSchema, { target: "draft-7" });

export type CodeHubRepo = z.infer<typeof codeHubRepoSchema>;
export type CodeHubMrListEntry = z.infer<typeof codeHubMrListEntrySchema>;
export type CodeHubMr = z.infer<typeof codeHubMrSchema>;
export type CodeHubComment = z.infer<typeof codeHubCommentSchema>;
