import type { ProjectView } from "../shared/types";

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
    ...rows.filter(({ mr }) => mr.status === "reviewing" || mr.status === "stopping"),
    ...rows.filter(({ mr }) => mr.status === "queued")
      .sort((a, b) => (a.mr.queuePosition ?? Infinity) - (b.mr.queuePosition ?? Infinity)),
  ];
}

export const projectAnchor = (id: string) => `project-${encodeURIComponent(id)}`;
export const mrAnchor = (projectId: string, iid: string) => `mr-${encodeURIComponent(projectId)}-${encodeURIComponent(iid)}`;

export function navigateTo(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
