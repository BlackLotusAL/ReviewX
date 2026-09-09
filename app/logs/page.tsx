"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseSessionLog } from "@/src/shared/session-log";

export default function LogsPage() {
  const [text, setText] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState(false);
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const entries = useMemo(() => parseSessionLog(text ?? ""), [text]);

  useEffect(() => {
    let disposed = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let request: AbortController | null = null;
    const isVisible = () => document.visibilityState === "visible";

    async function refresh() {
      if (disposed || request || !isVisible()) return;
      const controller = new AbortController();
      request = controller;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
      try {
        const response = await fetch("/api/logs/current", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = await response.text();
        if (disposed || controller.signal.aborted) return;
        setText(next);
        setConnectionError(false);
      } catch {
        if (!disposed && isVisible() && (!controller.signal.aborted || timedOut)) setConnectionError(true);
      } finally {
        clearTimeout(timeout);
        request = null;
      }
    }

    function syncVisibility() {
      clearInterval(interval);
      if (!isVisible()) {
        request?.abort();
        return;
      }
      void refresh();
      interval = setInterval(() => void refresh(), 2_000);
    }

    document.addEventListener("visibilitychange", syncVisibility);
    syncVisibility();
    return () => {
      disposed = true;
      clearInterval(interval);
      request?.abort();
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && followTail.current) viewport.scrollTop = viewport.scrollHeight;
  }, [text]);

  useEffect(() => {
    // Fonts and viewport changes can reflow existing log lines after a fetch.
    const observer = new ResizeObserver(() => {
      const viewport = viewportRef.current;
      if (viewport && followTail.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(contentRef.current!);
    return () => observer.disconnect();
  }, []);

  return <main className="log-page" aria-label="当前会话日志" tabIndex={0} ref={viewportRef} onScroll={(event) => {
    const viewport = event.currentTarget;
    followTail.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 32;
  }}>
    <h1 className="sr-only">当前会话日志</h1>
    <div className="session-log" ref={contentRef}>
      {entries.map((entry) => <pre key={entry.line} className={`log-entry${entry.level ? ` log-entry-${entry.level.toLowerCase()}` : ""}`}>
        {entry.timestamp !== null && <><span className="log-timestamp">[{entry.timestamp}]</span>{" "}<span className="log-level">[{entry.level}]</span></>}{entry.body}
      </pre>)}
    </div>
    {text === null && !connectionError && <p className="log-notice" role="status">正在读取日志…</p>}
    {text !== null && entries.length === 0 && <p className="log-notice" role="status">当前会话暂无日志。</p>}
    {connectionError && <p className="log-notice log-notice-error" role="status">暂时无法读取日志，正在自动重试…</p>}
  </main>;
}
