"use client";

import type { WorkspaceController } from "./use-workspace-controller";
import { Button, DetailDialog, Diagnostic, Icon, Skeleton, StatusBadge } from "@/app/components/ui";
import { Markdown } from "@/app/components/markdown";
import { MrWebLink, formatDate, reviewStatusLabel, phaseLabels, findingLabels, severityLabels, statusTone, isBusy } from "./presentation";

export function ReviewDetail({ selected, beginClose, dismissDrawer, announcement, detail, dataSource, state, pollError, detailError, loadDetail, activeAttempt, setOpenAttemptId, latestAttempt, pending, disabled, actionError, decideFinding, loadReport, reportLoading, reportErrors, reports }: Pick<WorkspaceController, "selected" | "beginClose" | "dismissDrawer" | "announcement" | "detail" | "dataSource" | "state" | "pollError" | "detailError" | "loadDetail" | "activeAttempt" | "setOpenAttemptId" | "latestAttempt" | "pending" | "disabled" | "actionError" | "decideFinding" | "loadReport" | "reportLoading" | "reportErrors" | "reports">) {
  return <>    {selected && <DetailDialog returnFocus={selected.trigger} onBeginClose={beginClose} onDismiss={dismissDrawer}>
      <div className="drawer-live sr-only" aria-live="polite" aria-atomic="true"><span key={announcement.id}>{announcement.text}</span></div>
      <header className="drawer-header"><div><h2>{detail?.mergeRequest.title ?? selected.title}</h2>{detail && <p className="drawer-mr-meta"><span>{detail.project.name}</span><MrWebLink mr={detail.mergeRequest} className="drawer-mr-link" readOnly={dataSource.readOnly} /></p>}</div><Button variant="quiet" className="close" icon="close" aria-label="关闭详情" data-dialog-close /></header>
      <div className="drawer-body">
        {state?.fatalError && <Diagnostic error={state.fatalError} />}
        {pollError && <Diagnostic error={pollError} compact />}
        {detailError && <div><Diagnostic error={detailError} /><Button variant="secondary" icon="refresh" onClick={() => void loadDetail(selected)}>重新读取详情</Button></div>}
        {!detail && !detailError && <Skeleton label="正在读取检视历史…" />}
        {detail && detail.attempts.length === 0 && <div className="drawer-empty"><span className="empty-symbol"><Icon name="document" /></span><h3>暂无检视记录</h3><Button variant="secondary" icon="arrow" data-dialog-close>返回队列</Button></div>}
        {detail && detail.attempts.length > 0 && <>
          <div className="attempt-tabs" role="tablist" aria-label="Attempt 历史">
            {detail.attempts.map((attempt, index) => <button role="tab" id={`attempt-tab-${attempt.id}`} aria-controls="attempt-panel" aria-selected={attempt.id === activeAttempt?.id} tabIndex={attempt.id === activeAttempt?.id ? 0 : -1} key={attempt.id} className={attempt.id === activeAttempt?.id ? "active" : ""} onClick={() => setOpenAttemptId(attempt.id)} onKeyDown={(event) => {
              const directions: Record<string, number> = { ArrowRight: (index + 1) % detail.attempts.length, ArrowLeft: (index - 1 + detail.attempts.length) % detail.attempts.length, Home: 0, End: detail.attempts.length - 1 };
              const nextIndex = directions[event.key];
              if (nextIndex === undefined) return;
              event.preventDefault();
              const next = detail.attempts[nextIndex];
              setOpenAttemptId(next.id);
              document.getElementById(`attempt-tab-${next.id}`)?.focus({ preventScroll: true });
            }}><span>{index === 0 ? "最新检视" : `历史 ${detail.attempts.length - index}`}</span><strong>{reviewStatusLabel(attempt.status, attempt.result)}</strong><time className="mono">{formatDate(attempt.createdAt)}</time></button>)}
          </div>
          {activeAttempt && <section className="attempt-detail" id="attempt-panel" role="tabpanel" aria-labelledby={`attempt-tab-${activeAttempt.id}`}>
            <div className="attempt-overview">
              <div><span className="field-label">当前状态</span><StatusBadge value={activeAttempt.status} tone={statusTone(activeAttempt.status, activeAttempt.result)} busy={isBusy(activeAttempt.status)}>{reviewStatusLabel(activeAttempt.status, activeAttempt.result)}</StatusBadge></div>
              <div className="attempt-phase"><span className="field-label">{isBusy(activeAttempt.status) ? "执行阶段" : "最后阶段"}</span><strong key={activeAttempt.phase}>{activeAttempt.phase ? phaseLabels[activeAttempt.phase] : "—"}</strong></div>
              <div><span className="field-label">MR 版本</span><time className="mono">{formatDate(activeAttempt.updatedAt ?? activeAttempt.requestedUpdatedAt)}</time></div>
              <div><span className="field-label">Attempt</span><code>{activeAttempt.id}</code></div>
            </div>

              {activeAttempt.progress && <p>实际工具调用 {activeAttempt.progress.toolCount} 次；必需材料 {activeAttempt.progress.deliveredMaterials}/{activeAttempt.progress.requiredMaterials}。{activeAttempt.progress.limitations.join("；")}</p>}
              <p>{activeAttempt.execution ? `执行：${activeAttempt.execution.status} · ${activeAttempt.execution.actualModel.providerID}/${activeAttempt.execution.actualModel.modelID} · OpenCode ${activeAttempt.execution.opencodeVersion}` : "执行信息不可用"}</p>

            {activeAttempt.id !== latestAttempt?.id && <p className="history-note"><Icon name="clock" />只读</p>}
            {activeAttempt.error && <Diagnostic error={activeAttempt.error} />}
            {activeAttempt.result === "partial" && <div role="status"><h3>部分完成</h3><p>仅保留已核实的问题；未完整覆盖检视范围，不能视为通过。</p></div>}
            {activeAttempt.result === "pass" && <div className="review-pass"><Icon name="check" /><div><h3>检视完成</h3><p>未发现问题。</p></div></div>}
            {activeAttempt.findings.length > 0 && <section className="findings-section"><h3 className="section-heading">检视问题</h3>
              {activeAttempt.findings.map((finding) => {
                const isLatest = activeAttempt.id === latestAttempt?.id;
                const isSending = pending === `publish-${activeAttempt.id}-${finding.ordinal}`;
                const isDismissing = pending === `dismiss-${activeAttempt.id}-${finding.ordinal}`;
                const isRestoring = pending === `restore-${activeAttempt.id}-${finding.ordinal}`;
                const decisionsEnabled = isLatest && !disabled && !state?.publicationBusy;
                const findingUrl = `/api/attempts/${encodeURIComponent(activeAttempt.id)}/findings/${finding.ordinal}`;
                const localError = actionError?.scope === "finding" && actionError.key.endsWith(`-${activeAttempt.id}-${finding.ordinal}`) ? actionError.error : null;
                const processed = ["dismissed", "published", "archived"].includes(finding.status);
                return <article tabIndex={-1} className={`finding-card ${processed ? "finding-card-processed" : ""}`} key={`${activeAttempt.id}-${finding.ordinal}`}>
                  <header className={`finding-header severity-${finding.severity}`}><div className="finding-info"><span className="finding-severity">{severityLabels[finding.severity]}</span><div className="finding-badges"><StatusBadge value={isSending ? "sending" : finding.status} tone={statusTone(finding.status)} busy={isSending}>{isSending ? "发送中…" : findingLabels[finding.status]}</StatusBadge></div></div>
                  {isLatest && ["pending", "dismissed"].includes(finding.status) && <div className="finding-actions">
                    {isLatest && finding.status === "pending" ? <><Button key="dismiss" variant="secondary" disabled={!decisionsEnabled} busy={isDismissing} onClick={(event) => void decideFinding(event.currentTarget, `dismiss-${activeAttempt.id}-${finding.ordinal}`, findingUrl, "PATCH", { decision: "dismissed" })}>不发送</Button><Button key="publish" icon="send" disabled={!decisionsEnabled} busy={isSending} onClick={(event) => void decideFinding(event.currentTarget, `publish-${activeAttempt.id}-${finding.ordinal}`, `${findingUrl}/publish`, "POST", {})}>{isSending ? "发送中…" : "发送到 CodeHub"}</Button></>
                    : isLatest && finding.status === "dismissed" ? <><Button key="restore" variant="secondary" icon="undo" disabled={!decisionsEnabled} busy={isRestoring} onClick={(event) => void decideFinding(event.currentTarget, `restore-${activeAttempt.id}-${finding.ordinal}`, findingUrl, "PATCH", { decision: "pending" })}>撤销</Button></>
                    : null}
                  </div>}
                  </header>
                  <div className="finding-body"><Markdown>{finding.body}</Markdown></div>
                  {(finding.error || localError) && <Diagnostic error={finding.error ?? localError!} compact />}
                </article>;
              })}
            </section>}
            {activeAttempt.reportUrl && <details key={activeAttempt.id} className="report-section" onToggle={(event) => { if (event.currentTarget.open) void loadReport(activeAttempt); }}><summary><Icon name="document" /><span>完整报告</span><Icon name="chevron" className="disclosure-icon" /></summary><div className="report-content" aria-busy={reportLoading[activeAttempt.id] || undefined}>
              {reportLoading[activeAttempt.id] && <p className="report-loading"><span className="spinner" aria-hidden="true" />正在加载完整报告…</p>}
              {reportErrors[activeAttempt.id] && <div className="report-error"><Diagnostic error={reportErrors[activeAttempt.id]} compact /><Button variant="secondary" onClick={() => void loadReport(activeAttempt)}>重新读取报告</Button></div>}
              {reports[activeAttempt.id] !== undefined && <Markdown className="markdown report-preview">{reports[activeAttempt.id]}</Markdown>}
            </div></details>}
          </section>}
        </>}
      </div>
    </DetailDialog>}</>;
}
