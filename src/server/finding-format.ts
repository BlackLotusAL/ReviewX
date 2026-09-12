import type { ReviewerFinding } from "@/src/shared/types";
import type { StructuredFinding } from "./schemas";

const labels = { fatal: "🔴 Fatal", major: "🟠 Major", minor: "🟡 Minor", suggestion: "🟢 Suggestion" };
const literal = (value: string) => value.replace(/([\\`*_{}\[\]<>()#!|])/gu, "\\$1").replace(/[\r\n]+/gu, " ");

export function formatFinding(value: StructuredFinding): ReviewerFinding {
  const locations = value.locations.map(location => {
    const ref = value.evidence[location.evidenceIndex];
    return `- ${literal(ref.side)}: ${literal(ref.path)}:${ref.startLine}-${ref.endLine} — ${literal(location.symbol)}`;
  }).join("\n");
  const body = [`### ${labels[value.severity]}: ${literal(value.title)}`,
    "#### 问题描述", value.description, "#### 问题位置", locations,
    "#### 影响分析", value.impact, "#### 解决方案", value.solution, "#### 预防措施", value.prevention].join("\n\n");
  return { severity: value.severity, body, confidence: value.confidence, verificationSummary: value.verificationSummary, evidence: value.evidence };
}
