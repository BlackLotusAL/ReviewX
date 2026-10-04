import { z } from "zod";
import type { ReviewDocument } from "@/src/shared/review-contract";
import { FINDING_DESCRIPTION_LIMIT, FINDING_TAGS, SOURCE_SNIPPET_LINE_LIMIT } from "@/src/shared/review-output-policy";
import { safeRepositoryPath } from "./materials";

const text = z.string().trim().min(1).max(64 * 1024).refine(s => !s.includes("\0"));
const example = z.object({ language: z.string().max(64), code: z.string().min(1).max(64 * 1024) });
const repositoryPath = z.string().refine(safeRepositoryPath, "Use a relative repository path");
const annotation = z.object({ line: z.number().int().positive(), text });
const highlight = z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() });
const location = z.object({
  path: repositoryPath, revision: z.enum(["source", "base"]),
  startLine: z.number().int().positive(), endLine: z.number().int().positive(), snippet: example.optional(),
  annotations: z.array(annotation).max(SOURCE_SNIPPET_LINE_LIMIT).optional(),
  highlights: z.array(highlight).max(SOURCE_SNIPPET_LINE_LIMIT).optional(),
  label: text.optional(),
});
const step = z.object({ description: text, path: repositoryPath.optional(), example: example.optional() });
const solution = z.object({
  description: text, example: example.optional(),
  kind: z.enum(["recommended", "alternative"]).optional(),
  steps: z.array(step).min(1).max(100).optional(), applicability: text.optional(),
});
export const findingSchema = z.object({
  severity: z.enum(["fatal", "major", "minor", "suggestion"]),
  title: text, tags: z.array(text).max(32), description: text,
  locations: z.array(location.refine(l => l.endLine >= l.startLine, "endLine must follow startLine")).min(1).max(100),
  impact: z.object({ direct: text, scope: text, trigger: text }),
  solutions: z.array(solution).min(1).max(20),
  preventions: z.array(text).min(1).max(20),
});
const generatedLocation = location.extend({
  label: text.max(40).regex(/^[^\r\n\u2028\u2029]+$/u, "Use a single paragraph").optional().describe("Optional short source context, e.g. read() 新增块 or cleanup()."),
  highlights: z.array(highlight).max(SOURCE_SNIPPET_LINE_LIMIT)
    .describe("Independent problem ranges using ORIGINAL one-based source lines. Each range must satisfy startLine <= endLine and fit inside the location's first 40 displayed source lines. Do not infer ranges from explanation positions."),
  annotations: z.array(annotation.extend({
    text: text.max(120).regex(/^[^\r\n\u2028\u2029]+$/u, "Use a single paragraph")
      .describe("A short Chinese explanation of this actual source line, at most 120 characters. No comment syntax or Markdown; the host inserts the annotation."),
  })).min(1).max(SOURCE_SNIPPET_LINE_LIMIT)
    .describe("Annotate the actual problem lines using ORIGINAL one-based line numbers. Each line must fall within startLine..min(endLine, startLine+39); create another location for more distant lines."),
}).refine(l => l.endLine >= l.startLine, "endLine must follow startLine")
  .refine(l => l.highlights.every(h => h.startLine >= l.startLine && h.endLine >= h.startLine && h.endLine <= Math.min(l.endLine, l.startLine + SOURCE_SNIPPET_LINE_LIMIT - 1)),
    { message: "Highlights must reference complete displayed original source ranges", path: ["highlights"] })
  .refine(l => l.annotations.every(a => a.line >= l.startLine && a.line <= Math.min(l.endLine, l.startLine + SOURCE_SNIPPET_LINE_LIMIT - 1)),
    { message: "Annotations must reference displayed original source lines", path: ["annotations"] });
const generatedStep = z.strictObject({
  description: text, path: repositoryPath.optional(),
  example: example.optional().describe("For branches, control flow or resource management provide the smallest applicable corrected source with necessary context and target path; a whole function is not required. Simple exact import/name/type/constant replacements may use precise textual instructions without duplicate code. Never use problem markers, invented APIs or ellipses."),
}).refine(s => !s.example || !!s.path, { message: "A code example requires its target repository path", path: ["path"] });
const generatedSolution = z.strictObject({
  kind: z.enum(["recommended", "alternative"]), description: text,
  steps: z.array(generatedStep).min(1).max(100).describe("Required coordinated edits within ONE complete strategy. Separate file-specific changes into steps; do not label required steps as alternative strategies."),
  applicability: text.optional().describe("Required for an alternative: explain when it can replace the recommended strategy and its tradeoffs."),
}).refine(s => s.kind !== "alternative" || !!s.applicability, { message: "An alternative requires applicability and tradeoffs", path: ["applicability"] });
/** Stronger generation rules must never invalidate an already persisted finding. */
export const generatedFindingSchema = findingSchema.extend({
  description: text.max(FINDING_DESCRIPTION_LIMIT).regex(/^[^\r\n\u2028\u2029]+$/u, "Use a single paragraph")
    .refine(value => value.split(/(?:[。！？!?]+[”’」』）)]*|\.(?=\s|$))/u).filter(part => part.trim()).length <= 2, "Use at most two sentences")
    .describe("Plain Chinese, 1–2 sentences, one paragraph, at most 120 characters: cause and core consequence only. Put evidence, callers, scope and triggers in locations/impact instead."),
  tags: z.array(z.enum(FINDING_TAGS)).max(32).describe("Chinese categories only; choose applicable categories without duplicates. May be empty."),
  locations: z.array(generatedLocation).min(1).max(100)
    .describe("At least one location must have a problem highlight. Evidence-only contexts may use empty highlights; never mark normal supporting code as erroneous. Select concise source ranges; same-file ranges are grouped by the host.")
    .refine(locations => locations.some(l => l.highlights.length > 0), "A finding requires at least one problem highlight"),
  solutions: z.array(generatedSolution).min(1).max(20)
    .describe("Exactly one recommended strategy, FIRST. Further items may only be genuine interchangeable alternatives, each with applicability. Do not force alternatives; all necessary coordinated edits belong to the recommended strategy's steps.")
    .refine(s => s[0]?.kind === "recommended" && s.filter(v => v.kind === "recommended").length === 1, "Exactly one recommended solution must be first"),
});
export const submissionSchema = z.object({
  schemaVersion: z.literal(1), summary: text,
  completion: z.enum(["complete", "incomplete"]), limitations: z.array(text).max(100),
  findings: z.array(findingSchema),
});
const envelopeSchema = submissionSchema.extend({ findings: z.array(z.unknown()) });
export const outputSchema = z.toJSONSchema(submissionSchema.extend({ findings: z.array(generatedFindingSchema) }));

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
      const parsed = generatedFindingSchema.safeParse(item);
      if (parsed.success) findings.push({ ...parsed.data, tags: [...new Set(parsed.data.tags)] });
      else { invalid.push(item); errors.push("findings[" + i + "]: " + parsed.error.issues.map(e => e.path.join(".") + ": " + e.message).join("; ")); }
    });
    return { document: { ...envelope, findings }, errors, invalid, envelopeValid: true };
  } catch (error) {
    return { document: empty, errors: [error instanceof Error ? error.message : String(error)], invalid: [], envelopeValid: false };
  }
}
