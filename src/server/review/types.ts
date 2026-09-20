import type { ReviewScope, Revision } from "@/src/shared/review-contract";

export type TextPage = { startLine: number; endLine: number; content: string; hash: string };

export interface FixedContext {
  scope: ReviewScope;
  diff(changeId: string): TextPage[];
  read(revision: Revision, path: string, signal: AbortSignal): Promise<TextPage[]>;
  search(revision: Revision, query: string, offset: number, signal: AbortSignal): Promise<{ matches: Array<{ path: string; line: number }>; nextOffset: number | null; limitations: string[] }>;
}

export type NativeMessage = { info: { id: string; sessionID: string; role: string; error?: unknown; modelID?: string; providerID?: string; finish?: string; time?: { completed?: number } };
  parts: Array<{ type: string; tool?: string; callID?: string; sessionID?: string; messageID?: string; state?: { status: string; input: unknown; output?: string } }> };
