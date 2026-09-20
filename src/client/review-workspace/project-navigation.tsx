"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { WorkspaceController } from "./use-workspace-controller";
import { Button, Diagnostic, Icon, Skeleton } from "@/app/components/ui";
import { projectTree, projectShortName, projectAnchor, navigateTo, type ProjectTreeNode } from "@/src/client/review-workspace/workspace-navigation";

export function ProjectNavigation({ state, pollError, dataSource, disabled, pending, mutate, announce, projectId, setProjectId, projectFeedback, setProjectFeedback, actionError, addProject }: Pick<WorkspaceController, "state" | "pollError" | "dataSource" | "disabled" | "pending" | "mutate" | "announce" | "projectId" | "setProjectId" | "projectFeedback" | "setProjectFeedback" | "actionError" | "addProject">) {
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => projectTree(state?.projects ?? []), [state]);
  function renderTree(nodes: ProjectTreeNode[], depth = 0): ReactNode {
    return <ul className={`project-tree ${depth > 4 ? "depth-capped" : ""}`}>{nodes.map(node => {
      if (node.kind === "project") {
        const project = node.project;
        return <li key={`project-${project.id}`}><article className="project-item" key={project.id}>
          <Icon name="folder" /><div className="project-copy"><button className="project-locate" aria-label={`定位项目 ${project.name}`} onClick={() => navigateTo(projectAnchor(project.id))}><strong title={project.name}>{projectShortName(project.name)}</strong></button>
            <a className="mono project-id-link" href={project.webUrl} target="_blank" rel="noreferrer noopener" aria-label={dataSource.readOnly ? `示例 Project #${project.id}` : `在 CodeHub 打开 Project #${project.id}`} onClick={dataSource.readOnly ? event => event.preventDefault() : undefined} onAuxClick={dataSource.readOnly ? event => event.preventDefault() : undefined}>#{project.id}<Icon name="external" /></a>
          </div>
          <Button variant="quiet" className="remove-button" disabled={disabled || project.removing || state?.publicationProjectId === project.id} busy={project.removing || pending === `remove-${project.id}`} onClick={async () => {
            if (await mutate(`remove-${project.id}`, `/api/projects/${encodeURIComponent(project.id)}`, "DELETE", {}, "project")) { setProjectFeedback(""); announce("项目已移除。"); }
          }}>{project.removing ? "移除中" : "移除"}</Button>
        </article></li>;
      }
      const expanded = !collapsedDirectories.has(node.path);
      return <li key={`directory-${node.path}`}>
        <button className="directory-toggle" aria-expanded={expanded} onClick={() => setCollapsedDirectories(previous => {
          const next = new Set(previous);
          if (next.has(node.path)) next.delete(node.path); else next.add(node.path);
          return next;
        })}><Icon name="chevron" /><Icon name="folder" /><span>{node.name}</span></button>
        {expanded && renderTree(node.children, depth + 1)}
      </li>;
    })}</ul>;
  }

  return (<section className="project-panel" aria-labelledby="project-heading">
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
        {renderTree(tree)}
      </div>}
      <div className="sidebar-footer"><a className="log-link" href="/logs" target="_blank" rel="noreferrer"><Icon name="document" />查看当前会话日志<Icon name="external" /></a></div>
    </section>);
}
