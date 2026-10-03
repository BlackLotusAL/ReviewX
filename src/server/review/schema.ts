import { z } from "zod";
import type { ReviewDocument } from "@/src/shared/review-contract";
import { safeRepositoryPath } from "./materials";

const text = z.string().trim().min(1).max(64 * 1024).refine(s => !s.includes("\0"));
const example = z.object({ language: z.string().max(64), code: z.string().min(1).max(64 * 1024) });
export const findingSchema = z.object({
  severity: z.enum(["fatal", "major", "minor", "suggestion"]),
  title: text, tags: z.array(text).max(32), description: text,
  locations: z.array(z.object({
    path: z.string().refine(safeRepositoryPath, "Use a relative repository path"),
    revision: z.enum(["source", "base"]),
    startLine: z.number().int().positive(), endLine: z.number().int().positive(), snippet: example.optional(),
  }).refine(l => l.endLine >= l.startLine, "endLine must follow startLine")).min(1).max(100),
  impact: z.object({ direct: text, scope: text, trigger: text }),
  solutions: z.array(z.object({ description: text, example: example.optional() })).min(1).max(20),
  preventions: z.array(text).min(1).max(20),
});
export const submissionSchema = z.object({
  schemaVersion: z.literal(1), summary: text,
  completion: z.enum(["complete", "incomplete"]), limitations: z.array(text).max(100),
  findings: z.array(findingSchema).max(100),
});
const envelopeSchema = submissionSchema.extend({ findings: z.array(z.unknown()).max(100) });
export const outputSchema = z.toJSONSchema(submissionSchema);

/** Only a whole JSON document, optionally fenced, is an output; never a chat fragment. */
export function parseReviewOutput(raw: string): { document: ReviewDocument; errors: string[]; invalid: unknown[]; envelopeValid: boolean } {
  const errors: string[] = [], invalid: unknown[] = [];
  const empty: ReviewDocument = { schemaVersion: 1, summary: "检视输出未完整。", completion: "incomplete", limitations: [], findings: [] };
  try {
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error("Output exceeds 4 MiB");
    const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/u.exec(raw);
    const envelope = envelopeSchema.parse(JSON.parse(fenced?.[1] ?? raw));
    const findings: ReviewDocument["findings"] = [];
    envelope.findings.forEach((item, i) => {
      const parsed = findingSchema.safeParse(item);
      if (parsed.success) findings.push(parsed.data);
      else { invalid.push(item); errors.push("findings[" + i + "]: " + parsed.error.issues.map(e => e.path.join(".") + ": " + e.message).join("; ")); }
    });
    return { document: { ...envelope, findings }, errors, invalid, envelopeValid: true };
  } catch (error) {
    return { document: empty, errors: [error instanceof Error ? error.message : String(error)], invalid: [], envelopeValid: false };
  }
}
