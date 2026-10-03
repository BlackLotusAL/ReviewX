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
import { productionPrompt, reviewerPrompt, verifierPrompt, repairPrompt, WORKFLOW_VERSION } from "../review/prompt";
import { httpJson, openResponse, consumeEvents } from "./opencode-http";
import type { PreparedReview } from "./git";
export { productionPrompt } from "../review/prompt";

export interface ReviewOptions { attemptId: string; rules: FrozenRules; onProgress?: (progress: ReviewProgress) => void }
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
    const warnings: string[] = [];
    let url = "", startup = "", sessionID = "", version = "unknown", tail = "";
    let server: ReturnType<typeof runProcess> | undefined, stream: Promise<void> | undefined;
    let exited = false, nativeSubagents = 0;
    const marker = path.join(prepared.rootDirectory, "opencode-process.json");
    let markerWrite: Promise<void> | undefined, markerFailure: unknown;
    const password = randomUUID();
    const headers = { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64"), "content-type": "application/json" };
    const progress = (activity: string) => options.onProgress?.({ activity, limitations: [...warnings] });
    const request = (route: string, body?: unknown, control = true) => httpJson(url + route, {
      headers, body, signal: control ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : signal,
    });
    const createSession = async () => {
      const result = await request("/session", { title: "ReviewX " + options.attemptId }) as { id?: string };
      if (!result?.id) throw reviewError("OPENCODE_CAPABILITY_MISSING", "OpenCode 未返回可用会话 ID。");
      return result.id;
    };
    // A lost POST response is ambiguous: query its session, never resend the generation.
    const generate = async (id: string, agent: string, text: string): Promise<Message> => {
      try { return await request("/session/" + id + "/message", { agent, parts: [{ type: "text", text }] }, false) as Message; }
      catch (error) {
        signal.throwIfAborted();
        warnings.push("生成响应连接中断，已查询原会话；未重发请求。");
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
    let result: ReviewerResult | undefined;
    let primaryError: unknown;
    try {
      signal.throwIfAborted();
      const configDir = path.join(prepared.rootDirectory, "reviewx-config");
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(prepared.rootDirectory, "review-context.json"), JSON.stringify({
        mr: { title: details.title, description: details.description ?? "" }, scope: prepared.scope,
        repositoryRules: prepared.repositoryRules, supplementalRules: options.rules.resources,
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
      if (!Array.isArray(agents) || !["reviewx", "reviewx-rules", "reviewx-bugs", "reviewx-verify", "reviewx-format"].every(name => agents.some(a => a.name === name))) {
        throw reviewError("OPENCODE_CAPABILITY_MISSING", "OpenCode 未加载所需原生代理配置。");
      }
      sessionID = await createSession();
      // Events are observability only; loss must not invalidate output or abort generation.
      stream = (async () => {
        const streamSignal = AbortSignal.any([signal, streamStop.signal]);
        const response = await openResponse(url + "/event", { headers, signal: streamSignal });
        await consumeEvents(response, streamSignal, raw => {
          const event = raw as { type?: string; properties?: { sessionID?: string; info?: { parentID?: string } } };
          if (event.type === "session.created" && event.properties?.info?.parentID === sessionID) { nativeSubagents++; progress("原生子代理正在检视或独立复核"); }
          if (event.type === "session.status" && event.properties?.sessionID === sessionID) progress("OpenCode 正在检视、复核并汇总");
        }, REVIEW_LIMITS.outputBytes);
      })().catch(() => { if (!streamStop.signal.aborted && !signal.aborted) warnings.push("进度事件连接中断；结果通过原生消息接口获取。"); });
      progress("四代理检视与逐问题独立复核");
      const message = await generate(sessionID, "reviewx", productionPrompt + "\nFinal JSON schema:\n" + JSON.stringify(outputSchema));
      const raw = messageText(message);
      // Save raw evidence before formatting or cleanup, including malformed output.
      await writeFile(path.join(prepared.rootDirectory, "raw-output.txt"), raw);
      let parsed = parseReviewOutput(raw);
      let repairRaw: string | undefined;
      if (parsed.errors.length && !signal.aborted) {
        progress("修复输出结构（最多一次）");
        try {
          const repairID = await createSession();
          const repair = await generate(repairID, "reviewx-format", repairPrompt + "\nSchema:\n" + JSON.stringify(outputSchema) +
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
        }
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
          workflowVersion: WORKFLOW_VERSION, scope: prepared.scope, rules: { ...options.rules, resources: [...options.rules.resources, ...prepared.repositoryRules] },
          progress: { activity: "检视输出已生成", limitations: document.limitations }, durationMs: Date.now() - started, status: "ACCEPTED", warnings, metrics: { ...prepared.metrics, nativeSubagents } },
      };
    } catch (error) { primaryError = error; }
    finally {
      streamStop.abort();
      if (sessionID && url) await httpJson(url + "/session/" + sessionID + "/abort", { headers, body: {}, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
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
    }
    if (result) {
      result.cleanupPending = !!this.pendingCleanup;
      result.execution.durationMs = Date.now() - started;
      return result;
    }
    throw primaryError;
  }
}
