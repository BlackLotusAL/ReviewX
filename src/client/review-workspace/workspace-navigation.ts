import type { ProjectView } from "@/src/shared/types";

export type ProjectTreeNode =
  | { kind: "directory"; name: string; path: string; children: ProjectTreeNode[] }
  | { kind: "project"; project: ProjectView };

export function projectShortName(name: string): string {
  return name.split("/").filter(Boolean).at(-1) ?? name;
}

export function projectTree(projects: ProjectView[]): ProjectTreeNode[] {
  const roots: ProjectTreeNode[] = [];
  for (const project of projects) {
    const parts = project.name.split("/").filter(Boolean);
    let children = roots;
    let path = "";
    for (const name of parts.slice(0, -1)) {
      path += `/${name}`;
      let directory = children.find(node => node.kind === "directory" && node.name === name);
      if (!directory || directory.kind !== "directory") {
        directory = { kind: "directory", name, path, children: [] };
        children.push(directory);
      }
      children = directory.children;
    }
    children.push({ kind: "project", project });
  }
  return roots;
}

export function reviewQueue(projects: ProjectView[]) {
  const rows = projects.flatMap(project => project.mergeRequests.map(mr => ({ project, mr })));
  return [
    ...rows.filter(({ mr }) => mr.status === "reviewing" || mr.status === "stopping" || mr.status === "publishing"),
    ...rows.filter(({ mr }) => mr.status === "queued")
      .sort((a, b) => (a.mr.queuePosition ?? Infinity) - (b.mr.queuePosition ?? Infinity)),
    ...rows.filter(({ mr }) => mr.status === "awaiting_confirmation" || mr.status === "publish_failed"),
  ];
}

export const projectAnchor = (id: string) => `project-${encodeURIComponent(id)}`;
export const mrAnchor = (projectId: string, iid: string) => `mr-${encodeURIComponent(projectId)}-${encodeURIComponent(iid)}`;

/** Walk main-list order, retaining the cursor even after its status changes. */
export function nextPendingMr(projects: ProjectView[], cursor: string | null) {
  const rows = projects.flatMap(project => project.mergeRequests);
  const start = rows.findIndex(mr => mrAnchor(mr.projectId, mr.iid) === cursor);
  for (let step = 1; step <= rows.length; step++) {
    const mr = rows[(start + step) % rows.length];
    if (mr.status === "awaiting_confirmation" || mr.status === "publish_failed") return mr;
  }
  return null;
}

export function navigateTo(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  // A sticky heading's visual position no longer identifies the group start.
  const destination = target.closest(".group-title") ? target.closest(".mr-group") ?? target : target;
  destination.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  target.focus({ preventScroll: true });
}
