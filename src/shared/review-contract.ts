export type Revision = "source" | "base";
export type Severity = "fatal" | "major" | "minor" | "suggestion";
export interface CodeExample { language: string; code: string }
export interface StructuredFinding {
  severity: Severity;
  title: string;
  tags: string[];
  description: string;
  locations: Array<{ path: string; revision: Revision; startLine: number; endLine: number; snippet?: CodeExample }>;
  impact: { direct: string; scope: string; trigger: string };
  solutions: Array<{ description: string; example?: CodeExample }>;
  preventions: string[];
}
export interface ReviewDocument {
  schemaVersion: 1;
  summary: string;
  completion: "complete" | "incomplete";
  limitations: string[];
  findings: StructuredFinding[];
}
export type ReviewSubmission = ReviewDocument;
export interface ReviewScope { sourceSha: string; targetSha: string; baseSha: string; changedPaths: string[] }
export interface RuleResource { id: string; body: string; resourceHash: string }
export interface FrozenRules { profileHash: string; resources: RuleResource[]; warnings?: string[] }
export interface ReviewProgress { activity: string; limitations: string[] }
export interface ExecutionRecord {
  version: 2;
  attemptId: string;
  sessionID: string;
  opencodeVersion: string;
  actualModel: { providerID: string; modelID: string };
  workflowVersion: string;
  scope: ReviewScope;
  rules: FrozenRules;
  progress: ReviewProgress;
  durationMs: number;
  status: "ACCEPTED";
  warnings: string[];
  metrics?: Record<string, number>;
}
