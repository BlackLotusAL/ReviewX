import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { freezeReviewRules, ruleAssetsRoot } from "@/src/server/review/rules";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
test("rules freeze content independently of edits without a material delivery protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "rules-")); roots.push(root);
  await mkdir(join(root, "nested")); await writeFile(join(root, "nested", "ignored.md"), "ignore");
  await writeFile(join(root, "b.md"), "business"); await writeFile(join(root, "a.md"), "expression");
  const first = await freezeReviewRules(root, undefined, undefined, {}, root);
  await writeFile(join(root, "b.md"), "changed");
  const second = await freezeReviewRules(root, undefined, undefined, {}, root);
  expect(first.resources.map(r => r.id)).toEqual(["a.md", "b.md"]);
  expect(first.resources[1].body).toBe("business");
  expect(first.profileHash).not.toBe(second.profileHash);
  expect(ruleAssetsRoot()).toMatch(/resources[\\/]rules$/u);
});
test("invalid encoding and excessive aggregate input are clear preflight errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "rules-")); roots.push(root);
  await writeFile(join(root, "a.md"), Buffer.from([0xff]));
  await expect(freezeReviewRules(root, undefined, undefined, {}, root)).rejects.toMatchObject({ code: "REVIEW_RULE_ERROR" });
  await writeFile(join(root, "a.md"), "a".repeat(1024 * 1024 + 1));
  await expect(freezeReviewRules(root, undefined, undefined, {}, root)).rejects.toMatchObject({ code: "REVIEW_RULE_ERROR" });
});
