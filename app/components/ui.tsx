"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { SafeErrorView } from "@/src/shared/types";

const iconPaths = {
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  external: "M14 4h6v6m0-6L10 14M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5",
  refresh: "M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 19.5 10M4.5 14A8 8 0 0 0 17.9 17.9",
  close: "m6 6 12 12M6 18 18 6",
  folder: "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  branch: "M6 6v12m0-8c8 0 12-1 12-4M4 4a2 2 0 1 0 4 0 2 2 0 1 0-4 0M4 20a2 2 0 1 0 4 0 2 2 0 1 0-4 0M16 4a2 2 0 1 0 4 0 2 2 0 1 0-4 0",
  check: "m5 12 4 4L19 6",
  alert: "M12 8v5m0 3v.01M10.3 4.8 2.8 18a1.5 1.5 0 0 0 1.3 2h15.8a1.5 1.5 0 0 0 1.3-2L13.7 4.8a2 2 0 0 0-3.4 0Z",
  clock: "M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  document: "M14 3H5v18h14V8Zm0 0v5h5M8 12h8M8 16h6",
  play: "m8 5 11 7-11 7Z",
  stop: "M6 6h12v12H6Z",
  undo: "M4 10h10a6 6 0 0 1 0 12M4 10l5-5m-5 5 5 5",
  chevron: "m9 5 7 7-7 7",
  send: "m21 3-7 18-4-7-7-4ZM21 3 10 14",
} as const;

export type IconName = keyof typeof iconPaths;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]} /></svg>;
}

export function Button({ children, variant = "primary", busy = false, icon, className = "", type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet"; busy?: boolean; icon?: IconName }) {
  return <button type={type} className={`button button-${variant} ${className}`} aria-busy={busy || undefined} {...props}>
    {busy ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
    {children}
  </button>;
}

export function StatusBadge({ value, children, tone = "neutral", busy = false }: { value: string; children: ReactNode; tone?: "neutral" | "active" | "success" | "error"; busy?: boolean }) {
  const [transition, setTransition] = useState({ value, revision: 0 });
  // A transition belongs to a real value change, never to a polling render.
  if (transition.value !== value) setTransition({ value, revision: transition.revision + 1 });
  return <span className={`status status-${tone}`}>
    {busy ? <span className="spinner" aria-hidden="true" /> : <span className="status-dot" aria-hidden="true" />}
    <span key={transition.revision} className={transition.revision ? "status-change" : undefined}>{children}</span>
  </span>;
}

export function Diagnostic({ error, compact = false }: { error: SafeErrorView; compact?: boolean }) {
  return <section className={`diagnostic ${compact ? "compact" : ""}`} aria-label="错误诊断">
    <div className="diagnostic-title"><Icon name="alert" /><strong>{error.message}</strong></div>
    <dl>
      <div><dt>原因</dt><dd>{error.cause}</dd></div>
      <div><dt>影响</dt><dd>{error.impact}</dd></div>
      <div><dt>下一步</dt><dd>{error.nextStep}</dd></div>
    </dl>
    <details className="technical-details"><summary>技术详情 <Icon name="chevron" /></summary>
      <p className="mono">{error.code}</p><p>{error.technicalDetails}</p>
      {error.stderr && <pre>{error.stderr}</pre>}
      {error.stack && <pre>{error.stack}</pre>}
    </details>
  </section>;
}

export function Skeleton({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={`skeleton-group ${compact ? "compact" : ""}`} aria-busy="true" aria-label={label}>
    <span className="sr-only">{label}</span>
    {[0, 1, 2].map((item) => <div className="skeleton-row" key={item} aria-hidden="true"><span /><span /><span /></div>)}
  </div>;
}

export function DetailDialog({ children, returnFocus, onBeginClose, onDismiss }: { children: ReactNode; returnFocus: HTMLElement | null; onBeginClose: () => void; onDismiss: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current!;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("[data-dialog-close]")?.focus({ preventScroll: true });
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      dialog.close();
      document.body.style.overflow = oldOverflow;
      const destination = returnFocus?.isConnected ? returnFocus : document.getElementById("mr-heading");
      destination?.focus({ preventScroll: true });
    };
  }, [returnFocus]);

  const close = () => {
    if (closeTimer.current) return;
    onBeginClose();
    setClosing(true);
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
    closeTimer.current = setTimeout(onDismiss, delay);
  };

  return <dialog ref={dialogRef} className={`detail-drawer ${closing ? "is-closing" : ""}`} aria-label="MR 详情抽屉" onCancel={(event) => { event.preventDefault(); close(); }}
    onClick={(event) => {
      if (event.target instanceof Element && event.target.closest("[data-dialog-close]")) { close(); return; }
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
    {children}
  </dialog>;
}
