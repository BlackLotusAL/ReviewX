export type Revision = "source" | "base";
export type Severity = "fatal" | "major" | "minor" | "suggestion";
export interface CodeExample { language: string; code: string }
export interface ReviewAnnotation { line: number; text: string }
export interface ReviewLocation {
  path: string; revision: Revision; startLine: number; endLine: number;
  snippet?: CodeExample;
  annotations?: ReviewAnnotation[];
}
export interface SolutionStep { description: string; path?: string; example?: CodeExample }
export interface ReviewSolution {
  description: string;
  /** Retained for historical findings; new examples belong to individual steps. */
  example?: CodeExample;
  kind?: "recommended" | "alternative";
  steps?: SolutionStep[];
  applicability?: string;
}
export interface StructuredFinding {
  severity: Severity;
  title: string;
  tags: string[];
  description: string;
  locations: ReviewLocation[];
  impact: { direct: string; scope: string; trigger: string };
  solutions: ReviewSolution[];
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
export interface ReviewPerformance {
  httpRequests: number;
  generationRequests: number;
  observedModelSteps: number;
  providerAttempts: number | null;
  tokens: { input: number | null; output: number | null; reasoning: number | null; cacheRead: number | null; cacheWrite: number | null };
  toolCalls: number;
  repeatedReads: number;
  eventStreamInterrupted: boolean;
  reconciliationFailed: boolean;
  traceWriteFailed: boolean;
}
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
  performance?: ReviewPerformance;
}
