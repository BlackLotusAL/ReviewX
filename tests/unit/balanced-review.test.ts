import { expect, test } from "vitest";
import { runBalanced, candidatesFrom, type Generation } from "@/src/server/review/balanced";
import { ReviewTrace } from "@/src/server/review/trace";
import { timedProgress } from "@/src/server/review/progress";
import { structuredFinding } from "../helpers/runtime";

const discovery = (count: number) => ({ schemaVersion: 1, summary: "全部检视", completion: "complete", limitations: [],
  findings: Array.from({ length: count }, (_, i) => structuredFinding(`问题 ${i}`)) });
const decode = (prompt: string) => JSON.parse(prompt.split("\nCandidates:\n")[1]) as Array<{ id: string; finding: ReturnType<typeof structuredFinding> }>;
const response = (value: unknown): Generation => ({ text: JSON.stringify(value) });

test("batch size four, host concurrency two, output stays in discovery order", async () => {
  let active = 0, maximum = 0;
  const sizes: number[] = [];
  const result = await runBalanced({ signal: new AbortController().signal, trace: new ReviewTrace("test"), progress: () => {},
    generate: async (agent, prompt) => {
      if (agent === "reviewx-discover") return response(discovery(11));
      const batch = decode(prompt); sizes.push(batch.length); maximum = Math.max(maximum, ++active);
      await new Promise(r => setTimeout(r, batch[0].id === "c1" ? 20 : 1)); active--;
      return response({ verdicts: batch.map(c => ({ ...c, status: "confirmed", evidence: "核对调用方与基线" })) });
    } });
  expect(sizes).toEqual([4, 4, 3]); expect(maximum).toBe(2);
  expect(result.document.findings).toEqual(discovery(11).findings);
  expect(result.document.completion).toBe("complete");
});
test("only exact duplicates collapse, retaining all source ordinals", () => {
  const findings = [structuredFinding("a"), structuredFinding("a"), structuredFinding("b")];
  expect(candidatesFrom(findings).map(c => c.sourceOrdinals)).toEqual([[1, 2], [3]]);
});
test("missing, duplicate and malformed verdicts get one focused recheck; failures cannot PASS", async () => {
  const batches: string[][] = [];
  const result = await runBalanced({ signal: new AbortController().signal, trace: new ReviewTrace("test"), progress: () => {},
    generate: async (agent, prompt) => {
      if (agent === "reviewx-discover") return response(discovery(3));
      const batch = decode(prompt); batches.push(batch.map(c => c.id));
      if (batch.length === 1) return response({ verdicts: [] });
      const confirmed = { ...batch[0], status: "confirmed", evidence: "证据" };
      return response({ verdicts: [confirmed, confirmed, { ...batch[1], status: "rejected", evidence: "已有防护" }] });
    } });
  expect(batches).toEqual([["c1", "c2", "c3"], ["c1"], ["c3"]]);
  expect(result.document.completion).toBe("incomplete");
  expect(result.document.findings).toEqual([]);
  expect(result.document.limitations).toHaveLength(2);
});
test("empty fully covered discovery needs no verification", async () => {
  let calls = 0;
  const result = await runBalanced({ signal: new AbortController().signal, trace: new ReviewTrace("test"), progress: () => {},
    generate: async () => { calls++; return response(discovery(0)); } });
  expect(calls).toBe(1); expect(result.document.completion).toBe("complete");
});
test("format repair is attempted at most once and cannot bless invalid coverage", async () => {
  const agents: string[] = [];
  const result = await runBalanced({ signal: new AbortController().signal, trace: new ReviewTrace("test"), progress: () => {},
    generate: async agent => { agents.push(agent); return { text: "invalid" }; } });
  expect(agents).toEqual(["reviewx-discover", "reviewx-format"]);
  expect(result.document.completion).toBe("incomplete");
});
test("semantic dedup requires an independently confirmed nonduplicate target", async () => {
  const result = await runBalanced({ signal: new AbortController().signal, trace: new ReviewTrace("test"), progress: () => {},
    generate: async (agent, prompt) => agent === "reviewx-discover" ? response(discovery(2)) : response({ verdicts: decode(prompt).map((c, i) => ({
      ...c, status: "confirmed", evidence: "同一根因", ...(i ? { duplicateOf: "c1" } : {}),
    })) }) });
  expect(result.document.findings).toHaveLength(1);
});
test("cancellation propagates and never produces a partial PASS", async () => {
  const controller = new AbortController();
  await expect(runBalanced({ signal: controller.signal, trace: new ReviewTrace("test"), progress: () => {},
    generate: async () => { controller.abort(new Error("stopped")); return response(discovery(0)); } })).rejects.toThrow("stopped");
});
test("five minute target only decorates progress; remaining work remains visible", () => {
  const progress = { activity: "独立复核：剩余 3 / 8 个候选", limitations: [] };
  expect(timedProgress(progress, 299999)).toEqual(progress);
  expect(timedProgress(progress, 300000).activity).toContain("继续完成检视");
  expect(timedProgress(progress, 300001).activity).toContain("剩余 3 / 8");
});
