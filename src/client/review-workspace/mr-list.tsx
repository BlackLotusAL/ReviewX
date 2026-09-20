"use client";

import type { CSSProperties } from "react";
import type { ReviewPreviewData } from "@/src/client/review-workspace/review-data";
import type { WorkspaceController } from "./use-workspace-controller";
import { reviewDuration } from "@/src/shared/review-duration";
import { projectAnchor, projectShortName, mrAnchor } from "@/src/client/review-workspace/workspace-navigation";
import { Button, Icon, StatusBadge } from "@/app/components/ui";
import { MrWebLink, formatDate, statusLabels, phaseLabels, statusTone, isBusy } from "./presentation";

export function MrList({ state, selected, pending, clock, dataSource, disabled, chooseMr, primaryAction, previewData }: Pick<WorkspaceController, "state" | "selected" | "pending" | "clock" | "dataSource" | "disabled" | "chooseMr" | "primaryAction"> & { previewData?: ReviewPreviewData }) {
  return <>      {Boolean(state?.projects.length) && <div className="mr-groups">
        {state?.projects.map((project) => <section className="mr-group" key={project.id}>
          <div className="group-title"><div><Icon name="folder" /><h3 id={projectAnchor(project.id)} tabIndex={-1} title={project.name}>{projectShortName(project.name)}</h3></div><span>最近刷新 <time className="mono">{formatDate(project.refreshedAt)}</time></span></div>
          {!project.refreshedAt && <div className="empty inset"><Icon name="refresh" /><p>尚未刷新 MR</p></div>}
          {project.refreshedAt && project.mergeRequests.length === 0 && <div className="empty inset"><Icon name="check" /><p>暂无开放的 MR</p></div>}
          <div className="mr-grid">{project.mergeRequests.map((mr, index) => {
            const active = selected?.projectId === project.id && selected.mrIid === mr.iid;
            const actionPending = pending === `review-${mr.projectId}-${mr.iid}` || pending === `stop-${mr.latestAttemptId}`;
            const duration = reviewDuration(mr, previewData ? Date.parse(previewData.referenceTime) : clock);
            const hasProgress = Boolean(mr.queuePosition || (mr.phase && isBusy(mr.status)));
            return <article key={mr.iid} id={mrAnchor(project.id, mr.iid)} tabIndex={-1} className={`mr-card ${index < 6 ? "has-entry" : ""} ${active ? "selected" : ""}`} style={{ "--entry-delay": `${Math.min(index, 5) * 40}ms` } as CSSProperties}>
              <div className="mr-main"><div className="mr-identity"><MrWebLink mr={mr} readOnly={dataSource.readOnly} /></div><h4><button className="mr-open" aria-label={`查看 MR !${mr.iid}：${mr.title}`} aria-haspopup="dialog" onClick={(event) => chooseMr(mr, event.currentTarget)}>{mr.title}</button></h4><p className="mr-metadata"><span>更新于 <time className="mono">{formatDate(mr.updatedAt)}</time></span>{duration !== null && <span className="mr-duration">检视耗时 <span className="mono">{duration}</span></span>}</p></div>
              <div className="mr-state">{mr.progress && <span className="mr-progress">工具 {mr.progress.toolCount} 次 · 必需材料 {mr.progress.deliveredMaterials}/{mr.progress.requiredMaterials}{mr.progress.limitations.length > 0 ? " · 存在读取限制" : ""}</span>}<StatusBadge value={mr.status} tone={statusTone(mr.status)} busy={isBusy(mr.status)}>{statusLabels[mr.status]}</StatusBadge>{hasProgress && <div className="mr-progress">{mr.queuePosition ? <span className="queue-position">队列第 <span className="mono">{mr.queuePosition}</span> 位</span> : mr.phase && isBusy(mr.status) ? <span className="phase" key={mr.phase}>{phaseLabels[mr.phase]}</span> : null}</div>}</div>
              <div className="mr-action">{mr.primaryAction && <Button variant={mr.primaryAction === "start" ? "primary" : "secondary"} icon={mr.primaryAction === "start" ? "play" : mr.primaryAction === "stop" ? "stop" : "refresh"} disabled={disabled} busy={actionPending} onClick={() => void primaryAction(mr)}>{actionPending ? (mr.primaryAction === "stop" ? "停止中…" : "提交中…") : mr.primaryAction === "start" ? "开始检视" : mr.primaryAction === "stop" ? "停止" : "重新检视"}</Button>}</div>
            </article>;
          })}</div>
        </section>)}
      </div>}</>;
}
