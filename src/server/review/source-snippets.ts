import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import type { StructuredFinding } from "@/src/shared/review-contract";
import { SOURCE_SNIPPET_LINE_LIMIT } from "@/src/shared/review-output-policy";
import { safeRepositoryPath } from "./materials";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CODE_CHARACTERS = 64 * 1024;
const languages: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python", ".c": "c", ".h": "cpp", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
  ".cs": "csharp", ".java": "java", ".kt": "kotlin", ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php",
  ".swift": "swift", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".xml": "xml",
  ".html": "html", ".css": "css", ".scss": "scss", ".sql": "sql", ".sh": "bash", ".ps1": "powershell", ".md": "markdown",
};

function assertContained(root: string, target: string): void {
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("路径越过固定版本工作区");
}

async function sourceLines(rootDirectory: string, revision: string, path: string): Promise<string[]> {
  if (!safeRepositoryPath(path)) throw new Error("路径无效");
  const root = await realpath(rootDirectory), workspace = join(root, revision), target = join(workspace, path);
  const realWorkspace = await realpath(workspace);
  assertContained(root, realWorkspace);
  assertContained(realWorkspace, await realpath(target));
  // Do not follow links even when their destination happens to be inside the workspace.
  for (let current = workspace, i = -1; i < path.split("/").length; i++) {
    if (i >= 0) current = join(current, path.split("/")[i]);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("路径包含链接");
  }
  const file = await open(target, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("文件不是可展示的有界文本文件");
    // Read a bounded buffer, even if the file unexpectedly grows after stat.
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
    if (text.includes("\0")) throw new Error("文件包含二进制内容");
    const lines = text.split(/\r\n|\r|\n/u);
    if (!text || /[\r\n]$/u.test(text)) lines.pop();
    return lines;
  } finally { await file.close(); }
}

/** Only host-read fixed revision source may become a location snippet. */
export async function populateSourceSnippets(rootDirectory: string, findings: StructuredFinding[], signal?: AbortSignal): Promise<string[]> {
  const warnings = new Set<string>();
  const files = new Map<string, Promise<string[]>>();
  for (const finding of findings) for (const location of finding.locations) {
    signal?.throwIfAborted();
    delete location.snippet;
    try {
      const key = location.revision + "/" + location.path;
      let file = files.get(key);
      if (!file) { file = sourceLines(rootDirectory, location.revision, location.path); files.set(key, file); }
      const lines = await file;
      if (!Number.isInteger(location.startLine) || !Number.isInteger(location.endLine) || location.startLine < 1 || location.endLine < location.startLine || location.endLine > lines.length) throw new Error("行号越界");
      const code = lines.slice(location.startLine - 1, Math.min(location.endLine, location.startLine + SOURCE_SNIPPET_LINE_LIMIT - 1)).join("\n");
      if (!code.length || code.length > MAX_CODE_CHARACTERS) throw new Error("片段为空或超过大小限制");
      location.snippet = { language: languages[extname(location.path).toLowerCase()] ?? "text", code };
    } catch {
      // Display enhancement failures are warnings, never incomplete verification or model evidence.
      warnings.add(`无法展示源码：${location.revision}/${location.path}:${location.startLine}-${location.endLine}（文件不可读、路径不安全、非文本、行号越界或片段过大）。`);
    }
  }
  signal?.throwIfAborted();
  return [...warnings];
}
