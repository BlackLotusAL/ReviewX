import { z } from "zod";
import type { ReviewSubmission } from "@/src/shared/review-contract";
import { REVIEW_LIMITS } from "./materials";

export const submissionSchema = z.strictObject({
  contractVersion: z.literal("reviewx-review/1"), completion: z.enum(["complete", "incomplete"]), blockers: z.array(z.string().max(4096)).max(100),
  findings: z.array(z.strictObject({ severity: z.enum(["fatal", "major", "minor", "suggestion"]),
    body: z.string().refine((s) => !!s.trim() && !s.includes("\0") && Buffer.byteLength(s) <= REVIEW_LIMITS.bodyBytes),
    changeIds: z.array(z.string().min(1).max(128)).min(1).max(1000), evidence: z.array(z.strictObject({
      revision: z.enum(["source", "base"]), path: z.string().max(4096), startLine: z.number().int().positive(), endLine: z.number().int().positive(),
    }).refine((e) => e.endLine >= e.startLine)).min(1).max(1000),
  })).max(REVIEW_LIMITS.findings),
});

// Both directions are checked so schema and public contract cannot drift.
type Assert<T extends true> = T;

export type SubmissionContractMatchesSchema = Assert<
  z.infer<typeof submissionSchema> extends ReviewSubmission
    ? ReviewSubmission extends z.infer<typeof submissionSchema> ? true : false
    : false
>;

export const findingSchema = submissionSchema.shape.findings.element;
export const submissionEnvelopeSchema = submissionSchema.extend({ findings: z.array(z.unknown()).max(REVIEW_LIMITS.findings) });
