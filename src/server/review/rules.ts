import { existsSync, readFileSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, reviewError } from "./materials";
import { AppError } from "../errors";
import type { FrozenRules, RuleResource } from "@/src/shared/review-contract";

export function ruleAssetsRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(/* turbopackIgnore: true */ manifest)) {
      try { if (JSON.parse(readFileSync(/* turbopackIgnore: true */ manifest, "utf8")).name === "reviewx") return join(directory, "resources", "rules"); } catch { /* keep looking */ }
    }
    const parent = dirname(directory);
    if (parent === directory) throw reviewError("REVIEW_RULE_ERROR", "无法定位补充规则目录。");
    directory = parent;
  }
}
export async function freezeReviewRules(_dataRoot: string, _projectId?: string, _scope?: unknown,
  _environment?: Readonly<Record<string, string | undefined>>, root = ruleAssetsRoot()): Promise<FrozenRules> {
  const resources: RuleResource[] = [];
  try {
    const names = await readdir(root).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
    let bytes = 0;
    for (const name of names.filter(n => /\.md$/iu.test(n)).sort()) {
      const file = join(root, name), entry = await lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("补充规则必须为普通文件：" + name);
      bytes += entry.size;
      if (bytes > 1024 * 1024) throw new Error("补充规则总大小超过 1 MiB，请精简内容。");
      const body = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file));
      if (body.includes("\0")) throw new Error("规则包含 NUL：" + name);
      if (body.trim()) resources.push({ id: name, body, resourceHash: digest(body) });
    }
    return { profileHash: digest(JSON.stringify(resources.map(r => [r.id, r.resourceHash]))), resources };
  } catch (error) {
    throw new AppError({ code: "REVIEW_RULE_ERROR", httpStatus: 400, message: "用户补充规则无法加载。",
      reason: error instanceof Error ? error.message : String(error), impact: "本次请求未入队。", nextStep: "修复补充规则后重试。", technical: String(error), cause: error });
  }
}
