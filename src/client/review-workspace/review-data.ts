import type { AppStateView, MrDetailView, SafeErrorView } from "@/src/shared/types";

export interface ReviewPreviewData {
  referenceTime: string;
  state: AppStateView;
  details: Record<string, MrDetailView>;
  reports: Record<string, string>;
}

interface ReviewDataSource {
  readonly readOnly: boolean;
  readState(): Promise<AppStateView>;
  readMr(projectId: string, mrIid: string): Promise<MrDetailView>;
  readReport(url: string): Promise<string>;
  mutate(url: string, method: "POST" | "PATCH" | "DELETE", body: unknown): Promise<AppStateView>;
}

interface ApiFailure { error?: SafeErrorView }

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json() as T & ApiFailure;
  if (!response.ok) throw body.error ?? new Error(`HTTP ${response.status}`);
  return body;
}

export const liveReviewData: ReviewDataSource = {
  readOnly: false,
  readState: () => requestJson<AppStateView>("/api/state"),
  readMr: (projectId, mrIid) => requestJson<MrDetailView>(`/api/mrs/${encodeURIComponent(projectId)}/${encodeURIComponent(mrIid)}`),
  async readReport(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      const failure = await response.json() as ApiFailure;
      throw failure.error ?? new Error(`HTTP ${response.status}`);
    }
    return response.text();
  },
  mutate: (url, method, body) => requestJson<AppStateView>(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
};

export function createPreviewDataSource(data: ReviewPreviewData): ReviewDataSource {
  const snapshot = structuredClone(data);
  return {
    readOnly: true,
    async readState() { return structuredClone(snapshot.state); },
    async readMr(projectId, mrIid) {
      const detail = snapshot.details[`${projectId}/${mrIid}`];
      if (!detail) throw new Error("预览中没有该 MR。");
      return structuredClone(detail);
    },
    async readReport(url) {
      const report = snapshot.reports[url];
      if (typeof report !== "string") throw new Error("预览中没有该报告。");
      return report;
    },
    // There is deliberately no network fallback, including for write attempts.
    async mutate() { return structuredClone(snapshot.state); },
  };
}
