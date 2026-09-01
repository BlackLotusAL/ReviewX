"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type {
  AppStateView,
  AttemptStatus,
  AttemptView,
  FindingStatus,
  MrDetailView,
  MrRowView,
  ReviewPhase,
  SafeErrorView,
  Severity,
} from "@/src/shared/types";
import { safeMarkdownUrl } from "@/src/shared/markdown";

const statusLabels: Record<"unreviewed" | AttemptStatus, string> = {
  unreviewed: "未检视",
  queued: "排队中",
  reviewing: "检视中",
  stopping: "停止中",
  stopped: "已停止",
  review_failed: "检视失败",
  awaiting_confirmation: "待确认",
  publishing: "发布中",
  completed: "已完成",
  publish_failed: "发布失败",
  archived: "已归档",
};

const phaseLabels: Record<ReviewPhase, string> = {
  queued: "等待前序任务",
  loading_mr: "读取 MR 详情",
  preparing_git: "准备 Git 代码",
  verifying_mr: "再次校验 MR",
  running_opencode: "运行 OpenCode",
  saving_report: "保存报告",
  cleaning_up: "清理临时目录",
};

const findingLabels: Record<FindingStatus, string> = {
  pending: "待发布",
  published: "已发布",
  failed: "发布失败",
  unknown: "结果未知",
  not_attempted: "未执行",
  archived: "已归档",
};

const severityLabels: Record<Severity, string> = {
  fatal: "🔴 Fatal",
  major: "🟠 Major",
  minor: "🟡 Minor",
  suggestion: "🟢 Suggestion",
};

const markdownElements = [
  "p", "br", "strong", "em", "del", "blockquote", "ul", "ol", "li", "pre", "code",
  "h1", "h2", "h3", "h4", "h5", "h6", "a", "img", "hr", "table", "thead", "tbody", "tr", "th", "td",
];

function Markdown({ children, className = "markdown" }: { children: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeSanitize]}
        allowedElements={markdownElements}
        urlTransform={(url) => safeMarkdownUrl(url)}
        components={{
          a: ({ href, children: contents }) => href
            ? <a href={href} target="_blank" rel="noreferrer noopener">{contents}</a>
            : <span className="blocked-resource">[链接已拦截] {contents}</span>,
          img: ({ src, alt }) => typeof src === "string" && src
            ? <a className="image-link" href={src} target="_blank" rel="noreferrer noopener">[图片链接] {alt || src}</a>
            : <span className="blocked-resource">[图片已拦截] {alt}</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

interface ApiFailure { error?: SafeErrorView }

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json() as T & ApiFailure;
  if (!response.ok) throw body.error ?? new Error(`HTTP ${response.status}`);
  return body;
}

function diagnosticText(error: unknown): SafeErrorView {
  if (error && typeof error === "object" && "code" in error && "message" in error) return error as SafeErrorView;
  return {
    code: "CLIENT_ERROR",
    message: error instanceof Error ? error.message : String(error),
    cause: "网页请求未成功完成。",
    impact: "当前操作未确认。",
    nextStep: "查看当前会话日志并重试。",
    technicalDetails: error instanceof Error ? error.message : String(error),
  };
}

function Diagnostic({ error, compact = false }: { error: SafeErrorView; compact?: boolean }) {
  return (
    <section className={`diagnostic ${compact ? "compact" : ""}`} aria-label="错误诊断">
      <strong>{error.message}</strong>
      <dl>
        <div><dt>Cause</dt><dd>{error.cause}</dd></div>
        <div><dt>Impact</dt><dd>{error.impact}</dd></div>
        <div><dt>Next step</dt><dd>{error.nextStep}</dd></div>
        {!compact && <div><dt>Technical details</dt><dd>{error.technicalDetails}</dd></div>}
      </dl>
      {!compact && error.stderr && <pre>{error.stderr}</pre>}
      {!compact && error.stack && <details><summary>Stack</summary><pre>{error.stack}</pre></details>}
    </section>
  );
}

function formatDate(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

export default function Home() {
  const [state, setState] = useState<AppStateView | null>(null);
  const [projectId, setProjectId] = useState("");
  const [selected, setSelected] = useState<{ projectId: string; mrIid: string } | null>(null);
  const [detail, setDetail] = useState<MrDetailView | null>(null);
  const [openAttemptId, setOpenAttemptId] = useState<string | null>(null);
  const [selectionsByAttempt, setSelectionsByAttempt] = useState<Record<string, number[]>>({});
  const [reports, setReports] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<SafeErrorView | null>(null);
  const stateRevision = useRef(-1);
  const detailRequest = useRef(0);

  const loadDetail = useCallback(async (target: { projectId: string; mrIid: string }) => {
    const requestId = ++detailRequest.current;
    const next = await requestJson<MrDetailView>(`/api/mrs/${encodeURIComponent(target.projectId)}/${encodeURIComponent(target.mrIid)}`);
    if (requestId !== detailRequest.current) return;
    setDetail(next);
    setOpenAttemptId((current) => current && next.attempts.some((attempt) => attempt.id === current) ? current : next.attempts[0]?.id ?? null);
  }, []);

  const refreshState = useCallback(async () => {
    const next = await requestJson<AppStateView>("/api/state");
    const previousRevision = stateRevision.current;
    if (next.revision < previousRevision) return;
    setState(next);
    if (next.revision !== previousRevision) {
      stateRevision.current = next.revision;
      if (selected) await loadDetail(selected).catch((reason) => setError(diagnosticText(reason)));
    }
  }, [loadDetail, selected]);

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    const poll = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try { await refreshState(); } catch (reason) { if (!stopped) setError(diagnosticText(reason)); }
      finally { inFlight = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [refreshState]);

  const mutate = useCallback(async (key: string, url: string, method: "POST" | "DELETE", body: unknown) => {
    setPending(key);
    setError(null);
    try {
      const next = await requestJson<AppStateView>(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setState((current) => current && current.revision > next.revision ? current : next);
      stateRevision.current = Math.max(stateRevision.current, next.revision);
      if (selected) await loadDetail(selected).catch(() => undefined);
    } catch (reason) {
      setError(diagnosticText(reason));
      await refreshState().catch(() => undefined);
      if (selected) await loadDetail(selected).catch(() => undefined);
    } finally {
      setPending(null);
    }
  }, [loadDetail, refreshState, selected]);

  const addProject = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^[1-9]\d*$/u.test(projectId)) {
      setError(diagnosticText(new Error("Project ID 必须是正整数。")));
      return;
    }
    await mutate("add-project", "/api/projects", "POST", { projectId });
    setProjectId("");
  };

  const chooseMr = async (project: string, iid: string) => {
    const target = { projectId: project, mrIid: iid };
    setSelected(target);
    setDetail(null);
    setError(null);
    try { await loadDetail(target); } catch (reason) { setError(diagnosticText(reason)); }
  };

  const primaryAction = async (event: MouseEvent, mr: MrRowView) => {
    event.stopPropagation();
    if (mr.primaryAction === "stop" && mr.latestAttemptId) {
      await mutate(`stop-${mr.latestAttemptId}`, `/api/attempts/${encodeURIComponent(mr.latestAttemptId)}/stop`, "POST", {});
      return;
    }
    if (mr.primaryAction === "start" || mr.primaryAction === "rereview") {
      await mutate(`review-${mr.projectId}-${mr.iid}`, "/api/reviews", "POST", { projectId: mr.projectId, mrIid: mr.iid });
    }
  };

  const loadReport = async (attempt: AttemptView) => {
    if (!attempt.reportUrl || reports[attempt.id] !== undefined) return;
    setPending(`report-${attempt.id}`);
    try {
      const response = await fetch(attempt.reportUrl, { cache: "no-store" });
      if (!response.ok) {
        const failure = await response.json() as ApiFailure;
        throw failure.error ?? new Error(`HTTP ${response.status}`);
      }
      const markdown = await response.text();
      setReports((current) => ({ ...current, [attempt.id]: markdown }));
    } catch (reason) {
      setError(diagnosticText(reason));
    } finally {
      setPending(null);
    }
  };

  const latestAttempt = detail?.attempts[0];
  const activeAttempt = useMemo(() => detail?.attempts.find((attempt) => attempt.id === openAttemptId) ?? latestAttempt, [detail, latestAttempt, openAttemptId]);
  const selectedOrdinals = latestAttempt
    ? (selectionsByAttempt[latestAttempt.id] ?? []).filter((ordinal) => latestAttempt.findings.some((finding) => finding.ordinal === ordinal && finding.status === "pending"))
    : [];
  const setSelectedOrdinals = useCallback((update: (current: number[]) => number[]) => {
    if (!latestAttempt) return;
    setSelectionsByAttempt((current) => ({
      ...current,
      [latestAttempt.id]: update(current[latestAttempt.id] ?? []),
    }));
  }, [latestAttempt]);
  const selectable = latestAttempt?.status === "awaiting_confirmation" && !state?.publicationBusy;

  return (
    <main className={`app-shell ${selected ? "drawer-open" : ""}`}>
      <section className="project-panel" aria-labelledby="project-heading">
        <div className="brand">
          <span className="brand-mark">RX</span>
          <div><h1 id="project-heading">ReviewX</h1><p>本机 CodeHub MR 检视</p></div>
        </div>
        <form onSubmit={(event) => void addProject(event)} className="project-form">
          <label htmlFor="project-id">Project ID</label>
          <div className="input-row">
            <input id="project-id" inputMode="numeric" pattern="[1-9][0-9]*" value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="例如 123" disabled={pending !== null || Boolean(state?.fatalError)} />
            <button type="submit" disabled={pending !== null || !projectId || Boolean(state?.fatalError)}>添加</button>
          </div>
        </form>
        <div className="project-list" aria-label="已登记 Project">
          {state?.projects.length === 0 && <p className="empty">尚未登记 Project。</p>}
          {state?.projects.map((project) => (
            <article className="project-item" key={project.id}>
              <div><strong>{project.name}</strong><span>Project #{project.id}</span></div>
              <button
                className="ghost danger"
                disabled={pending !== null || project.removing || state.publicationProjectId === project.id}
                onClick={() => void mutate(`remove-${project.id}`, `/api/projects/${encodeURIComponent(project.id)}`, "DELETE", {})}
              >{project.removing ? "停止并移除中" : "移除"}</button>
            </article>
          ))}
        </div>
        <a className="log-link" href="/api/logs/current" target="_blank" rel="noreferrer">查看当前会话日志 ↗</a>
      </section>

      <section className="mr-panel" aria-labelledby="mr-heading">
        <header className="panel-header">
          <div><p className="eyebrow">OPEN MERGE REQUESTS</p><h2 id="mr-heading">MR 检视队列</h2></div>
          <button
            className="refresh-button"
            disabled={pending !== null || state?.refreshOperation.status === "refreshing" || Boolean(state?.fatalError) || !state?.projects.length}
            onClick={() => void mutate("refresh", "/api/mrs/refresh", "POST", {})}
          >{state?.refreshOperation.status === "refreshing" ? "刷新中…" : "刷新 MR"}</button>
        </header>
        {state?.fatalError && <Diagnostic error={state.fatalError} />}
        {error && <Diagnostic error={error} />}
        {state?.refreshOperation.error && <Diagnostic error={state.refreshOperation.error} compact />}
        {!state && <div className="loading">正在读取本地状态…</div>}
        {state?.projects.length === 0 && <div className="welcome"><h3>从一个 Project 开始</h3><p>添加 Project ID 后，手动刷新 open MR。ReviewX 不会自动扫描或发布评论。</p></div>}
        <div className="mr-groups">
          {state?.projects.map((project) => (
            <section className="mr-group" key={project.id}>
              <div className="group-title"><h3>{project.name}</h3><span>#{project.id} · 最近刷新 {formatDate(project.refreshedAt)}</span></div>
              {!project.refreshedAt && <p className="empty inset">点击“刷新 MR”取得当前 open MR。</p>}
              {project.refreshedAt && project.mergeRequests.length === 0 && <p className="empty inset">本次刷新未返回 open MR。</p>}
              {project.mergeRequests.map((mr) => (
                <article
                  key={mr.iid}
                  className={`mr-card ${selected?.projectId === project.id && selected.mrIid === mr.iid ? "selected" : ""}`}
                  tabIndex={0}
                  role="button"
                  onClick={() => void chooseMr(project.id, mr.iid)}
                  onKeyDown={(event) => { if (event.key === "Enter") void chooseMr(project.id, mr.iid); }}
                >
                  <div className="mr-main"><span className="iid">!{mr.iid}</span><div><h4>{mr.title}</h4><p>更新于 {formatDate(mr.updatedAt)}</p></div></div>
                  <div className="mr-state">
                    <span className={`status status-${mr.status}`}>{statusLabels[mr.status]}</span>
                    {mr.queuePosition && <span className="queue-position">队列第 {mr.queuePosition} 位</span>}
                    {mr.phase && <span className="phase">{phaseLabels[mr.phase]}</span>}
                  </div>
                  {mr.primaryAction && <button disabled={pending !== null} onClick={(event) => void primaryAction(event, mr)}>
                    {mr.primaryAction === "start" ? "开始检视" : mr.primaryAction === "stop" ? "停止" : "重新检视"}
                  </button>}
                </article>
              ))}
            </section>
          ))}
        </div>
      </section>

      {selected && (
        <aside className="detail-drawer" aria-label="MR 详情抽屉">
          <header className="drawer-header">
            <div><p className="eyebrow">MR DETAIL</p><h2>{detail?.mergeRequest.title ?? "读取中…"}</h2>{detail && <p>{detail.project.name} · !{detail.mergeRequest.iid}</p>}</div>
            <button className="close" aria-label="关闭详情" onClick={() => { detailRequest.current += 1; setSelected(null); setDetail(null); }}>×</button>
          </header>
          {!detail && <div className="loading">正在读取 attempt 历史…</div>}
          {detail && detail.attempts.length === 0 && <div className="empty drawer-empty">该 MR 尚无检视 attempt。</div>}
          {detail && detail.attempts.length > 0 && (
            <>
              <div className="attempt-tabs" role="tablist" aria-label="Attempt 历史">
                {detail.attempts.map((attempt, index) => (
                  <button key={attempt.id} className={attempt.id === activeAttempt?.id ? "active" : ""} onClick={() => setOpenAttemptId(attempt.id)}>
                    <span>{index === 0 ? "最新" : `历史 ${detail.attempts.length - index}`}</span>
                    <strong>{statusLabels[attempt.status]}</strong>
                    <small>{formatDate(attempt.createdAt)}</small>
                  </button>
                ))}
              </div>
              {activeAttempt && (
                <section className="attempt-detail">
                  <div className="attempt-summary">
                    <div><span>状态</span><strong>{statusLabels[activeAttempt.status]}</strong></div>
                    <div><span>阶段</span><strong>{activeAttempt.phase ? phaseLabels[activeAttempt.phase] : "—"}</strong></div>
                    <div><span>版本</span><strong>{activeAttempt.updatedAt ?? activeAttempt.requestedUpdatedAt}</strong></div>
                    <div><span>Attempt</span><code>{activeAttempt.id}</code></div>
                  </div>
                  {activeAttempt.error && <Diagnostic error={activeAttempt.error} />}
                  {activeAttempt.reportUrl && (
                    <section className="report-section">
                      <div className="section-heading"><h3>完整报告</h3><button className="ghost" disabled={pending !== null} onClick={() => void loadReport(activeAttempt)}>{reports[activeAttempt.id] === undefined ? "加载报告" : "已加载"}</button></div>
                      {reports[activeAttempt.id] !== undefined && <Markdown className="markdown report-preview">{reports[activeAttempt.id]}</Markdown>}
                    </section>
                  )}
                  {activeAttempt.findings.length > 0 && (
                    <section className="findings-section">
                      <div className="section-heading"><div><h3>Findings</h3><p>默认不选择，正文不可编辑。</p></div></div>
                      {activeAttempt.findings.map((finding) => {
                        const canSelect = selectable && activeAttempt.id === latestAttempt?.id && finding.status === "pending";
                        const checked = selectedOrdinals.includes(finding.ordinal);
                        return (
                          <article className="finding-card" key={finding.ordinal}>
                            <header>
                              <label className={canSelect ? "selectable" : ""}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={!canSelect}
                                  onChange={(event) => setSelectedOrdinals((current) => event.target.checked
                                    ? [...current, finding.ordinal].sort((a, b) => a - b)
                                    : current.filter((value) => value !== finding.ordinal))}
                                />
                                <span>{severityLabels[finding.severity]}</span>
                              </label>
                              <span className={`finding-status finding-${finding.status}`}>{findingLabels[finding.status]}</span>
                            </header>
                            <Markdown>{finding.body}</Markdown>
                            {finding.error && <Diagnostic error={finding.error} compact />}
                          </article>
                        );
                      })}
                      {activeAttempt.id === latestAttempt?.id && (
                        <div className="publish-bar">
                          <span>已选择 {selectedOrdinals.length} 项</span>
                          <button
                            disabled={!selectable || selectedOrdinals.length === 0 || pending !== null}
                            onClick={() => void mutate(`publish-${activeAttempt.id}`, `/api/attempts/${encodeURIComponent(activeAttempt.id)}/publish`, "POST", { ordinals: selectedOrdinals })}
                          >发布选中意见</button>
                        </div>
                      )}
                    </section>
                  )}
                </section>
              )}
            </>
          )}
        </aside>
      )}
    </main>
  );
}
