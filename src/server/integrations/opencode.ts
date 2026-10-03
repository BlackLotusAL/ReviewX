import { randomUUID } from "node:crypto";
import { writeFile, mkdir, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import type { MergeRequestSnapshot, ReviewerResult } from "@/src/shared/types";
import type { FrozenRules, ReviewProgress } from "@/src/shared/review-contract";
import { renderFinding } from "@/src/shared/finding-markdown";
import { resolveCommand } from "../platform/resolve-command";
import { runProcess } from "../platform/process";
import { reviewError, REVIEW_LIMITS } from "../review/materials";
import { parseReviewOutput, outputSchema } from "../review/schema";
import { productionPrompt, reviewerPrompt, verifierPrompt, repairPrompt, WORKFLOW_VERSION, BALANCED_WORKFLOW_VERSION, discoveryPrompt, batchVerifierPrompt } from "../review/prompt";
import { runBalanced } from "../review/balanced";
import { ReviewTrace } from "../review/trace";
import { httpJson, openResponse, consumeEvents } from "./opencode-http";
import type { PreparedReview } from "./git";
export { productionPrompt } from "../review/prompt";

export interface ReviewOptions { attemptId: string; rules: FrozenRules; onProgress?: (progress: ReviewProgress) => void; trace?: ReviewTrace }
export interface ReviewerPort {
  review(projectId: string, details: MergeRequestSnapshot, prepared: PreparedReview, signal: AbortSignal, options: ReviewOptions): Promise<ReviewerResult>;
  retryCleanup?(): Promise<void>;
}
type Message = { info?: { id?: string; role?: string; modelID?: string; providerID?: string; error?: unknown; time?: { completed?: number } }; parts?: Array<{ type: string; text?: string }> };
const messageText = (m: Message) => (m.parts ?? []).filter(p => p.type === "text").map(p => p.text ?? "").join("\n");
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(reviewError("OPENCODE_CLEANUP_FAILED", "无法确认本次进程退出。")), ms); })]); }
  finally { clearTimeout(timer); }
}
export function nativeConfig(prepared: PreparedReview) {
  const readOnly = { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow",
    external_directory: "deny", bash: { "*": "deny", ...Object.fromEntries(prepared.gitCommands.map(c => [c, "allow"])) } };
  return {
    snapshot: false, share: "disabled", lsp: false, formatter: false,
    permission: readOnly,
    agent: {
      reviewx: { mode: "primary", description: "ReviewX coordinator", prompt: productionPrompt,
        permission: { ...readOnly, task: { "*": "deny", "reviewx-rules": "allow", "reviewx-bugs": "allow", "reviewx-verify": "allow" }, todowrite: "allow" } },
      "reviewx-rules": { mode: "subagent", description: "Independently review scoped project rules", prompt: reviewerPrompt, permission: readOnly },
      "reviewx-bugs": { mode: "subagent", description: "Independently review introduced defects", prompt: reviewerPrompt, permission: readOnly },
      "reviewx-verify": { mode: "subagent", description: "Independently verify one candidate", prompt: verifierPrompt, permission: readOnly },
      "reviewx-format": { mode: "primary", description: "Repair review JSON only", prompt: repairPrompt, permission: { "*": "deny" } },
      "reviewx-discover": { mode: "primary", description: "Comprehensive candidate discovery", prompt: discoveryPrompt, permission: readOnly },
      "reviewx-batch-verify": { mode: "primary", description: "Independent batch verification", prompt: batchVerifierPrompt, permission: readOnly },
    },
  };
}

export class OpenCodeReviewer implements ReviewerPort {
  private pendingCleanup?: Promise<unknown>;
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}
  async retryCleanup(): Promise<void> {
    if (!this.pendingCleanup) return;
    await bounded(this.pendingCleanup, 10_000);
    this.pendingCleanup = undefined;
  }
  async review(_projectId: string, details: MergeRequestSnapshot, prepared: PreparedReview, signal: AbortSignal, options: ReviewOptions): Promise<ReviewerResult> {
    await this.retryCleanup();
    const started = Date.now(), stop = new AbortController(), streamStop = new AbortController();
    const trace = options.trace ?? new ReviewTrace(options.attemptId);
    const balanced = this.environment.REVIEWX_WORKFLOW === "balanced";
    if (this.environment.REVIEWX_WORKFLOW && !["legacy", "balanced"].includes(this.environment.REVIEWX_WORKFLOW)) throw reviewError("REVIEW_CONFIG_ERROR", "REVIEWX_WORKFLOW 必须为 legacy 或 balanced。");
    trace.emit("workflow", { workflowVersion: balanced ? BALANCED_WORKFLOW_VERSION : WORKFLOW_VERSION, scope: prepared.scope, profileHash: options.rules.profileHash });
    const warnings: string[] = [];
    let url = "", startup = "", sessionID = "", version = "unknown", tail = "";
    let server: ReturnType<typeof runProcess> | undefined, stream: Promise<void> | undefined;
    let exited = false, nativeSubagents = 0;
    const marker = path.join(prepared.rootDirectory, "opencode-process.json");
    let markerWrite: Promise<void> | undefined, markerFailure: unknown;
    const password = randomUUID();
    const headers = { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64"), "content-type": "application/json" };
    const progress = (activity: string) => options.onProgress?.({ activity, limitations: [...warnings] });
    const request = (route: string, body?: unknown, control = true) => { trace.http(route, body === undefined ? "GET" : "POST"); return httpJson(url + route, {
      headers, body, signal: control ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : signal,
    }); };
    const createSession = async () => {
      const result = await request("/session", { title: "ReviewX " + options.attemptId }) as { id?: string };
      if (!result?.id) throw reviewError("OPENCODE_CAPABILITY_MISSING", "OpenCode 未返回可用会话 ID。");
      return result.id;
    };
    // A lost POST response is ambiguous: query its session, never resend the generation.
    const generateResponse = async (id: string, agent: string, text: string): Promise<Message> => {
      try { return await request("/session/" + id + "/message", { agent, parts: [{ type: "text", text }] }, false) as Message; }
      catch (error) {
        signal.throwIfAborted();
        warnings.push("生成响应连接中断，已查询原会话；未重发请求。");
        trace.emit("generation.response_lost", { sessionID: id });
        let failures = 0;
        while (!signal.aborted && !exited) {
          try {
            const statuses = await request("/session/status") as Record<string, { type: string }>;
            const messages = await request("/session/" + id + "/message") as Message[];
            const last = messages.filter(m => m.info?.role === "assistant").at(-1);
            if (!statuses[id] || statuses[id].type === "idle") {
              if (last && messageText(last)) return last;
              throw error;
            }
            failures = 0;
          } catch (failure) { if (++failures >= 3) throw failure; }
          await delay(1000);
        }
        signal.throwIfAborted(); throw error;
      }
    };
    const generate = async (id: string, agent: string, text: string): Promise<Message> => {
      trace.generation(id, agent);
      const end = trace.span("generation", { sessionID: id, agent });
      try {
        const message = await generateResponse(id, agent, text);
        trace.message({ ...message, info: { ...message.info, sessionID: id } });
        end(message.info?.error ? "failed" : "complete");
        return message;
      } catch (error) { end(signal.aborted ? "cancelled" : "failed"); throw error; }
    };
    let result: ReviewerResult | undefined;
    let primaryError: unknown;
    try {
      signal.throwIfAborted();
      const configDir = path.join(prepared.rootDirectory, "reviewx-config");
      await mkdir(configDir, { recursive: true });
      // Large rule bodies stay in addressable files; each verifier reads only applicable texts.
      const resources = [...prepared.repositoryRules, ...options.rules.resources];
      const ruleIndex = balanced ? await Promise.all(resources.map(async (resource, index) => {
        const file = `review-rule-${index}.txt`;
        await writeFile(path.join(prepared.rootDirectory, file), resource.body);
        return { id: resource.id, resourceHash: resource.resourceHash, file };
      })) : undefined;
      await writeFile(path.join(prepared.rootDirectory, "review-context.json"), JSON.stringify({
        mr: { title: details.title, description: details.description ?? "" }, scope: prepared.scope,
        repositoryRules: ruleIndex ? ruleIndex.slice(0, prepared.repositoryRules.length) : prepared.repositoryRules,
        supplementalRules: ruleIndex ? ruleIndex.slice(prepared.repositoryRules.length) : options.rules.resources,
        allowedGitCommands: prepared.gitCommands,
        rulePolicy: "Nearer directory wins; explicitly applicable supplements override repository rules. Same-scope conflicts are limitations.",
      }, null, 2));
      const env = { ...this.environment, OPENCODE_CONFIG_DIR: configDir, OPENCODE_CONFIG_CONTENT: JSON.stringify(nativeConfig(prepared)),
        OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
        OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_SHARE: "true", OPENCODE_AUTO_SHARE: "false", OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
        OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: "opencode" };
      const command = await resolveCommand("opencode", env);
      progress("启动 OpenCode 原生检视");
      const endStartup = trace.span("opencode_startup");
      server = runProcess(command, ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: prepared.rootDirectory, env, signal: stop.signal, timeoutMs: REVIEW_LIMITS.timeoutMs,
        outputMode: "tail", maxOutputBytes: 16 * 1024,
        onSpawn: pid => { markerWrite = writeFile(marker, JSON.stringify({ pid })).catch(error => { markerFailure = error; }); },
        onStdout: chunk => { startup = (startup + chunk).slice(-8192); url = startup.match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0] ?? url; },
        onStderr: chunk => { tail = (tail + chunk).slice(-16 * 1024); },
      });
      void server.then(() => { exited = true; }, () => { exited = true; });
      for (let i = 0; i < 120 && !url && !exited; i++) { signal.throwIfAborted(); await delay(250); }
      if (!url) throw reviewError("OPENCODE_START_FAILED", "OpenCode HTTP 服务未启动。", { stderr: tail });
      await markerWrite;
      if (markerFailure) throw reviewError("STATE_WRITE_ERROR", "无法保存进程退出检查记录。", { cause: markerFailure });
      const health = await request("/global/health") as { healthy?: boolean; version?: string };
      if (!health?.healthy) throw reviewError("OPENCODE_CAPABILITY_MISSING", "OpenCode 健康检查不可用。");
      version = health.version ?? "unknown";
      const agents = await request("/agent") as Array<{ name: string }>;
      const requiredAgents = balanced ? ["reviewx-discover", "reviewx-batch-verify", "reviewx-format"] : ["reviewx", "reviewx-rules", "reviewx-bugs", "reviewx-verify", "reviewx-format"];
      if (!Array.isArray(agents) || !requiredAgents.every(name => agents.some(a => a.name === name))) {
        throw reviewError("OPENCODE_CAPABILITY_MISSING", "OpenCode 未加载所需原生代理配置。");
      }
      endStartup();
      sessionID = await createSession();
      // Events are observability only; loss must not invalidate output or abort generation.
      stream = (async () => {
        const streamSignal = AbortSignal.any([signal, streamStop.signal]);
        trace.http("/event", "GET");
        const response = await openResponse(url + "/event", { headers, signal: streamSignal });
        await consumeEvents(response, streamSignal, raw => {
          trace.event(raw);
          const event = raw as { type?: string; properties?: { sessionID?: string; info?: { parentID?: string } } };
          if (event.type === "session.created" && event.properties?.info?.parentID === sessionID) { nativeSubagents++; progress("原生子代理正在检视或独立复核"); }
          if (!balanced && event.type === "session.status" && event.properties?.sessionID === sessionID) progress("OpenCode 正在检视、复核并汇总");
        }, REVIEW_LIMITS.outputBytes);
      })().catch(() => { if (!streamStop.signal.aborted && !signal.aborted) { trace.streamInterrupted(); warnings.push("进度事件连接中断；结果通过原生消息接口获取。"); } });
      let message: Message, raw: string, initialRepairRaw: string | undefined;
      let finalText: string;
      if (balanced) {
        let first = true;
        let discoveryMessage: Message = {};
        const reviewed = await runBalanced({ signal, trace, progress, generate: async (agent, prompt) => {
          const id = first ? sessionID : await createSession(); first = false;
          const generated = await generate(id, agent, prompt);
          if (agent === "reviewx-discover") discoveryMessage = generated;
          return { text: messageText(generated), failed: !!generated.info?.error };
        } });
        message = discoveryMessage; raw = reviewed.raw; initialRepairRaw = reviewed.repairRaw;
        finalText = JSON.stringify(reviewed.document);
      } else {
        progress("四代理检视与逐问题独立复核");
        message = await generate(sessionID, "reviewx", "Review the fixed change. Final JSON schema:\n" + JSON.stringify(outputSchema));
        raw = finalText = messageText(message);
      }
      // Save raw evidence before formatting or cleanup, including malformed output.
      await writeFile(path.join(prepared.rootDirectory, "raw-output.txt"), raw);
      let parsed = parseReviewOutput(finalText);
      let repairRaw: string | undefined = initialRepairRaw;
      if (!balanced && parsed.errors.length && !signal.aborted) {
        progress("修复输出结构（最多一次）");
        const endRepair = trace.span("format_repair");
        try {
          const repairID = await createSession();
          const repair = await generate(repairID, "reviewx-format", "Schema:\n" + JSON.stringify(outputSchema) +
            "\nErrors:\n" + JSON.stringify(parsed.errors) + "\nInput:\n" + (parsed.envelopeValid ? JSON.stringify({ ...parsed.document, findings: parsed.invalid }) : raw));
          repairRaw = messageText(repair);
          const fixed = parseReviewOutput(repairRaw);
          if (parsed.envelopeValid && fixed.document.findings.length < parsed.invalid.length) {
            fixed.document.limitations.push("格式修复后仍有意见缺少必要内容，已隔离。");
            fixed.document.completion = "incomplete";
          }
          if (parsed.envelopeValid) {
            parsed = { ...fixed, envelopeValid: true, document: { ...parsed.document,
              findings: [...parsed.document.findings, ...fixed.document.findings.filter(f => !parsed.document.findings.some(original => JSON.stringify(f) === JSON.stringify(original)))],
              limitations: [...parsed.document.limitations, ...fixed.document.limitations],
              completion: parsed.document.completion === "incomplete" || fixed.document.completion === "incomplete" ? "incomplete" : "complete" } };
          } else parsed = fixed;
          if (repair.info?.error) {
            warnings.push("格式修复会话发生异常，保留可解析条目。");
            parsed.document.completion = "incomplete";
          }
        } catch (error) {
          signal.throwIfAborted(); warnings.push("格式修复未完成：" + (error instanceof Error ? error.message : String(error)));
        } finally { endRepair(); }
      }
      signal.throwIfAborted();
      const document = parsed.document;
      if (parsed.errors.length) document.limitations.push("部分输出结构仍无效，已隔离异常意见：" + parsed.errors.join("; ").slice(0, 4000));
      if (message.info?.error) document.limitations.push("原生检视会话发生异常，仅保留完整输出中的有效意见。");
      document.limitations.push(...prepared.limitations);
      if (!parsed.envelopeValid || parsed.errors.length || message.info?.error || prepared.limitations.length) document.completion = "incomplete";
      // Correct a workspace prefix only when the real repository path is unambiguous.
      // A repository is itself allowed to contain a directory named source or base.
      for (const finding of document.findings) for (const location of finding.locations) {
        const prefix = location.revision + "/";
        if (!location.path.startsWith(prefix)) continue;
        const root = path.join(prepared.rootDirectory, location.revision);
        const original = await lstat(path.join(root, location.path)).catch(() => undefined);
        const relativePath = location.path.slice(prefix.length);
        const corrected = await lstat(path.join(root, relativePath)).catch(() => undefined);
        if (!original && corrected?.isFile()) location.path = relativePath;
      }
      result = {
        findings: document.findings.map(structured => ({ severity: structured.severity, body: renderFinding(structured), structured })),
        submission: document, rawOutput: raw, repairOutput: repairRaw,
        execution: { version: 2, attemptId: options.attemptId, sessionID, opencodeVersion: version,
          actualModel: { providerID: message.info?.providerID ?? "unknown", modelID: message.info?.modelID ?? "unknown" },
          workflowVersion: balanced ? BALANCED_WORKFLOW_VERSION : WORKFLOW_VERSION, scope: prepared.scope, rules: { ...options.rules, resources: [...options.rules.resources, ...prepared.repositoryRules] },
          progress: { activity: "检视输出已生成", limitations: document.limitations }, durationMs: Date.now() - started, status: "ACCEPTED", warnings, metrics: { ...prepared.metrics, nativeSubagents } },
      };
    } catch (error) { primaryError = error; }
    finally {
      // Recover terminal messages/usage even when SSE was lost. Bounded independently of a cancelled review.
      const reconciliationSignal = AbortSignal.timeout(5000);
      const recovered = new Set<string>();
      for (const [id] of trace.sessions) {
        if (reconciliationSignal.aborted || !url || exited) { trace.reconciliationFailure(id); continue; }
        try {
          trace.http("/session/" + id + "/children", "GET");
          const children = await httpJson(url + "/session/" + id + "/children", { headers, signal: reconciliationSignal }) as Array<{ id: string; parentID: string }>;
          if (Array.isArray(children)) for (const child of children) trace.event({ type: "session.created", properties: { info: child } });
          else trace.reconciliationFailure(id);
        } catch { trace.reconciliationFailure(id); }
        if (recovered.has(id)) continue;
        recovered.add(id);
        try {
          trace.http("/session/" + id + "/message", "GET");
          const messages = await httpJson(url + "/session/" + id + "/message", { headers, signal: reconciliationSignal });
          if (Array.isArray(messages)) for (const m of messages) trace.message({ ...m, info: { ...m.info, sessionID: id } });
          else trace.reconciliationFailure(id);
        } catch { trace.reconciliationFailure(id); }
      }
      streamStop.abort();
      const endCleanup = trace.span("opencode_cleanup");
      if (sessionID && url) { trace.http("/session/" + sessionID + "/abort", "POST"); await httpJson(url + "/session/" + sessionID + "/abort", { headers, body: {}, signal: AbortSignal.timeout(3000) }).catch(() => undefined); }
      stop.abort();
      if (server) {
        const cleanup = server.catch(() => undefined).then(async () => { await markerWrite; await unlink(marker).catch(() => undefined); });
        try { await bounded(cleanup, 10_000); }
        catch {
          this.pendingCleanup = cleanup;
          warnings.push("OpenCode 进程退出尚未确认，队列已暂停。");
          if (!result) primaryError = reviewError("OPENCODE_CLEANUP_FAILED", "进程退出未确认，需重试清理。", { cause: primaryError });
        }
      }
      await stream;
      endCleanup(this.pendingCleanup ? "pending" : "complete");
      trace.closeSpans(result ? "complete" : signal.aborted ? "cancelled" : "failed");
      trace.emit("opencode.finished", { outcome: result ? "accepted" : signal.aborted ? "cancelled" : "failed", performance: trace.summary() });
      await trace.flush();
    }
    if (result) {
      result.cleanupPending = !!this.pendingCleanup;
      result.execution.durationMs = Date.now() - started;
      result.execution.performance = trace.summary();
      return result;
    }
    throw primaryError;
  }
}
