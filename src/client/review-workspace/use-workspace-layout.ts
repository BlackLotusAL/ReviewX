"use client";

import { useEffect, useRef } from "react";
import type { AppStateView } from "@/src/shared/types";

export function useWorkspaceLayout(state: AppStateView | null) {
  const stickyRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const projectIds = JSON.stringify(state?.projects.map(project => project.id) ?? []);
  useEffect(() => {
    const sticky = stickyRef.current;
    const panel = panelRef.current;
    if (!sticky || !panel) return;
    const measure = () => panel.style.setProperty("--sticky-height", `${sticky.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sticky);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const titles = panelRef.current?.querySelectorAll<HTMLElement>(".group-title");
    if (!titles?.length) return;
    const measure = (title: HTMLElement) => {
      title.parentElement?.style.setProperty("--group-title-height", `${title.getBoundingClientRect().height}px`);
    };
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) measure(entry.target as HTMLElement);
    });
    for (const title of titles) {
      measure(title);
      observer.observe(title);
    }
    return () => observer.disconnect();
  }, [projectIds]);
  return { stickyRef, panelRef };
}
