import type { AttemptStatus, FindingStatus, MergeRequestSnapshot, ReviewPhase, Severity } from "@/src/shared/types";
import { Icon } from "@/app/components/ui";

export const statusLabels: Record<"unreviewed" | AttemptStatus, string> = {
  unreviewed: "未检视", queued: "排队中", reviewing: "检视中", stopping: "停止中", stopped: "已停止",
  review_failed: "检视失败", awaiting_confirmation: "待处理", publishing: "发送中", completed: "已完成", publish_failed: "发布失败", archived: "已归档",
};
export const phaseLabels: Record<ReviewPhase, string> = {
  queued: "等待前序任务", loading_mr: "读取 MR 详情", preparing_git: "准备 Git 代码", verifying_mr: "再次校验 MR", running_opencode: "运行 OpenCode",
  saving_report: "保存报告", cleaning_up: "清理临时目录",
};
export const findingLabels: Record<FindingStatus, string> = {
  pending: "待处理", published: "已发送", dismissed: "已跳过", failed: "发送失败", unknown: "结果未知", not_attempted: "未执行", archived: "已归档",
};
export const severityLabels: Record<Severity, string> = { fatal: "Fatal", major: "Major", minor: "Minor", suggestion: "Suggestion" };

export function statusTone(status: string): "neutral" | "active" | "success" | "error" {
  if (["review_failed", "publish_failed", "failed", "unknown", "not_attempted"].includes(status)) return "error";
  if (["completed", "published"].includes(status)) return "success";
  if (["reviewing", "publishing", "awaiting_confirmation", "pending"].includes(status)) return "active";
  return "neutral";
}
export function isBusy(status: string) { return ["reviewing", "publishing", "stopping"].includes(status); }

export function formatDate(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
export function MrWebLink({ mr, className = "iid", readOnly = false }: { mr: MergeRequestSnapshot; className?: string; readOnly?: boolean }) {
  if (!mr.webUrl) return <span className={className}>!{mr.iid}</span>;
  return <a className={`${className} mr-web-link`} href={readOnly ? "#" : mr.webUrl} target="_blank" rel="noreferrer noopener"
    onClick={readOnly ? event => event.preventDefault() : undefined} onAuxClick={readOnly ? event => event.preventDefault() : undefined}
    aria-label={readOnly ? `示例 MR !${mr.iid}` : `在 CodeHub 打开 MR !${mr.iid}`}>!{mr.iid}<Icon name="external" /></a>;
}
