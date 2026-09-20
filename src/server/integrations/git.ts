import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import type { MergeRequestSnapshot, ProjectRecord } from "@/src/shared/types";
import { resolveCommand } from "@/src/server/platform/resolve-command";
import type { DataPaths } from "../platform/paths";
import { runProcess } from "../platform/process";
import { Redactor } from "../platform/redaction";
import { digest, REVIEW_LIMITS, reviewError, safeRepositoryPath, stable, textPages } from "@/src/server/review/materials";
import type { FixedContext, TextPage } from "@/src/server/review/types";
import type { ReviewChange, ReviewScope, Revision } from "@/src/shared/review-contract";

export interface PreparedReview {
  rootDirectory: string;
  sourceSha: string;
  targetSha: string;
  baseSha: string;
  context: FixedContext;
  cleanup(): Promise<void>;
}
export interface GitPreparerPort { prepare(project: ProjectRecord, details: MergeRequestSnapshot, signal: AbortSignal): Promise<PreparedReview> }
type Entry = { mode: string; oid: string; size: number };
const shaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

export class GitPreparer implements GitPreparerPort {
  constructor(private readonly paths: DataPaths, private readonly environment: NodeJS.ProcessEnv = process.env) {}
  async prepare(project: ProjectRecord, details: MergeRequestSnapshot, signal: AbortSignal): Promise<PreparedReview> {
    const redactor = new Redactor(this.environment);
    let url: URL;
    try { url = new URL(project.cloneUrl); } catch { throw reviewError("INVALID_GIT_REMOTE", "无效仓库 URL。"); }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash || redactor.containsCredential(project.cloneUrl)) throw reviewError("INVALID_GIT_REMOTE", "仓库 URL 必须为无凭据 HTTPS。");
    if (redactor.containsCredential(JSON.stringify(details))) throw reviewError("SENSITIVE_REVIEW_INPUT", "MR 元数据包含疑似凭据。");
    const command = await resolveCommand("git", this.environment);
    await mkdir(this.paths.workspaces, { recursive: true });
    const root = await mkdtemp(join(this.paths.workspaces, "review-"));
    const repository = join(root, "objects");
    const task = join(root, "task");
    const hooks = join(root, "empty-hooks");
    await mkdir(hooks); await mkdir(task);
    const run = async (args: string[], currentSignal = signal, limit = REVIEW_LIMITS.diffBytes): Promise<Buffer> => {
      currentSignal.throwIfAborted();
      const result = await runProcess(command, ["--literal-pathspecs", "-c", `core.hooksPath=${hooks}`, "-c", "fetch.fsckObjects=true", "-c", "core.fsmonitor=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "core.quotePath=false", ...args], {
        env: { ...this.environment, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_NO_REPLACE_OBJECTS: "1", LANG: "C", LC_ALL: "C" },
        signal: currentSignal, timeoutMs: 10 * 60_000, maxOutputBytes: limit + 1024, binaryOutput: true,
      });
      if (result.exitCode !== 0 || result.aborted || result.timedOut || result.outputLimitExceeded) throw reviewError(currentSignal.aborted ? "GIT_CANCELLED" : "GIT_ERROR", "Git 对象读取失败、取消或超限。");
      if (result.stdoutBuffer!.length > limit) throw reviewError("REVIEW_INCOMPLETE", "Git 材料超过大小限制。");
      return result.stdoutBuffer!;
    };
    const git = (args: string[], s = signal, limit = REVIEW_LIMITS.diffBytes) => run(["-C", repository, ...args], s, limit);
    const decode = (buffer: Buffer) => { try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { throw reviewError("REVIEW_INCOMPLETE", "文件不是有效 UTF-8 文本。"); } };
    const cleanup = async () => {
      const rel = relative(resolve(this.paths.workspaces), resolve(root));
      if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Unsafe cleanup path");
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    };
    try {
      await run(["check-ref-format", "--branch", details.sourceBranch]); await run(["check-ref-format", "--branch", details.targetBranch]);
      await run(["init", "--bare", "--template=", repository]);
      await git(["remote", "add", "origin", project.cloneUrl]);
      for (const [branch, ref] of [[details.sourceBranch, "source"], [details.targetBranch, "target"]]) {
        await git(["fetch", "--no-tags", "--no-recurse-submodules", "origin", "--", `+refs/heads/${branch}:refs/reviewx/${ref}`]);
      }
      const revision = async (ref: string) => {
        const sha = decode(await git(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
        if (!shaPattern.test(sha)) throw reviewError("INVALID_GIT_OUTPUT", "无效固定修订。"); return sha;
      };
      const sourceSha = await revision("refs/reviewx/source"), targetSha = await revision("refs/reviewx/target");
      const bases = decode(await git(["merge-base", "--all", targetSha, sourceSha])).trim().split(/\s+/u);
      if (bases.length !== 1 || !shaPattern.test(bases[0])) throw reviewError("REVIEW_INCOMPLETE", "无法确定唯一 merge-base。");
      const baseSha = bases[0];
      const trees: Record<Revision, Map<string, Entry>> = { source: new Map(), base: new Map() };
      for (const side of ["source", "base"] as const) {
        const listing = decode(await git(["ls-tree", "-r", "-l", "-z", side === "source" ? sourceSha : baseSha]));
        for (const item of listing.split("\0").filter(Boolean)) {
          const match = /^(\d+) \w+ ([a-f0-9]+)\s+([\d-]+)\t([\s\S]+)$/u.exec(item);
          if (!match) throw reviewError("INVALID_GIT_OUTPUT", "无法读取 Git 树。");
          trees[side].set(match[4], { mode: match[1], oid: match[2], size: Number(match[3]) });
        }
      }
      const read = async (side: Revision, path: string, s: AbortSignal): Promise<TextPage[]> => {
        if (!safeRepositoryPath(path)) throw reviewError("UNSAFE_FILE_PATH", "拒绝越界或 Windows 特殊路径。");
        const entry = trees[side].get(path);
        if (!entry || !["100644", "100755"].includes(entry.mode) || !Number.isFinite(entry.size) || entry.size > REVIEW_LIMITS.blobBytes) throw reviewError("REVIEW_INCOMPLETE", "路径不存在或不是可审文本文件。");
        const bytes = await git(["cat-file", "blob", entry.oid], s, REVIEW_LIMITS.blobBytes);
        const objectId = createHash(entry.oid.length === 40 ? "sha1" : "sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        if (objectId !== entry.oid) throw reviewError("REVIEW_SOURCE_CHANGED", "Git blob 与固定对象 ID 不符。");
        if (bytes.includes(0)) throw reviewError("REVIEW_INCOMPLETE", "不支持二进制文件。");
        const text = decode(bytes);
        if (redactor.containsCredential(text)) throw reviewError("SENSITIVE_REVIEW_INPUT", "文件内容命中敏感输入规则。");
        return textPages(text);
      };
      const status = decode(await git(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames", baseSha, sourceSha, "--"])).split("\0").filter(Boolean);
      const changes: ReviewChange[] = [], diffs = new Map<string, TextPage[]>();
      let diffBytes = 0;
      for (let i = 0; i < status.length;) {
        const type = status[i++][0], first = status[i++], second = type === "R" || type === "C" ? status[i++] : first;
        if (!first || !second) throw reviewError("INVALID_GIT_OUTPUT", "变更索引不完整。");
        const oldPath = type === "A" ? undefined : first, newPath = type === "D" ? undefined : second;
        const changeId = digest(stable({ baseSha, sourceSha, type, oldPath, newPath })).slice(0, 24);
        const patch = decode(await git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", baseSha, sourceSha, "--", ...new Set([first, second])]));
        if (redactor.containsCredential(patch)) throw reviewError("SENSITIVE_REVIEW_INPUT", "差异内容命中敏感输入规则。");
        diffBytes += Buffer.byteLength(patch); if (diffBytes > REVIEW_LIMITS.diffBytes) throw reviewError("REVIEW_INCOMPLETE", "完整 diff 超过上限。");
        const change: ReviewChange = { changeId, type, oldPath, newPath, diffHash: digest(patch), diffPages: 0,
          hunks: [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu)].map((m) => ({ baseStart: +m[1], baseCount: m[2] === undefined ? 1 : +m[2], sourceStart: +m[3], sourceCount: m[4] === undefined ? 1 : +m[4] })) };
        try {
          if (oldPath) await read("base", oldPath, signal); if (newPath) await read("source", newPath, signal);
          const pages = textPages(patch); diffs.set(changeId, pages); change.diffPages = pages.length;
        } catch (error) {
          if (signal.aborted || (error as { code?: string }).code === "SENSITIVE_REVIEW_INPUT") throw error;
          change.unsupported = "变更包含不支持的路径、文件类型、编码或页面大小。";
        }
        changes.push(change);
      }
      const baseScope = { targetSha, sourceSha, baseSha, changes };
      const scope: ReviewScope = { ...baseScope, scopeHash: digest(stable(baseScope)) };
      const context: FixedContext = { scope, read, diff(id) { const pages = diffs.get(id); if (!pages) throw reviewError("INVALID_REVIEW_SCOPE", "未知或不可审变更。"); return pages; },
        async search(side, query, offset, s) {
          const entries = [...trees[side].keys()].sort(); const matches: Array<{ path: string; line: number }> = []; const limitations: string[] = [];
          let scanned = 0, index = offset;
          for (; index < entries.length && scanned < 100 && matches.length < 50; index++, scanned++) {
            try {
              const pages = await read(side, entries[index], s);
              let found = 0;
              for (const page of pages) page.content.split("\n").forEach((line, n) => { if (line.includes(query) && found++ < 10) matches.push({ path: entries[index], line: page.startLine + n }); });
              if (found > 10) limitations.push("单文件匹配超过十处，请读取该文件全部页面。");
            } catch (error) {
              if (s.aborted || (error as { code?: string }).code === "SENSITIVE_REVIEW_INPUT") throw error;
              limitations.push("搜索跳过非文本或超限的未修改文件。");
            }
          }
          return { matches, nextOffset: index < entries.length ? index : null, limitations: [...new Set(limitations)] };
        },
      };
      return { rootDirectory: task, sourceSha, targetSha, baseSha, context, cleanup };
    } catch (error) { await cleanup().catch(() => undefined); throw error; }
  }
}
