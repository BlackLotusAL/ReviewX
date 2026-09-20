"use client";

import { useMemo, useRef } from "react";
import type { ReviewPreviewData } from "@/src/client/review-workspace/review-data";
import { Button, Diagnostic, Icon, Skeleton, StatusBadge } from "@/app/components/ui";
import { reviewQueue, projectShortName, mrAnchor, navigateTo, nextPendingMr } from "@/src/client/review-workspace/workspace-navigation";
import { QueuePopover } from "@/app/components/queue-popover";
import { statusLabels, phaseLabels, statusTone, isBusy } from "./presentation";
import { useWorkspaceController } from "./use-workspace-controller";
import { useWorkspaceLayout } from "./use-workspace-layout";
import { ProjectNavigation } from "./project-navigation";
import { MrList } from "./mr-list";
import { ReviewDetail } from "./review-detail";

export default function ReviewWorkspace({ previewData }: { previewData?: ReviewPreviewData }) {
  const controller = useWorkspaceController(previewData);
  const { state, announcement, disabled, refreshing, mutate, announce, pollError, actionError } = controller;
  const { stickyRef, panelRef } = useWorkspaceLayout(state);
  const queue = useMemo(() => reviewQueue(state?.projects ?? []), [state]);
  const hasPendingMr = queue.some(({ mr }) => mr.status === "awaiting_confirmation" || mr.status === "publish_failed");
  const pendingCursor = useRef<string | null>(null);
  return <main className="app-shell">
    <div className="sr-only" aria-live="polite" aria-atomic="true"><span key={announcement.id}>{announcement.text}</span></div>
    <ProjectNavigation {...controller} />

    <section ref={panelRef} className="mr-panel" aria-labelledby="mr-heading">
      <div ref={stickyRef} className="workspace-top">
      <header className="panel-header"><h2 id="mr-heading" tabIndex={-1}>MR 检视队列</h2><div className="panel-actions"><div className="queue-toolbar"><span className="queue-counts">待处理 {state ? queue.filter(({ mr }) => mr.status === "awaiting_confirmation" || mr.status === "publish_failed").length : "—"} · 排队 {state ? queue.filter(({ mr }) => mr.status === "queued").length : "—"}</span><QueuePopover disabled={!state}>{closeQueue => (
      <section className="queue-overview" aria-labelledby="queue-heading">
        <div className="queue-heading"><h3 id="queue-heading">当前检视队列</h3><span>执行中 {queue.filter(({ mr }) => ["reviewing", "stopping", "publishing"].includes(mr.status)).length} · 排队 {queue.filter(({ mr }) => mr.status === "queued").length} · 待处理 {queue.filter(({ mr }) => mr.status === "awaiting_confirmation").length} · 发布失败 {queue.filter(({ mr }) => mr.status === "publish_failed").length}</span></div>
        {queue.length ? <ul className="queue-list">{queue.map(({ project, mr }) => <li key={`${project.id}/${mr.iid}`}>
          <a className="queue-entry" href={`#${mrAnchor(project.id, mr.iid)}`} onClick={event => { event.preventDefault(); closeQueue(); navigateTo(mrAnchor(project.id, mr.iid)); }}>
            <span className="queue-copy"><span className="queue-project" title={project.name}>{projectShortName(project.name)} <span className="mono">!{mr.iid}</span></span><strong title={mr.title}>{mr.title}</strong></span>
            <span className="queue-state"><StatusBadge value={mr.status} tone={statusTone(mr.status)} busy={isBusy(mr.status)}>{statusLabels[mr.status]}</StatusBadge><span>{mr.status === "queued" ? `队列第 ${mr.queuePosition ?? "—"} 位` : mr.phase ? phaseLabels[mr.phase] : ""}</span></span>
          </a>
        </li>)}</ul> : <p className="queue-empty">当前没有排队、执行中或待处理的检视</p>}
      </section>
      )}</QueuePopover></div><Button variant="secondary" icon="arrow" disabled={!hasPendingMr} onClick={() => {
        const target = nextPendingMr(state?.projects ?? [], pendingCursor.current);
        if (!target) return;
        pendingCursor.current = mrAnchor(target.projectId, target.iid);
        navigateTo(pendingCursor.current);
      }}>下一个待处理 MR</Button><Button variant="secondary" icon="refresh" className="refresh-button" busy={refreshing} disabled={disabled || refreshing || !state?.projects.length} onClick={async () => {
        if (await mutate("refresh", "/api/mrs/refresh", "POST", {})) announce("MR 刷新请求已完成。");
      }}>{refreshing ? "刷新中…" : "刷新 MR"}</Button></div></header>

      </div>
      {state?.fatalError && <Diagnostic error={state.fatalError} />}
      {pollError && <Diagnostic error={pollError} />}
      {actionError?.scope === "page" && <Diagnostic error={actionError.error} />}
      {state?.refreshOperation.error && <Diagnostic error={state.refreshOperation.error} compact />}
      {!state && !pollError && <Skeleton label="正在读取本地状态…" />}
      {state?.projects.length === 0 && <div className="welcome"><span className="empty-symbol"><Icon name="branch" /></span><h3>暂无项目</h3><Button variant="secondary" icon="arrow" onClick={() => document.getElementById("project-id")?.focus()}>添加项目</Button></div>}
      <MrList {...controller} previewData={previewData} />
    </section>

    <ReviewDetail {...controller} />
  </main>;
}
