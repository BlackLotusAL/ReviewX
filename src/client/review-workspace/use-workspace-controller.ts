"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AppStateView, AttemptView, FindingStatus, MrDetailView, MrRowView, SafeErrorView } from "@/src/shared/types";
import { createPreviewDataSource, liveReviewData, type ReviewPreviewData } from "@/src/client/review-workspace/review-data";
import { statusLabels, phaseLabels, findingLabels, isBusy } from "./presentation";

interface Selection { projectId: string; mrIid: string; title: string; trigger: HTMLElement }
interface ActionError { key: string; scope: "project" | "page" | "finding"; error: SafeErrorView }

function diagnosticText(error: unknown): SafeErrorView {
  if (error && typeof error === "object" && "code" in error && "message" in error) return error as SafeErrorView;
  return {
    code: "CLIENT_ERROR", message: error instanceof Error ? error.message : String(error), cause: "网页请求未成功完成。",
    impact: "当前操作未确认。", nextStep: "查看当前会话日志并核对操作结果。", technicalDetails: error instanceof Error ? error.message : String(error),
  };
}
export function useWorkspaceController(previewData?: ReviewPreviewData) {
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

  return { state, dataSource, projectId, setProjectId, projectFeedback, setProjectFeedback, pending, disabled, actionError, pollError, announce, mutate, addProject, selected, chooseMr, primaryAction, clock, refreshing, detail, detailError, loadDetail, activeAttempt, latestAttempt, beginClose, dismissDrawer, setOpenAttemptId, reports, reportErrors, reportLoading, loadReport, decideFinding, announcement };
}

export type WorkspaceController = ReturnType<typeof useWorkspaceController>;
