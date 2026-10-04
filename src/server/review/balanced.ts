import { z } from "zod";
import type { ReviewDocument, StructuredFinding } from "@/src/shared/review-contract";
import { generatedFindingSchema, outputSchema, parseReviewOutput } from "./schema";
import type { ReviewTrace } from "./trace";
import { digest as digestEvidence } from "./materials";

export const VERIFY_BATCH_SIZE = 4;
export const VERIFY_CONCURRENCY = 2;
export interface Candidate { id: string; finding: StructuredFinding; sourceOrdinals: number[] }
const verdictSchema = z.object({
  id: z.string().min(1), status: z.enum(["confirmed", "rejected", "unverified"]),
  evidence: z.string().trim().min(1).max(64 * 1024), finding: generatedFindingSchema.optional(), duplicateOf: z.string().optional(),
}).refine(v => v.status !== "confirmed" || !!v.finding, "Confirmed verdict requires a complete finding")
  .refine(v => !v.duplicateOf || v.status === "confirmed", "Only confirmed verdicts may be duplicates");
export type Verdict = z.infer<typeof verdictSchema>;
const verificationSchema = z.object({ verdicts: z.array(verdictSchema) });
const verificationJsonSchema = z.toJSONSchema(verificationSchema);
export interface Generation { text: string; failed?: boolean }
export interface BalancedOptions {
  generate(agent: string, prompt: string): Promise<Generation>;
  signal: AbortSignal;
  trace: ReviewTrace;
  progress(activity: string): void;
}

/** Only exact normalized findings are collapsed. Similar locations are not evidence of duplicate root causes. */
export function candidatesFrom(findings: StructuredFinding[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  findings.forEach((finding, index) => {
    const key = JSON.stringify(finding), prior = seen.get(key);
    if (prior) prior.sourceOrdinals.push(index + 1);
    else seen.set(key, { id: `c${index + 1}`, finding, sourceOrdinals: [index + 1] });
  });
  return [...seen.values()];
}
function parseVerdicts(raw: string, expected: Candidate[]): Map<string, Verdict> {
  const result = new Map<string, Verdict>(), counts = new Map<string, number>();
  try {
    const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/u.exec(raw);
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) return result;
    const envelope = JSON.parse(fenced?.[1] ?? raw);
    if (!Array.isArray(envelope?.verdicts)) return result;
    for (const item of envelope.verdicts) {
      if (typeof item?.id === "string") counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
      const parsed = verdictSchema.safeParse(item);
      if (parsed.success && expected.some(c => c.id === parsed.data.id)) {
        if (parsed.data.finding) parsed.data.finding.tags = [...new Set(parsed.data.finding.tags)];
        result.set(parsed.data.id, parsed.data);
      }
    }
    for (const [id, count] of counts) if (count !== 1) result.delete(id);
    for (const [id, verdict] of result) {
      if (!verdict.duplicateOf) continue;
      const target = result.get(verdict.duplicateOf);
      if (verdict.duplicateOf === id || !target || target.status !== "confirmed" || target.duplicateOf) result.delete(id);
    }
  } catch { /* Invalid or missing items are independently retried, never silently accepted. */ }
  return result;
}

export async function runBalanced(options: BalancedOptions): Promise<{ document: ReviewDocument; raw: string; repairRaw?: string }> {
  const { generate, signal, trace, progress } = options;
  progress("综合检视：检查全部变更和适用规则");
  const discovered = await generate("reviewx-discover", "Review the fixed change. Return candidates using this schema:\n" + JSON.stringify(outputSchema));
  let parsed = parseReviewOutput(discovered.text), repairRaw: string | undefined;
  // The only format-model repair in this workflow. Parsing fences and schema normalization are local.
  if (parsed.errors.length && !signal.aborted) {
    const end = trace.span("format_repair");
    try {
      const repaired = await generate("reviewx-format", "Repair only the supplied JSON; preserve facts. Schema:\n" + JSON.stringify(outputSchema) +
        "\nInput:\n" + (parsed.envelopeValid ? JSON.stringify({ ...parsed.document, findings: parsed.invalid }) : discovered.text));
      repairRaw = repaired.text;
      const fixed = parseReviewOutput(repairRaw);
      if (!repaired.failed && fixed.envelopeValid) {
        if (parsed.envelopeValid) {
          const lost = fixed.document.findings.length < parsed.invalid.length;
          parsed = { ...fixed, document: { ...parsed.document, findings: [...parsed.document.findings, ...fixed.document.findings],
            completion: lost || parsed.document.completion === "incomplete" || fixed.document.completion === "incomplete" ? "incomplete" : "complete",
            limitations: [...parsed.document.limitations, ...fixed.document.limitations, ...(lost ? ["部分候选缺少必要事实，未能恢复。"] : [])] } };
        } else parsed = fixed;
      }
      end(repaired.failed ? "failed" : "complete");
    } catch { signal.throwIfAborted(); end("failed"); }
  }
  signal.throwIfAborted();
  const document = parsed.document;
  if (discovered.failed || parsed.errors.length || !parsed.envelopeValid) {
    document.completion = "incomplete";
    document.limitations.push("综合检视或候选结构未完整完成。");
  }
  const endDedup = trace.span("candidate_dedup");
  const candidates = candidatesFrom(document.findings);
  trace.emit("candidates", { raw: document.findings.length, unique: candidates.length,
    mapping: candidates.map(c => ({ id: c.id, sourceOrdinals: c.sourceOrdinals })) });
  endDedup();
  const batches: Candidate[][] = [];
  for (let i = 0; i < candidates.length; i += VERIFY_BATCH_SIZE) batches.push(candidates.slice(i, i + VERIFY_BATCH_SIZE));
  const verdicts = new Map<string, Verdict>();
  let next = 0, remaining = candidates.length;
  const verify = async (batch: Candidate[]): Promise<Map<string, Verdict>> => {
    signal.throwIfAborted();
    const end = trace.span("verification_batch", { candidateIds: batch.map(c => c.id) });
    try {
      const response = await generate("reviewx-batch-verify", "Independently verify these candidates. Schema:\n" + JSON.stringify(verificationJsonSchema) +
        "\nCandidates:\n" + JSON.stringify(batch.map(({ id, finding }) => ({ id, finding: { ...finding,
          locations: finding.locations.map(({ path, revision, startLine, endLine, annotations, highlights, label }) => ({ path, revision, startLine, endLine, annotations, highlights, label })),
          solutions: finding.solutions.map(({ kind, description, applicability, steps }) => ({ kind, description, applicability,
            steps: steps?.map(({ description, path }) => ({ description, path })),
          })),
        } }))));
      end(response.failed ? "failed" : "complete");
      return response.failed ? new Map() : parseVerdicts(response.text, batch);
    } catch { signal.throwIfAborted(); end("failed"); return new Map(); }
  };
  const worker = async () => {
    while (next < batches.length) {
      signal.throwIfAborted();
      const batch = batches[next++];
      progress(`独立复核：剩余 ${remaining} / ${candidates.length} 个候选`);
      const results = await verify(batch);
      // One fresh, focused recheck for each missing/malformed verdict. No unbounded retry loop.
      for (const candidate of batch) {
        let verdict = results.get(candidate.id);
        if (!verdict) {
          trace.emit("verification.missing_retry", { candidateId: candidate.id });
          verdict = (await verify([candidate])).get(candidate.id);
        }
        verdict ??= { id: candidate.id, status: "unverified", evidence: "批量及单项复核均未返回有效结论。" };
        verdicts.set(candidate.id, verdict);
        trace.emit("candidate.verdict", { candidateId: candidate.id, status: verdict.status, duplicateOf: verdict.duplicateOf,
          evidenceHash: digestEvidence(verdict.evidence) });
        remaining--;
        progress(`独立复核：剩余 ${remaining} / ${candidates.length} 个候选`);
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(VERIFY_CONCURRENCY, batches.length) }, worker));
  signal.throwIfAborted();
  const failure = settled.find(r => r.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  document.findings = [];
  for (const candidate of candidates) {
    const verdict = verdicts.get(candidate.id)!;
    if (verdict.status === "confirmed" && !verdict.duplicateOf) document.findings.push(verdict.finding!);
    if (verdict.status === "unverified") {
      document.completion = "incomplete";
      document.limitations.push(`${candidate.id} 未完成独立复核：${verdict.evidence}`);
    }
  }
  // Keep every unverified id in the public result, without allowing long evidence to overflow its schema.
  if (document.limitations.length > 100) {
    const unverifiedIds = [...verdicts.values()].filter(v => v.status === "unverified").map(v => v.id);
    document.limitations = ["未完成独立复核的候选：" + unverifiedIds.join(", "), ...document.limitations.slice(0, 99)];
  }
  trace.emit("verification.summary", { confirmed: [...verdicts.values()].filter(v => v.status === "confirmed").length,
    rejected: [...verdicts.values()].filter(v => v.status === "rejected").length, unverified: [...verdicts.values()].filter(v => v.status === "unverified").length });
  return { document, raw: discovered.text, repairRaw };
}
