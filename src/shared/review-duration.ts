import type { MrRowView } from "./types";

export function reviewDuration(row: Pick<MrRowView, "status" | "reviewStartedAt" | "reviewFinishedAt">, now: number): string | null {
  if (row.status === "unreviewed" || row.status === "queued" || (row.status === "stopped" && !row.reviewStartedAt)) return null;
  const start = Date.parse(row.reviewStartedAt ?? "");
  const running = row.status === "reviewing" || row.status === "stopping";
  const end = row.reviewFinishedAt ? Date.parse(row.reviewFinishedAt) : running ? now : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const tail = `${String(seconds % 60).padStart(2, "0")} 秒`;
  if (minutes < 60) return `${minutes} 分 ${tail}`;
  return `${Math.floor(minutes / 60)} 时 ${String(minutes % 60).padStart(2, "0")} 分 ${tail}`;
}
