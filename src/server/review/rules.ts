import { existsSync, readFileSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { digest, reviewError, safeRepositoryPath, stable, textPages } from "@/src/server/review/materials";
import type { FrozenRules, ReviewScope } from "@/src/shared/review-contract";
import { Redactor } from "../platform/redaction";

export function ruleAssetsRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(/* turbopackIgnore: true */ manifest)) {
      try { if (JSON.parse(readFileSync(/* turbopackIgnore: true */ manifest, "utf8")).name === "reviewx") return join(directory, "resources", "review-rules"); } catch { /* continue */ }
    }
    const parent = dirname(directory); if (parent === directory) throw reviewError("REVIEW_RULE_ERROR", "无法定位随包规则资源。"); directory = parent;
  }
}
const ref = z.string().regex(/^[a-zA-Z0-9_.-]+$/u);
const profileSchema = z.strictObject({ version: z.literal(1),
  resources: z.record(ref, z.strictObject({ path: z.string(), version: z.string().min(1) })).default({}),
  languages: z.record(z.string().regex(/^\.[a-z0-9]+$/u), z.array(ref)).default({}),
  projects: z.record(z.string().regex(/^[1-9]\d*$/u), z.array(ref)).default({}),
});
const extensions: Record<string, string[]> = Object.fromEntries([
  ...[".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"].map((e) => [e, ["cpp"]]), [".py", ["python"]], [".pyi", ["python"]],
]);
const builtin = new Set(["general", "comments", "cpp", "python", "qt", "pyqt5", "pyside2"]);
async function approvedText(root: string, path: string): Promise<string> {
  if (!safeRepositoryPath(path)) throw reviewError("REVIEW_RULE_ERROR", "规则资源路径非法。");
  if ((await lstat(/* turbopackIgnore: true */ root)).isSymbolicLink()) throw reviewError("REVIEW_RULE_ERROR", "规则根目录不得为链接。");
  const canonicalRoot = await realpath(root);
  let cursor = root;
  for (const part of path.split("/")) { cursor = join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) throw reviewError("REVIEW_RULE_ERROR", "规则资源不得经过链接或 junction。"); }
  const target = await realpath(cursor), rel = relative(canonicalRoot, target);
  if (!rel || isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === ".." || (await lstat(target)).size > 1024 * 1024) throw reviewError("REVIEW_RULE_ERROR", "规则资源越界或超限。");
  const bytes = await readFile(/* turbopackIgnore: true */ target);
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!body.trim() || body.includes("\0")) throw reviewError("REVIEW_RULE_ERROR", "规则必须是非空 UTF-8 文本。");
  textPages(body); return body;
}
export async function freezeReviewRules(dataRoot: string, projectId: string, scope: ReviewScope, environment = process.env): Promise<FrozenRules> {
  try {
    const userRoot = resolve(dataRoot, "rules");
    let profile = profileSchema.parse({ version: 1 });
    const profileFile = await lstat(join(userRoot, "profile.json")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
    if (profileFile) profile = profileSchema.parse(JSON.parse(await approvedText(userRoot, "profile.json")));
    // An absent profile in an existing rules directory also uses defaults; a broken linked profile does not.
    const selected = new Set(["general", "comments"]);
    const names = new Set(scope.changes.flatMap((c) => [c.oldPath, c.newPath]).filter((p): p is string => !!p));
    for (const path of [...names].sort()) for (const id of profile.languages[extname(path).toLowerCase()] ?? extensions[extname(path).toLowerCase()] ?? []) selected.add(id);
    for (const id of profile.projects[projectId] ?? []) selected.add(id);
    const resources = [];
    const redactor = new Redactor(environment);
    for (const id of selected) {
      if (builtin.has(id) && profile.resources[id]) throw reviewError("REVIEW_RULE_ERROR", "自定义资源不能替换内置规则 ID。");
      const definition = profile.resources[id];
      if (!builtin.has(id) && !definition) throw reviewError("REVIEW_RULE_ERROR", "指定规则资源不存在。");
      const body = await approvedText(builtin.has(id) ? ruleAssetsRoot() : userRoot, builtin.has(id) ? `${id}.md` : definition.path);
      if (redactor.containsCredential(body)) throw reviewError("SENSITIVE_REVIEW_INPUT", "规则命中敏感输入规则。");
      resources.push(Object.freeze({ id, version: builtin.has(id) ? "1" : definition.version, body, resourceHash: digest(body) }));
    }
    return Object.freeze({ profileHash: digest(stable(profile)), resources: Object.freeze(resources) as unknown as typeof resources });
  } catch (error) { if ((error as { code?: string }).code === "SENSITIVE_REVIEW_INPUT") throw error; throw reviewError("REVIEW_RULE_ERROR", "规则 profile 或指定资源缺失、非法、超限或越界。"); }
}
