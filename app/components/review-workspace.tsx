"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { AppStateView, AttemptStatus, AttemptView, FindingStatus, MrDetailView, MrRowView, MergeRequestSnapshot, ReviewPhase, SafeErrorView, Severity } from "@/src/shared/types";
import { createPreviewDataSource, liveReviewData, type ReviewPreviewData } from "@/src/client/review-data";
import { confidenceDisplay } from "@/src/shared/confidence-display";
import { reviewDuration } from "@/src/shared/review-duration";
import { Button, DetailDialog, Diagnostic, Icon, Skeleton, StatusBadge } from "./ui";
import { Markdown } from "./markdown";

const statusLabels: Record<"unreviewed" | AttemptStatus, string> = {
  unreviewed: "未检视", queued: "排队中", reviewing: "检视中", stopping: "停止中", stopped: "已停止",
  review_failed: "检视未完成", awaiting_confirmation: "待处理", publishing: "发送中", completed: "已完成", publish_failed: "发布失败", archived: "已归档",
};
const phaseLabels: Record<ReviewPhase, string> = {
  queued: "等待前序任务", loading_mr: "读取 MR 详情", preparing_git: "准备 Git 代码", verifying_mr: "再次校验 MR", running_opencode: "运行 OpenCode",
  understanding_changes: "理解改动", verifying_findings: "核实问题", finalizing_review: "整理结果", saving_report: "保存报告", cleaning_up: "清理临时目录",
};
const findingLabels: Record<FindingStatus, string> = {
  pending: "待处理", published: "已发送", dismissed: "已跳过", failed: "发送失败", unknown: "结果未知", not_attempted: "未执行", archived: "已归档",
};
const severityLabels: Record<Severity, string> = { fatal: "Fatal", major: "Major", minor: "Minor", suggestion: "Suggestion" };

function statusTone(status: string): "neutral" | "active" | "success" | "error" {
  if (["review_failed", "publish_failed", "failed", "unknown", "not_attempted"].includes(status)) return "error";
  if (["completed", "published"].includes(status)) return "success";
  if (["reviewing", "publishing", "awaiting_confirmation", "pending"].includes(status)) return "active";
  return "neutral";
}
function isBusy(status: string) { return ["reviewing", "publishing", "stopping"].includes(status); }

interface Selection { projectId: string; mrIid: string; title: string; trigger: HTMLElement }
interface ActionError { key: string; scope: "project" | "page" | "finding"; error: SafeErrorView }

function diagnosticText(error: unknown): SafeErrorView {
  if (error && typeof error === "object" && "code" in error && "message" in error) return error as SafeErrorView;
  return {
    code: "CLIENT_ERROR", message: error instanceof Error ? error.message : String(error), cause: "网页请求未成功完成。",
    impact: "当前操作未确认。", nextStep: "查看当前会话日志并核对操作结果。", technicalDetails: error instanceof Error ? error.message : String(error),
  };
}
function formatDate(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
function MrWebLink({ mr, className = "iid", readOnly = false }: { mr: MergeRequestSnapshot; className?: string; readOnly?: boolean }) {
  if (!mr.webUrl) return <span className={className}>!{mr.iid}</span>;
  return <a className={`${className} mr-web-link`} href={readOnly ? "#" : mr.webUrl} target="_blank" rel="noreferrer noopener"
    onClick={readOnly ? event => event.preventDefault() : undefined} onAuxClick={readOnly ? event => event.preventDefault() : undefined}
    aria-label={readOnly ? `示例 MR !${mr.iid}` : `在 CodeHub 打开 MR !${mr.iid}`}>!{mr.iid}<Icon name="external" /></a>;
}

export default function ReviewWorkspace({ previewData }: { previewData?: ReviewPreviewData }) {
  const dataSource = useMemo(() => previewData ? createPreviewDataSource(previewData) : liveReviewData, [previewData]);
  const [state, setState] = useState<AppStateView | null>(null);
  const [clock, setClock] = useState(0);
  const hasRunningReview = state?.projects.some(project => project.mergeRequests.some(mr => mr.status === "reviewing" || mr.status === "stopping"));
  useEffect(() => {
    if (previewData || !hasRunningReview) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [previewData, hasRunningReview]);
  const [projectId, setProjectId] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<MrDetailView | null>(null);
  const [openAttemptId, setOpenAttemptId] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, string>>({});
  const [reportErrors, setReportErrors] = useState<Record<string, SafeErrorView>>({});
  const [reportLoading, setReportLoading] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [pollError, setPollError] = useState<SafeErrorView | null>(null);
  const [detailError, setDetailError] = useState<SafeErrorView | null>(null);
  const [announcement, setAnnouncement] = useState({ id: 0, text: "" });
  const [projectFeedback, setProjectFeedback] = useState("");
  const selectedRef = useRef<Selection | null>(null);
  const stateRevision = useRef(-1);
  const detailRequest = useRef(0);
  const pendingRef = useRef<string | null>(null);
  const mounted = useRef(false);
  const pollInFlight = useRef<Promise<void> | null>(null);
  const reportRequests = useRef(new Set<string>());
  const mrTransitions = useRef(new Map<string, string>());
  const findingTransitions = useRef(new Map<string, FindingStatus>());
  const lastPollError = useRef("");
  const lastDetailError = useRef("");

  const announce = useCallback((text: string) => {
    setAnnouncement((current) => ({ id: current.id + 1, text }));
  }, []);

  const acceptState = useCallback((next: AppStateView) => {
    if (!mounted.current || next.revision < stateRevision.current) return false;
    const changed = next.revision !== stateRevision.current;
    stateRevision.current = next.revision;
    setState(next);
    setClock(Date.now());
    if (changed) {
      const transitions = new Map<string, string>();
      const messages: string[] = [];
      for (const project of next.projects) for (const mr of project.mergeRequests) {
        const key = `${project.id}/${mr.iid}`;
        const value = `${mr.latestAttemptId}/${mr.status}/${mr.phase}/${mr.queuePosition}`;
        transitions.set(key, value);
        if (mrTransitions.current.has(key) && mrTransitions.current.get(key) !== value) {
          messages.push(`MR !${mr.iid} ${statusLabels[mr.status]}${mr.phase && isBusy(mr.status) ? `，${phaseLabels[mr.phase]}` : ""}`);
        }
      }
      mrTransitions.current = transitions;
      if (messages.length) announce(messages.join("；"));
    }
    return changed;
  }, [announce]);

  const loadDetail = useCallback(async (target: Selection) => {
    if (selectedRef.current !== target) return;
    const requestId = ++detailRequest.current;
    try {
      const next = await dataSource.readMr(target.projectId, target.mrIid);
      if (!mounted.current || requestId !== detailRequest.current || selectedRef.current !== target) return;
      setDetail(next);
      setDetailError(null);
      lastDetailError.current = "";
      setOpenAttemptId((current) => current && next.attempts.some((attempt) => attempt.id === current) ? current : next.attempts[0]?.id ?? null);
      const messages: string[] = [];
      for (const attempt of next.attempts) for (const finding of attempt.findings) {
        const key = `${attempt.id}/${finding.ordinal}`;
        const previous = findingTransitions.current.get(key);
        if (previous !== undefined && previous !== finding.status) messages.push(`问题 ${finding.ordinal} ${findingLabels[finding.status]}`);
        findingTransitions.current.set(key, finding.status);
      }
      if (messages.length) announce(messages.join("；"));
    } catch (reason) {
      if (!mounted.current || requestId !== detailRequest.current || selectedRef.current !== target) return;
      const failure = diagnosticText(reason);
      setDetailError(failure);
      const identity = `${target.projectId}/${target.mrIid}/${failure.code}/${failure.message}`;
      if (lastDetailError.current !== identity) announce(failure.message);
      lastDetailError.current = identity;
    }
  }, [announce, dataSource]);

  const refreshState = useCallback((): Promise<void> => {
    if (pollInFlight.current) return pollInFlight.current;
    const operation = (async () => {
      try {
        const next = await dataSource.readState();
        if (!mounted.current) return;
        const changed = acceptState(next);
        setPollError(null);
        lastPollError.current = "";
        if (changed && selectedRef.current) await loadDetail(selectedRef.current);
      } catch (reason) {
        if (!mounted.current) return;
        const failure = diagnosticText(reason);
        setPollError(failure);
        const identity = `${failure.code}/${failure.message}`;
        if (lastPollError.current !== identity) announce(failure.message);
        lastPollError.current = identity;
      }
    })();
    pollInFlight.current = operation;
    void operation.finally(() => { pollInFlight.current = null; });
    return operation;
  }, [acceptState, announce, dataSource, loadDetail]);

  useEffect(() => {
    mounted.current = true;
    void refreshState();
    const timer = dataSource.readOnly ? undefined : window.setInterval(() => void refreshState(), 1000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [dataSource, refreshState]);

  const mutate = useCallback(async (key: string, url: string, method: "POST" | "PATCH" | "DELETE", body: unknown, scope: ActionError["scope"] = "page") => {
    if (dataSource.readOnly || pendingRef.current) return false;
    pendingRef.current = key;
    setPending(key);
    setActionError(null);
    try {
      const next = await dataSource.mutate(url, method, body);
      acceptState(next);
      if (selectedRef.current) await loadDetail(selectedRef.current);
      return true;
    } catch (reason) {
      const failure = diagnosticText(reason);
      setActionError({ key, scope, error: failure });
      announce(failure.message);
      await refreshState();
      if (selectedRef.current) await loadDetail(selectedRef.current);
      return false;
    } finally {
      pendingRef.current = null;
      setPending(null);
    }
  }, [acceptState, announce, dataSource, loadDetail, refreshState]);

  const addProject = async (event: FormEvent) => {
    event.preventDefault();
    if (dataSource.readOnly) return;
    setProjectFeedback("");
    if (!/^[1-9]\d*$/u.test(projectId)) {
      const failure = diagnosticText(new Error("Project ID 必须是正整数。"));
      setActionError({ key: "add-project", scope: "project", error: failure });
      announce(failure.message);
      return;
    }
    if (await mutate("add-project", "/api/projects", "POST", { projectId }, "project")) {
      setProjectId("");
      setProjectFeedback("项目已添加");
      announce("项目已添加。");
    }
  };

  const chooseMr = (mr: MrRowView, trigger: HTMLElement) => {
    const target = { projectId: mr.projectId, mrIid: mr.iid, title: mr.title, trigger };
    selectedRef.current = target;
    setSelected(target);
    setDetail(null);
    setOpenAttemptId(null);
    setDetailError(null);
    if (actionError?.scope === "finding") setActionError(null);
    void loadDetail(target);
  };
  const beginClose = useCallback(() => { detailRequest.current += 1; selectedRef.current = null; }, []);
  const dismissDrawer = useCallback(() => { setSelected(null); setDetail(null); setDetailError(null); }, []);

  const primaryAction = async (mr: MrRowView) => {
    if (mr.primaryAction === "stop" && mr.latestAttemptId) {
      await mutate(`stop-${mr.latestAttemptId}`, `/api/attempts/${encodeURIComponent(mr.latestAttemptId)}/stop`, "POST", {});
    } else if (mr.primaryAction === "start" || mr.primaryAction === "rereview") {
      await mutate(`review-${mr.projectId}-${mr.iid}`, "/api/reviews", "POST", { projectId: mr.projectId, mrIid: mr.iid });
    }
  };

  const decideFinding = async (trigger: HTMLButtonElement, key: string, url: string, method: "POST" | "PATCH", body: unknown) => {
    const card = trigger.closest<HTMLElement>(".finding-card");
    await mutate(key, url, method, body, "finding");
    // A completed decision removes its button. Keep keyboard focus at that
    // finding without changing the scroll position or overriding a new focus.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!trigger.isConnected && card?.isConnected && (active === document.body || active?.tagName === "DIALOG")) card.focus({ preventScroll: true });
    });
  };

  const loadReport = async (attempt: AttemptView) => {
    if (!attempt.reportUrl || reports[attempt.id] !== undefined || reportRequests.current.has(attempt.id)) return;
    reportRequests.current.add(attempt.id);
    setReportLoading((current) => ({ ...current, [attempt.id]: true }));
    setReportErrors((current) => { const next = { ...current }; delete next[attempt.id]; return next; });
    try {
      const markdown = await dataSource.readReport(attempt.reportUrl);
      setReports((current) => ({ ...current, [attempt.id]: markdown }));
    } catch (reason) {
      const failure = diagnosticText(reason);
      setReportErrors((current) => ({ ...current, [attempt.id]: failure }));
      if (selectedRef.current?.projectId === attempt.projectId && selectedRef.current.mrIid === attempt.mrIid) announce(failure.message);
    } finally {
      reportRequests.current.delete(attempt.id);
      setReportLoading((current) => ({ ...current, [attempt.id]: false }));
    }
  };

  const latestAttempt = detail?.attempts[0];
  const activeAttempt = useMemo(() => detail?.attempts.find((attempt) => attempt.id === openAttemptId) ?? latestAttempt, [detail, latestAttempt, openAttemptId]);
  const disabled = pending !== null || Boolean(state?.fatalError);
  const refreshing = state?.refreshOperation.status === "refreshing" || pending === "refresh";

  return <main className="app-shell">
    <div className="sr-only" aria-live="polite" aria-atomic="true"><span key={announcement.id}>{announcement.text}</span></div>
    <section className="project-panel" aria-labelledby="project-heading">
      <div className="brand"><span className="brand-mark" aria-hidden="true">rx<span /></span><h1 id="project-heading">ReviewX</h1></div>
      <div className="sidebar-section">
        <form onSubmit={(event) => void addProject(event)} className="project-form">
          <div className="input-row"><input id="project-id" aria-label="Project ID" inputMode="numeric" pattern="[1-9][0-9]*" value={projectId} onChange={(event) => { setProjectId(event.target.value); setProjectFeedback(""); }} placeholder="例如 123" disabled={disabled} aria-invalid={actionError?.key === "add-project" || undefined} aria-describedby={actionError?.key === "add-project" ? "project-error" : undefined} /><Button type="submit" icon="plus" disabled={disabled || !projectId} busy={pending === "add-project"}>{pending === "add-project" ? "添加中" : "添加"}</Button></div>
        </form>
        {projectFeedback && <p className="inline-feedback">{projectFeedback}</p>}
        {actionError?.scope === "project" && <div id="project-error"><Diagnostic error={actionError.error} compact /></div>}
      </div>
      {(state ? state.projects.length > 0 : !pollError) && <div className="project-list" aria-label="已登记 Project">
        {!state && !pollError && <Skeleton label="正在读取项目…" compact />}
        {state?.projects.map((project) => <article className="project-item" key={project.id}>
          <Icon name="folder" /><div className="project-copy"><strong>{project.name}</strong><span className="mono">#{project.id}</span></div>
          <Button variant="quiet" className="remove-button" disabled={disabled || project.removing || state.publicationProjectId === project.id} busy={project.removing || pending === `remove-${project.id}`} onClick={async () => {
            if (await mutate(`remove-${project.id}`, `/api/projects/${encodeURIComponent(project.id)}`, "DELETE", {}, "project")) { setProjectFeedback(""); announce("项目已移除。"); }
          }}>{project.removing ? "移除中" : "移除"}</Button>
        </article>)}
      </div>}
      <div className="sidebar-footer"><a className="log-link" href="/logs" target="_blank" rel="noreferrer"><Icon name="document" />查看当前会话日志<Icon name="external" /></a></div>
    </section>

    <section className="mr-panel" aria-labelledby="mr-heading">
      <header className="panel-header"><h2 id="mr-heading" tabIndex={-1}>MR 检视队列</h2><Button variant="secondary" icon="refresh" className="refresh-button" busy={refreshing} disabled={disabled || refreshing || !state?.projects.length} onClick={async () => {
        if (await mutate("refresh", "/api/mrs/refresh", "POST", {})) announce("MR 刷新请求已完成。");
      }}>{refreshing ? "刷新中…" : "刷新 MR"}</Button></header>
      {state?.fatalError && <Diagnostic error={state.fatalError} />}
      {pollError && <Diagnostic error={pollError} />}
      {actionError?.scope === "page" && <Diagnostic error={actionError.error} />}
      {state?.refreshOperation.error && <Diagnostic error={state.refreshOperation.error} compact />}
      {!state && !pollError && <Skeleton label="正在读取本地状态…" />}
      {state?.projects.length === 0 && <div className="welcome"><span className="empty-symbol"><Icon name="branch" /></span><h3>暂无项目</h3><Button variant="secondary" icon="arrow" onClick={() => document.getElementById("project-id")?.focus()}>添加项目</Button></div>}
      {Boolean(state?.projects.length) && <div className="mr-groups">
        {state?.projects.map((project) => <section className="mr-group" key={project.id}>
          <div className="group-title"><div><Icon name="folder" /><h3>{project.name}</h3></div><span>最近刷新 <time className="mono">{formatDate(project.refreshedAt)}</time></span></div>
          {!project.refreshedAt && <div className="empty inset"><Icon name="refresh" /><p>尚未刷新 MR</p></div>}
          {project.refreshedAt && project.mergeRequests.length === 0 && <div className="empty inset"><Icon name="check" /><p>暂无开放的 MR</p></div>}
          {project.mergeRequests.map((mr, index) => {
            const active = selected?.projectId === project.id && selected.mrIid === mr.iid;
            const actionPending = pending === `review-${mr.projectId}-${mr.iid}` || pending === `stop-${mr.latestAttemptId}`;
            const duration = reviewDuration(mr, previewData ? Date.parse(previewData.referenceTime) : clock);
            const hasProgress = Boolean(mr.queuePosition || (mr.phase && isBusy(mr.status)));
            return <article key={mr.iid} className={`mr-card ${index < 6 ? "has-entry" : ""} ${active ? "selected" : ""}`} style={{ "--entry-delay": `${Math.min(index, 5) * 40}ms` } as CSSProperties}>
              <div className="mr-main"><div className="mr-identity"><MrWebLink mr={mr} readOnly={dataSource.readOnly} /></div><h4><button className="mr-open" aria-label={`查看 MR !${mr.iid}：${mr.title}`} aria-haspopup="dialog" onClick={(event) => chooseMr(mr, event.currentTarget)}>{mr.title}</button></h4><p className="mr-metadata"><span>更新于 <time className="mono">{formatDate(mr.updatedAt)}</time></span>{duration !== null && <span className="mr-duration">检视耗时 <span className="mono">{duration}</span></span>}</p></div>
              <div className="mr-state"><StatusBadge value={mr.status} tone={statusTone(mr.status)} busy={isBusy(mr.status)}>{statusLabels[mr.status]}</StatusBadge>{hasProgress && <div className="mr-progress">{mr.queuePosition ? <span className="queue-position">队列第 <span className="mono">{mr.queuePosition}</span> 位</span> : mr.phase && isBusy(mr.status) ? <span className="phase" key={mr.phase}>{phaseLabels[mr.phase]}</span> : null}</div>}</div>
              <div className="mr-action">{mr.primaryAction && <Button variant={mr.primaryAction === "start" ? "primary" : "secondary"} icon={mr.primaryAction === "start" ? "play" : mr.primaryAction === "stop" ? "stop" : "refresh"} disabled={disabled} busy={actionPending} onClick={() => void primaryAction(mr)}>{actionPending ? (mr.primaryAction === "stop" ? "停止中…" : "提交中…") : mr.primaryAction === "start" ? "开始检视" : mr.primaryAction === "stop" ? "停止" : "重新检视"}</Button>}</div>
            </article>;
          })}
        </section>)}
      </div>}
    </section>

    {selected && <DetailDialog returnFocus={selected.trigger} onBeginClose={beginClose} onDismiss={dismissDrawer}>
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
            }}><span>{index === 0 ? "最新检视" : `历史 ${detail.attempts.length - index}`}</span><strong>{statusLabels[attempt.status]}</strong><time className="mono">{formatDate(attempt.createdAt)}</time></button>)}
          </div>
          {activeAttempt && <section className="attempt-detail" id="attempt-panel" role="tabpanel" aria-labelledby={`attempt-tab-${activeAttempt.id}`}>
            <div className="attempt-overview">
              <div><span className="field-label">当前状态</span><StatusBadge value={activeAttempt.status} tone={statusTone(activeAttempt.status)} busy={isBusy(activeAttempt.status)}>{statusLabels[activeAttempt.status]}</StatusBadge></div>
              <div className="attempt-phase"><span className="field-label">{isBusy(activeAttempt.status) ? "执行阶段" : "最后阶段"}</span><strong key={activeAttempt.phase}>{activeAttempt.phase ? phaseLabels[activeAttempt.phase] : "—"}</strong></div>
              <div><span className="field-label">MR 版本</span><time className="mono">{formatDate(activeAttempt.updatedAt ?? activeAttempt.requestedUpdatedAt)}</time></div>
              <div><span className="field-label">Attempt</span><code>{activeAttempt.id}</code></div>
            </div>

            {activeAttempt.id !== latestAttempt?.id && <p className="history-note"><Icon name="clock" />只读</p>}
            {activeAttempt.error && <Diagnostic error={activeAttempt.error} />}
            {activeAttempt.result === "pass" && <div className="review-pass"><Icon name="check" /><div><h3>检视完成</h3><p>未发现证据充分的问题。</p></div></div>}
            {activeAttempt.findings.length > 0 && <section className="findings-section"><h3 className="section-heading">检视问题</h3>
              {activeAttempt.findings.map((finding) => {
                const isLatest = activeAttempt.id === latestAttempt?.id;
                const isSending = pending === `publish-${activeAttempt.id}-${finding.ordinal}`;
                const isDismissing = pending === `dismiss-${activeAttempt.id}-${finding.ordinal}`;
                const isRestoring = pending === `restore-${activeAttempt.id}-${finding.ordinal}`;
                const decisionsEnabled = isLatest && !disabled && !state?.publicationBusy;
                const findingUrl = `/api/attempts/${encodeURIComponent(activeAttempt.id)}/findings/${finding.ordinal}`;
                const localError = actionError?.scope === "finding" && actionError.key.endsWith(`-${activeAttempt.id}-${finding.ordinal}`) ? actionError.error : null;
                const confidence = confidenceDisplay(finding.confidence);
                const processed = ["dismissed", "published", "archived"].includes(finding.status);
                return <article tabIndex={-1} className={`finding-card ${processed ? "finding-card-processed" : ""}`} key={`${activeAttempt.id}-${finding.ordinal}`}>
                  <header className={`finding-header severity-${finding.severity}`}><div className="finding-info"><span className="finding-severity">{severityLabels[finding.severity]}</span><div className="finding-badges"><span className="finding-confidence" style={{ backgroundColor: confidence.background }} title="模型自评分，不代表统计正确率">置信度 <span className="mono">{confidence.label}</span></span><StatusBadge value={isSending ? "sending" : finding.status} tone={statusTone(finding.status)} busy={isSending}>{isSending ? "发送中…" : findingLabels[finding.status]}</StatusBadge></div></div>
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
    </DetailDialog>}
  </main>;
}
