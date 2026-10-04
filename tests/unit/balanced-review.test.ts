import { expect, test } from "vitest";
import { runBalanced, candidatesFrom, type Generation } from "@/src/server/review/balanced";
import { ReviewTrace } from "@/src/server/review/trace";
import { timedProgress } from "@/src/server/review/progress";
import { generatedFinding as structuredFinding } from "../helpers/runtime";

const discovery = (count: number) => ({ schemaVersion: 1, summary: "全部检视", completion: "complete", limitations: [],
  findings: Array.from({ length: count }, (_, i) => structuredFinding(`问题 ${i}`)) });
const decode = (prompt: string) => JSON.parse(prompt.split("\nCandidates:\n")[1]) as Array<{ id: string; finding: ReturnType<typeof structuredFinding> }>;
const response = (value: unknown): Generation => ({ text: JSON.stringify(value) });

test("independent verification keeps annotations and strategy steps, excluding candidate code", async () => {
  const finding = structuredFinding();
  finding.locations[0].label = "调用入口";
  finding.locations[0].snippet = { language: "ts", code: "candidate_source();" };
  finding.solutions[0].steps![0].example = { language: "ts", code: "candidate_fix();" };
  finding.solutions.push({ kind: "alternative", description: "替代策略", applicability: "允许迁移接口时适用。", steps: [{ description: "迁移接口。", path: "caller.ts" }] });
  const result = await runBalanced({ signal: new AbortController().signal, trace: new ReviewTrace("test"), progress: () => {},
    generate: async (agent, prompt) => {
      if (agent === "reviewx-discover") return response({ ...discovery(0), findings: [finding] });
      expect(prompt).not.toContain("candidate_source();"); expect(prompt).not.toContain("candidate_fix();");
      const batch = decode(prompt);
      expect(batch[0].finding.locations[0].label).toEqual(finding.locations[0].label);
      expect(batch[0].finding.locations[0].highlights).toEqual(finding.locations[0].highlights);
      expect(batch[0].finding.locations[0].annotations).toEqual(finding.locations[0].annotations);
      expect(batch[0].finding.solutions[1]).toEqual(finding.solutions[1]);
      expect(batch[0].finding.solutions[0].steps![0]).toEqual({ description: "修正调用结果。", path: "fixture.ts" });
      return response({ verdicts: [{ ...batch[0], status: "confirmed", evidence: "重新核对实际源码" }] });
    } });
  expect(result.document.completion).toBe("complete");
  expect(result.document.findings[0].solutions[1].kind).toBe("alternative");
});

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

test("discovery brief repair preserves valid candidates and confirmed verdicts must use Chinese tags", async () => {
  const agents: string[] = [];
  const result = await runBalanced({ signal: new AbortController().signal, trace: new ReviewTrace("test"), progress: () => {},
    generate: async (agent, prompt) => {
      agents.push(agent);
      if (agent === "reviewx-discover") return response({ ...discovery(1), findings: [structuredFinding("有效简述"), structuredFinding("字".repeat(121))] });
      if (agent === "reviewx-format") {
        const supplied = JSON.parse(prompt.split("\nInput:\n")[1]);
        expect(supplied.findings).toHaveLength(1); expect(supplied.findings[0].description).toHaveLength(121);
        return response({ ...discovery(1), findings: [structuredFinding("精炼后的简述")] });
      }
      const batch = decode(prompt);
      return response({ verdicts: batch.map(c => ({ ...c, finding: { ...c.finding, tags: batch.length === 1 ? ["逻辑错误", "逻辑错误"] : ["bug"] }, status: "confirmed", evidence: "独立核对" })) });
    } });
  expect(agents).toEqual(["reviewx-discover", "reviewx-format", "reviewx-batch-verify", "reviewx-batch-verify", "reviewx-batch-verify"]);
  expect(result.document.completion).toBe("complete");
  expect(result.document.findings.map(f => f.description)).toEqual(["有效简述", "精炼后的简述"]);
  expect(result.document.findings.every(f => JSON.stringify(f.tags) === '["逻辑错误"]')).toBe(true);
});

test("overlong confirmed briefs get one recheck then become unverified, never truncated", async () => {
  let calls = 0;
  const result = await runBalanced({ signal: new AbortController().signal, trace: new ReviewTrace("test"), progress: () => {},
    generate: async (agent, prompt) => {
      calls++;
      if (agent === "reviewx-discover") return response(discovery(1));
      return response({ verdicts: decode(prompt).map(c => ({ ...c, finding: structuredFinding("字".repeat(121)), status: "confirmed", evidence: "证据" })) });
    } });
  expect(calls).toBe(3); expect(result.document.findings).toEqual([]);
  expect(result.document.completion).toBe("incomplete"); expect(result.document.limitations[0]).toContain("c1");
});
