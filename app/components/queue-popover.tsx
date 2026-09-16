"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./ui";

export function QueuePopover({ disabled, children }: { disabled: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current!;
    const popup = popupRef.current!;
    const button = anchor.querySelector("button")!;
    const place = () => {
      const rect = button.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = window.innerHeight;
      if (rect.bottom <= 0 || rect.top >= height || rect.right <= 0 || rect.left >= width) {
        setOpen(false);
        return;
      }
      const below = Math.max(0, height - rect.bottom - 24);
      const above = Math.max(0, rect.top - 24);
      const list = popup.querySelector(".queue-list");
      const contentHeight = popup.scrollHeight + (list ? list.scrollHeight - list.clientHeight : 0);
      const naturalHeight = Math.min(32 * parseFloat(getComputedStyle(document.documentElement).fontSize), contentHeight);
      const upwards = below < naturalHeight && above > below;
      popup.style.maxHeight = `${Math.min(32 * parseFloat(getComputedStyle(document.documentElement).fontSize), upwards ? above : below)}px`;
      popup.style.left = `${Math.max(16, Math.min(rect.right - popup.offsetWidth, width - popup.offsetWidth - 16))}px`;
      popup.style.top = `${upwards ? rect.top - popup.offsetHeight - 8 : rect.bottom + 8}px`;
      popup.style.visibility = "visible";
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      button.focus({ preventScroll: true });
    };
    place();
    popup.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    observer.observe(button);
    observer.observe(popup);
    // Content may change without changing the constrained outer height.
    if (popup.firstElementChild) observer.observe(popup.firstElementChild);
    const mutations = new MutationObserver(place);
    mutations.observe(popup, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return <div ref={anchorRef} className="queue-control">
    <Button variant="secondary" icon="chevron" disabled={disabled} aria-expanded={open} aria-controls="current-queue-popup" aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>当前检视队列</Button>
    {open && <div ref={popupRef} id="current-queue-popup" className="queue-popup" role="dialog" aria-modal="false" aria-labelledby="queue-heading" tabIndex={-1}>
      {children(() => setOpen(false))}
    </div>}
  </div>;
}
