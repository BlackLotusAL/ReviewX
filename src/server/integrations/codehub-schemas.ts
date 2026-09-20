import { z } from "zod";
import { positiveIdSchema, credentialFreeHttpsUrlSchema } from "../validation";
import { severityValues } from "@/src/shared/types";

export const codeHubRepoSchema = z.object({
  web_url: z.string(),
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

export type CodeHubRepo = z.infer<typeof codeHubRepoSchema>;
export type CodeHubMrListEntry = z.infer<typeof codeHubMrListEntrySchema>;
export type CodeHubMr = z.infer<typeof codeHubMrSchema>;
export type CodeHubComment = z.infer<typeof codeHubCommentSchema>;
