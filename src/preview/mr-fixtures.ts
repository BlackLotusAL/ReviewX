import type { ReviewPreviewData } from "@/src/client/review-data";
import type { AttemptStatus, AttemptView, FindingStatus, MergeRequestSnapshot, MrDisplayStatus, MrPrimaryAction, ReviewPhase, SafeErrorView, StoredFinding } from "@/src/shared/types";

interface Example {
  projectId: string;
  iid: string;
  title: string;
  branch: string;
  status: MrDisplayStatus;
  phase?: ReviewPhase;
  result?: "pass" | "findings";
}

const projects = [
  { id: "101", name: "platform/review-engine", target: "main" },
  { id: "202", name: "apps/task-console", target: "release/1.5" },
];

const examples: Example[] = [
  { projectId: "101", iid: "401", title: "补充配置校验", branch: "feat/config-validation", status: "unreviewed" },
  { projectId: "101", iid: "402", title: "为检视队列增加取消信号，确保停止后清理临时工作区", branch: "fix/queue-cancellation", status: "queued", phase: "queued" },
  { projectId: "101", iid: "403", title: "重构差异解析器", branch: "refactor/diff-parser", status: "reviewing", phase: "understanding_changes" },
  { projectId: "101", iid: "404", title: "修复跨文件引用分析中的边界条件，保留必要的调用方上下文", branch: "fix/cross-file-references", status: "reviewing", phase: "verifying_findings" },
  { projectId: "101", iid: "405", title: "整理结构化检视结果与证据引用", branch: "feat/structured-results", status: "reviewing", phase: "finalizing_review" },
  { projectId: "101", iid: "406", title: "优化仓库快照清理", branch: "perf/snapshot-cleanup", status: "stopping", phase: "cleaning_up" },
  { projectId: "101", iid: "407", title: "支持中断超时的模型请求", branch: "fix/model-timeout", status: "stopped", phase: "verifying_findings" },
  { projectId: "202", iid: "601", title: "完善报告加载失败时的诊断信息", branch: "fix/report-diagnostics", status: "review_failed", phase: "verifying_findings" },
  { projectId: "202", iid: "602", title: "统一报告权限、配置读取和问题处理流程，补齐异常场景下的反馈", branch: "feat/review-workflow", status: "awaiting_confirmation", phase: "cleaning_up" },
  { projectId: "202", iid: "603", title: "支持逐条发送检视意见", branch: "feat/finding-publication", status: "publishing" },
  { projectId: "202", iid: "604", title: "修复详情抽屉的键盘焦点", branch: "fix/drawer-focus", status: "completed", phase: "cleaning_up", result: "pass" },
  { projectId: "202", iid: "605", title: "保留问题处理后的完整内容与位置", branch: "fix/finding-layout", status: "completed", phase: "cleaning_up", result: "findings" },
  { projectId: "202", iid: "606", title: "补充评论发送失败与结果未知的反馈", branch: "fix/publication-errors", status: "publish_failed" },
  { projectId: "202", iid: "607", title: "兼容旧版检视历史", branch: "compat/review-history", status: "archived", phase: "cleaning_up" },
];

const reviewError: SafeErrorView = {
  code: "REVIEW_INCOMPLETE", message: "检视未完成。", cause: "必要的调用方上下文尚未取得。",
  impact: "本次不生成可处理意见，已有检视历史仍可查看。", nextStep: "补齐上下文后重新检视。",
  technicalDetails: "Verification round limit reached before required callers were available.",
  stderr: "Missing context: src/services/report-loader.ts\nThe current attempt has been stopped.",
};
const publishError: SafeErrorView = {
  code: "COMMENT_SEND_FAILED", message: "评论发送失败。", cause: "CodeHub 返回了暂时不可用的响应。",
  impact: "该意见未确认发送，其余意见保留当前处理状态。", nextStep: "检查连接和 MR 评论记录后再处理。",
  technicalDetails: "CodeHub comment request returned HTTP 503.",
};

const findingTemplates: Array<Pick<StoredFinding, "severity" | "confidence" | "verificationSummary" | "body" | "evidence">> = [
  {
    severity: "fatal", confidence: 98, verificationSummary: "已核对报告读取入口与项目权限校验，直接访问报告 ID 时缺少项目范围检查。",
    evidence: [{ side: "source", path: "src/services/report-loader.ts", startLine: 42, endLine: 49 }],
    body: "### 报告读取缺少项目范围校验\n\n`readReport` 接收报告 ID 后直接返回内容，没有核对它是否属于当前项目。跨项目请求因此可能读取其他项目的检视报告。\n\n建议在返回正文之前核对报告所属项目。\n\n```ts\nif (report.projectId !== projectId) {\n  throw new Error(\"Report not found\");\n}\n```\n\n位置：`src/services/report-loader.ts:42–49`。",
  },
  {
    severity: "major", confidence: 96, verificationSummary: "已检查空文件与空白文件两条路径，解析异常会提前退出后续检视流程。",
    evidence: [{ side: "source", path: "src/config/parse.ts", startLine: 18, endLine: 26 }],
    body: "### 空配置会中断后续任务\n\n配置文件存在但内容为空时，解析器仍尝试读取首个节点。异常未被转换为可处理的结果，导致后续任务提前结束。\n\n```ts\nif (!source.trim()) {\n  return { entries: [], warnings: [] };\n}\n```\n\n应先处理空输入，再保留现有解析顺序。\n\n位置：`src/config/parse.ts:18–26`。",
  },
  {
    severity: "minor", confidence: 92, verificationSummary: "已核对异常分支，失败后没有重置当前按钮的提交状态。",
    evidence: [{ side: "source", path: "src/ui/finding-actions.tsx", startLine: 63, endLine: 78 }],
    body: "### 请求失败后按钮仍显示提交中\n\n请求成功时会清除 `pending`，失败分支只更新错误信息，按钮会继续显示等待状态。\n\n> 建议在 `finally` 中统一清理提交状态，保留错误说明供用户核对。\n\n位置：`src/ui/finding-actions.tsx:63–78`。",
  },
  {
    severity: "suggestion", confidence: 90, verificationSummary: "已核对当前用例，正常输入有覆盖，但取消和失败恢复场景尚未覆盖。",
    evidence: [{ side: "source", path: "tests/review-workflow.test.ts", startLine: 24, endLine: 57 }],
    body: "### 补充取消和失败恢复用例\n\n建议覆盖以下组合，确认错误提示与后续任务之间的关系。\n\n| 场景 | 预期反馈 | 后续操作 |\n| --- | --- | --- |\n| 请求被取消 | 已停止 | 可重新检视 |\n| 服务暂时不可用 | 保留错误信息 | 可检查连接 |\n| 空配置文件 | 明确空输入结果 | 正常继续 |\n\n位置：`tests/review-workflow.test.ts:24–57`。",
  },
];

function at(minutes: number): string {
  return new Date(Date.parse("2026-09-07T08:00:00.000Z") + minutes * 60_000).toISOString();
}

function makeFindings(statuses: FindingStatus[], minutes: number, legacy = false): StoredFinding[] {
  return statuses.map((status, index) => {
    const finding: StoredFinding = {
      ...structuredClone(findingTemplates[index % findingTemplates.length]), ordinal: index + 1, status,
    };
    if (status === "published") { finding.publishedAt = at(minutes + 4); finding.commentId = `preview-comment-${minutes}-${index + 1}`; }
    if (status === "dismissed") finding.dismissedAt = at(minutes + 5);
    if (status === "failed") finding.error = { ...publishError };
    if (status === "unknown") finding.error = { ...publishError, code: "COMMENT_RESULT_UNKNOWN", message: "发送结果未知。", cause: "请求发送后连接中断，未收到确认。", nextStep: "先核对 MR 评论记录，避免重复发送。" };
    if (legacy) { delete finding.confidence; delete finding.verificationSummary; delete finding.evidence; }
    return finding;
  });
}

function primaryAction(status: MrDisplayStatus): MrPrimaryAction {
  if (status === "unreviewed") return "start";
  if (status === "queued" || status === "reviewing") return "stop";
  return status === "stopping" || status === "publishing" ? null : "rereview";
}

function makeAttempt(mr: MergeRequestSnapshot, status: AttemptStatus, suffix: string, minutes: number, findings: StoredFinding[], result?: "pass" | "findings"): AttemptView {
  const id = `preview-${mr.projectId}-${mr.iid}-${suffix}`;
  return {
    id, projectId: mr.projectId, mrIid: mr.iid, mrTitle: mr.title, status, result,
    requestedUpdatedAt: at(minutes - 2), updatedAt: at(minutes - 2), createdAt: at(minutes),
    startedAt: status === "queued" ? undefined : at(minutes + 1),
    sourceBranch: mr.sourceBranch, targetBranch: mr.targetBranch,
    sourceSha: "a1b2c3d4".repeat(5), targetSha: "b2c3d4e5".repeat(5), baseSha: "c3d4e5f6".repeat(5),
    findings, publishBatches: [], reportUrl: result ? `/api/reports/${id}` : undefined,
    ...(result ? { completedAt: at(minutes + 3) } : {}),
    ...(status === "archived" ? { archivedAt: at(minutes + 4), archivedFromStatus: "completed" as const } : {}),
    ...(status === "stopped" ? { stoppedAt: at(minutes + 3) } : {}),
  };
}

function report(attempt: AttemptView): string {
  return [
    `# MR !${attempt.mrIid} · 检视报告`, "", attempt.mrTitle, "",
    "## 检视概览", "", "| 项目 | 内容 |", "| --- | --- |",
    `| 源分支 | \`${attempt.sourceBranch}\` |`, `| 目标分支 | \`${attempt.targetBranch}\` |`,
    `| 固定提交 | \`${attempt.sourceSha}\` |`, `| 检视标识 | \`${attempt.id}\` |`, "",
    "## 检视结论", "", attempt.result === "pass" ? "未发现证据充分的问题。" : `本次记录 ${attempt.findings.length} 项检视意见，处理结果见问题卡片。`, "",
    ...attempt.findings.flatMap(finding => [finding.body, ""]),
    "## 查证范围", "", "核对了变更代码、相关调用方与已有测试，按固定提交记录结果。", "",
    "```text", `source: ${attempt.sourceSha}`, `base:   ${attempt.baseSha}`, "```", "",
    "## 检视局限", "", "二进制资源未纳入代码查证；部署环境中的实际行为仍需结合运行记录核对。", "",
  ].join("\n");
}

export function createReviewPreviewData(): ReviewPreviewData {
  const data: ReviewPreviewData = {
    referenceTime: at(180),
    state: { revision: 1, refreshOperation: { status: "idle" }, publicationBusy: false, fatalError: null, currentLogUrl: "/api/logs/current",
      projects: projects.map(project => ({ id: project.id, name: project.name, removing: false, refreshedAt: at(180), mergeRequests: [] })) },
    details: {}, reports: {},
  };
  examples.forEach((example, index) => {
    const project = projects.find(item => item.id === example.projectId)!;
    const minutes = index * 7;
    const mr: MergeRequestSnapshot = {
      projectId: project.id, iid: example.iid, title: example.title, state: "open", updatedAt: at(minutes),
      sourceBranch: example.branch, targetBranch: project.target,
      webUrl: `https://codehub.example/${project.name}/merge_requests/${example.iid}`,
    };
    const attempts: AttemptView[] = [];
    if (example.status !== "unreviewed") {
      const statuses: FindingStatus[] = example.status === "awaiting_confirmation" ? ["pending", "pending", "dismissed", "pending"]
        : example.status === "publishing" ? ["published", "pending", "pending", "dismissed"]
        : example.status === "publish_failed" ? ["failed", "unknown", "not_attempted", "pending"]
        : example.status === "archived" ? ["archived", "archived"]
        : example.result === "findings" ? ["published", "dismissed", "published", "dismissed"] : [];
      const result = example.result ?? (statuses.length ? "findings" : undefined);
      const latest = makeAttempt(mr, example.status, "latest", minutes + 2, makeFindings(statuses, minutes), result);
      latest.phase = example.phase;
      if (!["queued", "reviewing", "stopping"].includes(example.status)) {
        latest.reviewFinishedAt = new Date(Date.parse(latest.startedAt!) + [42, 188, 3725, 91, 256][index % 5] * 1000).toISOString();
        if (example.status === "stopped") latest.stoppedAt = latest.reviewFinishedAt;
        else latest.completedAt = latest.reviewFinishedAt;
        latest.findings.forEach((finding, ordinal) => {
          const decidedAt = new Date(Date.parse(latest.reviewFinishedAt!) + (60 + ordinal * 20) * 1000).toISOString();
          if (finding.publishedAt) finding.publishedAt = decidedAt;
          if (finding.dismissedAt) finding.dismissedAt = decidedAt;
        });
        if (example.status === "completed" && latest.findings.length) latest.completedAt = new Date(Date.parse(latest.reviewFinishedAt) + 120_000).toISOString();
        if (example.status === "archived") latest.archivedAt = new Date(Date.parse(latest.reviewFinishedAt) + 180_000).toISOString();
      }
      if (["reviewing", "stopping"].includes(example.status)) {
        latest.startedAt = new Date(Date.parse(data.referenceTime) - [42, 188, 3725, 91][(index - 2) % 4] * 1000).toISOString();
      }
      if (example.status === "review_failed") latest.error = { ...reviewError };
      if (example.status === "publish_failed") latest.error = { ...publishError };
      if (example.status === "publishing") latest.publishBatches = [{ id: `${latest.id}-batch`, selectedOrdinals: [2], currentOrdinal: 2, status: "running", startedAt: new Date(Date.parse(latest.reviewFinishedAt!) + 90_000).toISOString() }];
      attempts.push(latest,
        makeAttempt(mr, "archived", "history-2", minutes - 60, makeFindings(["archived", "archived"], minutes - 60), "findings"),
        makeAttempt(mr, "archived", "history-1", minutes - 120, makeFindings(["archived"], minutes - 120, true), "findings"));
    }
    const latest = attempts[0];
    data.state.projects.find(item => item.id === project.id)!.mergeRequests.push({
      ...mr, status: example.status, phase: example.phase, primaryAction: primaryAction(example.status),
      queuePosition: example.status === "queued" ? 1 : undefined,
      latestAttemptId: latest?.id, latestAttemptUpdatedAt: latest?.updatedAt, error: latest?.error,
      reviewStartedAt: latest?.startedAt, reviewFinishedAt: latest?.reviewFinishedAt,
    });
    data.details[`${project.id}/${mr.iid}`] = { project: { id: project.id, name: project.name, registered: true }, mergeRequest: mr, attempts };
    for (const attempt of attempts) if (attempt.reportUrl) data.reports[attempt.reportUrl] = report(attempt);
  });
  return data;
}
