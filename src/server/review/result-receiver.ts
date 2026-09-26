import { z } from "zod";
import { AppError } from "../errors";
import { Redactor } from "../platform/redaction";
import type { Revision, ReviewChange, ReviewSubmission, FrozenRules, ReviewProgress, Receipt, ReviewDiagnostic } from "@/src/shared/review-contract";
import type { FixedContext, NativeMessage } from "./types";
import { REVIEW_LIMITS, digest, stable, reviewError, textPages, safeRepositoryPath } from "./materials";
import { findingSchema, submissionEnvelopeSchema } from "./schema";

function terminalDetails(fields: Record<string, unknown>) {
  return Object.entries(fields).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join("\n");
}

export class ResultReceiver {
  readonly receipts: Receipt[] = [];
  readonly required = new Set<string>();
  readonly delivered = new Set<string>();
  readonly ranges: Array<{ revision: Revision; path: string; startLine: number; endLine: number }> = [];
  readonly unsupported = new Set<string>();
  readonly limitations = new Set<string>();
  readonly calls = new Map<string, { input: string; output: string }>();
  readonly diagnostics: ReviewDiagnostic[] = [];
  private candidateLimitations: string[] = [];
  private skippedReads = new Map<string, string>();
  private submitSignature = "";
  candidate?: ReviewSubmission;
  closed = false;
  fatal = false;
  private bytes = 0;
  private indexPages: ReviewChange[][] = [];
  constructor(readonly sessionID: string, readonly context: FixedContext, readonly rules: FrozenRules,
    private readonly signal: AbortSignal, private readonly redactor: Redactor, private readonly progress?: (progress: ReviewProgress) => void) {
    let page: ReviewChange[] = [];
    for (const change of context.scope.changes) {
      if (Buffer.byteLength(JSON.stringify([...page, change])) > REVIEW_LIMITS.contentBytes) { this.indexPages.push(page); page = []; }
      page.push(change);
      if (change.unsupported) {
        this.unsupported.add(change.changeId);
        this.limitations.add(`跳过不支持变更：${change.newPath ?? change.oldPath ?? change.changeId}（${change.unsupported}）。`);
        continue;
      }
      for (let i = 0; i < change.diffPages; i++) this.required.add(`diff:${change.changeId}:${i}`);
    }
    if (context.scope.changes.length && this.unsupported.size === context.scope.changes.length) this.limitations.add("没有可审变更；全部变更已排除。");
    this.indexPages.push(page);
    this.indexPages.forEach((_, i) => this.required.add(`index:${i}`));
    for (const resource of rules.resources) textPages(resource.body).forEach((_, i) => this.required.add(`rule:${resource.id}:${i}`));
  }
  snapshot(): ReviewProgress { return { toolCount: this.receipts.length, deliveredMaterials: [...this.required].filter((k) => this.delivered.has(k)).length, requiredMaterials: this.required.size, limitations: [...new Set([...this.limitations, ...this.skippedReads.values(), ...this.candidateLimitations])] }; }
  async initialize() {
    if (this.rules.resources.some((r) => digest(r.body) !== r.resourceHash)) throw reviewError("REVIEW_RULE_ERROR", "冻结规则哈希不符。");
    for (const c of this.context.scope.changes) if (!c.unsupported && (c.type === "D" || c.type === "R") && c.oldPath) {
      try {
        const pages = await this.context.read("base", c.oldPath, this.signal);
        pages.forEach((_, i) => this.required.add(`read:base:${c.oldPath}:${i}`));
      } catch (error) {
        this.signal.throwIfAborted();
        if (!(error instanceof AppError) || error.code !== "REVIEW_INCOMPLETE") throw error;
        this.required.add(`read:base:${c.oldPath}:0`);
        this.skippedReads.set(`base:${c.oldPath}`, `跳过读取：base:${c.oldPath}（${error.reason}）`);
      }
    }
  }
  async call(tool: string, input: unknown, owner: { sessionID: string; messageID: string; callID: string }): Promise<string> {
    try {
      this.signal.throwIfAborted();
      if (this.closed || this.fatal || owner.sessionID !== this.sessionID || !owner.messageID || !owner.callID) throw reviewError("INVALID_REVIEW_OWNERSHIP", "工具不属于当前有效会话。");
      const key = `${owner.messageID}/${owner.callID}`;
      const inputHash = digest(stable({ tool, input }));
      const cached = this.calls.get(key);
      if (cached) { if (cached.input !== inputHash) throw reviewError("REVIEW_CONFLICT", "重复调用标识的参数发生变化。"); return cached.output; }
      let pendingCandidate: ReturnType<ResultReceiver["prepareSubmission"]> | undefined;
      let pendingDiagnostic: ReviewDiagnostic | undefined;
      let output: unknown;
      let delivered: string | undefined;
      let range: typeof this.ranges[number] | undefined;
      const pageField = z.number().int().nonnegative();
      try {
      if (tool === "reviewx_index") {
        const { page } = z.strictObject({ page: pageField }).parse(input);
        if (!this.indexPages[page]) throw reviewError("REVIEW_REQUEST_INVALID", "未知页码，请依据 totalPages 请求。");
        output = { ...this.context.scope, changes: this.indexPages[page], page, totalPages: this.indexPages.length,
          rules: this.rules.resources.map((r) => ({ id: r.id, version: r.version, resourceHash: r.resourceHash, pages: textPages(r.body).length })),
          requiredBase: this.indexPages[page].filter((c) => !c.unsupported && (c.type === "D" || c.type === "R")).map((c) => c.oldPath) };
        delivered = `index:${page}`;
      } else if (tool === "reviewx_diff") {
        const a = z.strictObject({ changeId: z.string(), page: pageField }).parse(input);
        const change = this.context.scope.changes.find((c) => c.changeId === a.changeId);
        if (!change) throw reviewError("REVIEW_REQUEST_INVALID", "未知 changeId，请先读取索引。");
        if (this.unsupported.has(a.changeId)) {
          output = { ...a, totalPages: 0, oldPath: change.oldPath, newPath: change.newPath, note: `跳过不支持变更：${change.unsupported}` };
        } else {
          const pages = this.context.diff(a.changeId); if (!pages[a.page]) throw reviewError("REVIEW_REQUEST_INVALID", "未知页码，请依据 totalPages 请求。");
          output = { ...a, ...pages[a.page], totalPages: pages.length, oldPath: change.oldPath, newPath: change.newPath,
            evidenceNote: "Diff lines are not file evidence. Before citing an evidence entry, use reviewx_read for that exact revision and path." }; delivered = `diff:${a.changeId}:${a.page}`;
        }
      } else if (tool === "reviewx_read") {
        const a = z.strictObject({ revision: z.enum(["source", "base"]), path: z.string(), page: pageField }).parse(input);
        if (!safeRepositoryPath(a.path)) throw reviewError("UNSAFE_FILE_PATH", "拒绝越界或非法路径。");
        let pages;
        try { pages = await this.context.read(a.revision, a.path, this.signal); }
        catch (error) {
          if (error instanceof AppError && error.code === "REVIEW_INCOMPLETE" && !this.signal.aborted) this.skippedReads.set(a.revision + ":" + a.path, `跳过读取：${a.revision}:${a.path}（${error.reason}）`);
          throw error;
        }
        this.skippedReads.delete(a.revision + ":" + a.path); if (!pages[a.page]) throw reviewError("REVIEW_REQUEST_INVALID", "未知页码，请依据 totalPages 请求。");
        if (a.revision === "base" && this.context.scope.changes.some(c => !c.unsupported && (c.type === "D" || c.type === "R") && c.oldPath === a.path)) pages.forEach((_, i) => this.required.add(`read:base:${a.path}:${i}`));
        output = { ...a, ...pages[a.page], sha: a.revision === "base" ? this.context.scope.baseSha : this.context.scope.sourceSha, totalPages: pages.length };
        delivered = `read:${a.revision}:${a.path}:${a.page}`; range = { revision: a.revision, path: a.path, startLine: pages[a.page].startLine, endLine: pages[a.page].endLine };
      } else if (tool === "reviewx_search") {
        const a = z.strictObject({ revision: z.enum(["source", "base"]), query: z.string().min(1).max(256), offset: pageField }).parse(input);
        output = await this.context.search(a.revision, a.query, a.offset, this.signal);
        for (const limitation of (output as { limitations: string[] }).limitations) this.limitations.add(limitation);
      } else if (tool === "reviewx_rules") {
        const a = z.strictObject({ id: z.string(), page: pageField }).parse(input);
        const resource = this.rules.resources.find((r) => r.id === a.id); if (!resource) throw reviewError("REVIEW_REQUEST_INVALID", "未知规则资源，请先读取索引。");
        const pages = textPages(resource.body); if (!pages[a.page]) throw reviewError("REVIEW_REQUEST_INVALID", "未知页码，请依据 totalPages 请求。");
        output = { ...a, ...pages[a.page], version: resource.version, resourceHash: resource.resourceHash, totalPages: pages.length }; delivered = `rule:${a.id}:${a.page}`;
      } else if (tool === "reviewx_submit") {
        pendingCandidate = this.prepareSubmission(input);
        const signature = digest(stable({ input, submission: pendingCandidate.submission, limitations: pendingCandidate.limitations }));
        pendingCandidate.signature = signature;
        output = { status: "SUBMITTED", accepted: false, completion: pendingCandidate.submission.completion,
          dropped: pendingCandidate.dropped, duplicate: signature === this.submitSignature };
      } else throw reviewError("REVIEW_PERMISSION_VIOLATION", "工具不在允许列表中。");
      } catch (error) {
        this.signal.throwIfAborted();
        if (!(error instanceof z.ZodError) && !(error instanceof AppError && ["REVIEW_REQUEST_INVALID", "REVIEW_INCOMPLETE", "INVALID_REVIEW_SUBMISSION"].includes(error.code))) throw error;
        const reason = error instanceof AppError ? error.reason : error.issues.slice(0, 8).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        output = { status: tool === "reviewx_submit" ? "REJECTED" : "ERROR", accepted: false, error: reason,
          ...(tool === "reviewx_read" && error instanceof AppError && error.code === "REVIEW_INCOMPLETE" ? { note: "Skipped" } : {}) };
        pendingDiagnostic = { code: tool === "reviewx_submit" ? "SUBMISSION_REJECTED" : "MATERIAL_REJECTED", message: reason, tool, callID: owner.callID };
      }
      const serialized = JSON.stringify(output);
      if (this.redactor.containsCredential(serialized)) throw reviewError("SENSITIVE_REVIEW_INPUT", "工具材料命中敏感输入规则。");
      this.bytes += Buffer.byteLength(serialized);
      if (Buffer.byteLength(serialized) > REVIEW_LIMITS.pageBytes || this.bytes > REVIEW_LIMITS.deliveryBytes) throw reviewError("REVIEW_INCOMPLETE", "材料交付超出预算。");
      this.receipts.push({ ...owner, tool, inputHash: digest(stable(input)), outputHash: digest(serialized), material: delivered,
        evidence: range ? { ...range, sha: range.revision === "source" ? this.context.scope.sourceSha : this.context.scope.baseSha } : undefined });
      this.calls.set(key, { input: inputHash, output: serialized });
      if (pendingDiagnostic) this.recordDiagnostic(pendingDiagnostic);
      if (pendingCandidate) {
        this.recordDiagnostic({ code: pendingCandidate.signature === this.submitSignature ? "SUBMISSION_DUPLICATE" : this.candidate ? "SUBMISSION_REPLACED" : "SUBMISSION_CREATED", message: "提交候选已核实。", callID: owner.callID });
        for (const dropped of pendingCandidate.dropped) this.recordDiagnostic({ code: "FINDING_DROPPED", message: dropped.reason, findingIndex: dropped.index, callID: owner.callID });
        if (this.submitSignature !== pendingCandidate.signature) {
          this.candidate = pendingCandidate.submission;
          this.candidateLimitations = pendingCandidate.limitations;
          this.submitSignature = pendingCandidate.signature;
        }
      }
      if (delivered) this.delivered.add(delivered); if (range) this.ranges.push(range); this.progress?.(this.snapshot());
      return serialized;
    } catch (error) { this.fatal = true; throw error instanceof AppError ? error : reviewError("INVALID_REVIEW_SUBMISSION", "工具参数、材料请求或提交不符合合同。"); }
  }
  private recordDiagnostic(event: ReviewDiagnostic) {
    // Bound diagnostic growth independently of model retries.
    if (this.diagnostics.length < 1000) this.diagnostics.push(event);
  }
  private prepareSubmission(input: unknown) {
    if (Buffer.byteLength(JSON.stringify(input)) > REVIEW_LIMITS.submissionBytes) throw reviewError("INVALID_REVIEW_SUBMISSION", "提交超过大小上限。");
    if (this.redactor.containsCredential(JSON.stringify(input))) throw reviewError("SENSITIVE_REVIEW_INPUT", "提交命中敏感输入规则。");
    const envelope = submissionEnvelopeSchema.parse(input);
    const missing = [...this.required].filter(key => !this.delivered.has(key));
    if (envelope.completion === "complete" && (envelope.blockers.length || missing.length)) throw reviewError("REVIEW_INCOMPLETE", "complete 提交仍有 blockers 或缺失材料；请补读或提交 incomplete。");
    const findings: ReviewSubmission["findings"] = [];
    const dropped: Array<{ index: number; reason: string }> = [];
    envelope.findings.forEach((raw, index) => {
      const parsed = findingSchema.safeParse(raw);
      if (!parsed.success) { dropped.push({ index: index + 1, reason: parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ") }); return; }
      try { this.validateFinding(parsed.data); findings.push(parsed.data); }
      catch (error) { if (!(error instanceof AppError)) throw error; dropped.push({ index: index + 1, reason: error.reason }); }
    });
    const limitations = [...envelope.blockers.map(b => "阻塞原因：" + b)];
    if (missing.length) limitations.push(`缺失必需材料：${missing.length} 项。`);
    if (dropped.length) limitations.push(`最终提交丢弃 ${dropped.length} 条无效 Finding；结果为部分完成。`);
    if (envelope.completion === "incomplete" && !limitations.length) limitations.push("模型声明检视未完整完成。");
    const submission: ReviewSubmission = { ...envelope, completion: dropped.length ? "incomplete" : envelope.completion, findings };
    return { submission, limitations, dropped, signature: "" };
  }
  validate(result: ReviewSubmission) {
    if (result.completion === "complete" && (result.blockers.length || [...this.required].some(key => !this.delivered.has(key)))) throw reviewError("REVIEW_INCOMPLETE", "必需材料未完整交付。");
    for (const finding of result.findings) this.validateFinding(finding);
  }
  private validateFinding(f: ReviewSubmission["findings"][number]) {
    if (f.changeIds.some((id) => this.unsupported.has(id)) || f.evidence.some((e) => this.context.scope.changes.some((c) => this.unsupported.has(c.changeId) && (e.revision === "source" ? e.path === c.newPath : e.path === c.oldPath)))) throw reviewError("INVALID_REVIEW_SCOPE", "Finding 引用了已排除的不支持变更。");
    if (f.changeIds.some((id) => !this.context.scope.changes.some((c) => c.changeId === id))) throw reviewError("INVALID_REVIEW_SCOPE", "Finding 引用了无效变更。");
    for (const id of f.changeIds) {
      const change = this.context.scope.changes.find((c) => c.changeId === id)!;
      if (!f.evidence.some((e) => e.revision === "source" ? e.path === change.newPath : e.path === change.oldPath)) throw reviewError("INVALID_REVIEW_EVIDENCE", "Finding 必须引用所关联变更的实际证据。");
    }
    for (const e of f.evidence) {
      let next = e.startLine;
      for (const r of this.ranges.filter((r) => r.revision === e.revision && r.path === e.path).sort((a, b) => a.startLine - b.startLine)) {
        if (r.startLine <= next) next = Math.max(next, r.endLine + 1);
      }
      if (next <= e.endLine) throw reviewError("INVALID_REVIEW_EVIDENCE", "证据行范围未完整交付。");
    }
  }
  accept(messages: NativeMessage[], terminal: { idle: boolean; error: boolean; disconnected: boolean }) {
    if (!this.closed || this.signal.aborted || this.fatal || !terminal.idle || terminal.error || terminal.disconnected || !this.candidate) throw reviewError("OPENCODE_FAILED", "整体执行未正常结束或缺少有效提交。", { technical: terminalDetails({ branch: "terminal", sessionID: this.sessionID, closed: this.closed, aborted: this.signal.aborted, fatal: this.fatal, ...terminal, candidate: !!this.candidate }) });
    const seen = new Set<string>();
    for (const m of messages) {
      if (m.info.sessionID !== this.sessionID || m.info.error) throw reviewError("OPENCODE_FAILED", "会话归属或消息终态异常。", { technical: terminalDetails({ branch: "message", sessionID: this.sessionID, messageID: m.info.id, messageSessionID: m.info.sessionID, error: m.info.error }) });
      for (const p of m.parts.filter((p) => p.type === "tool")) {
        const r = this.receipts.find((r) => r.callID === p.callID && r.messageID === p.messageID && p.messageID === m.info.id && p.sessionID === r.sessionID && p.tool === r.tool);
        if (!r || p.state?.status !== "completed" || typeof p.state.output !== "string" || digest(p.state.output) !== r.outputHash || digest(stable(p.state.input)) !== r.inputHash) throw reviewError("INVALID_REVIEW_DELIVERY", "工具提交或返回材料无法与宿主收据核对。");
        seen.add(`${r.messageID}/${r.callID}`);
      }
    }
    if (seen.size !== this.receipts.length) throw reviewError("INVALID_REVIEW_DELIVERY", "存在未确认交付的工具响应。");
    const last = messages.filter((m) => m.info.role === "assistant").at(-1)?.info;
    if (!last?.time?.completed || last.finish !== "stop" || !last.modelID || !last.providerID) throw reviewError("OPENCODE_FAILED", "缺少正常完成与实际模型证据。", { technical: terminalDetails({ branch: "completion", sessionID: this.sessionID, finish: last?.finish, completed: last?.time?.completed, model: last?.modelID, provider: last?.providerID }) });
    this.validate(this.candidate);
    return { submission: this.candidate, actualModel: { providerID: last.providerID, modelID: last.modelID },
      terminal: { finalMessageID: last.id, finish: "stop" as const, completedAt: last.time.completed, idle: true as const, processExited: true as const, bridgeClosed: true as const } };
  }
}
