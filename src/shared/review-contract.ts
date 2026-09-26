export type Revision = "source" | "base";
export type ReviewChange = { changeId: string; type: string; oldPath?: string; newPath?: string; diffPages: number;
  diffHash: string; hunks: Array<{ baseStart: number; baseCount: number; sourceStart: number; sourceCount: number }>; unsupported?: string };
export type ReviewScope = { targetSha: string; sourceSha: string; baseSha: string; changes: ReviewChange[]; scopeHash: string };
export type RuleResource = { id: string; version: string; body: string; resourceHash: string };
export type FrozenRules = { profileHash: string; resources: RuleResource[] };
export type ReviewProgress = { toolCount: number; deliveredMaterials: number; requiredMaterials: number; limitations: string[] };
export type Receipt = { sessionID: string; messageID: string; callID: string; tool: string; inputHash: string; outputHash: string;
  material?: string; evidence?: { revision: Revision; sha: string; path: string; startLine: number; endLine: number } };
export type ReviewDiagnostic = { code: string; message: string; tool?: string; callID?: string; findingIndex?: number };
export type ExecutionRecord = { version: 1; attemptId: string; sessionID: string; protocol: string; toolVersion: string; opencodeVersion: string;
  actualModel: { providerID: string; modelID: string }; scope: ReviewScope; rules: FrozenRules; submittedPromptHash: string;
  diagnostics?: ReviewDiagnostic[]; receipts: Receipt[]; progress: ReviewProgress; durationMs: number; status: "ACCEPTED";
  terminal: { finalMessageID: string; finish: "stop"; completedAt: number; idle: true; processExited: true; bridgeClosed: true };
  allowedTools: string[]; permissionHash: string };

export interface ReviewSubmission {
  contractVersion: "reviewx-review/1";
  completion: "complete" | "incomplete";
  blockers: string[];
  findings: Array<{
    severity: "fatal" | "major" | "minor" | "suggestion";
    body: string;
    changeIds: string[];
    evidence: Array<{ revision: Revision; path: string; startLine: number; endLine: number }>;
  }>;
}
