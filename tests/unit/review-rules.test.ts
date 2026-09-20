import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { freezeReviewRules, ruleAssetsRoot } from "@/src/server/review/rules";
import { digest } from "@/src/server/review/materials";
import type { ReviewScope } from "@/src/shared/review-contract";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(profile?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "reviewx rules ")); roots.push(root); await mkdir(join(root, "rules"));
  if (profile) await writeFile(join(root, "rules/profile.json"), JSON.stringify(profile));
  return root;
}
const scope: ReviewScope = { targetSha: "t", sourceSha: "s", baseSha: "b", scopeHash: "h", changes: ["a.h", "b.py", "c.ui", "d.unknown"].map(newPath => ({ newPath, changeId: newPath, type: "A", diffPages: 1, diffHash: "d", hunks: [] })) };
test("default language rules work without profile; frameworks are explicit", async () => {
  const root = await setup(); const frozen = await freezeReviewRules(root, "1", scope, { NODE_ENV: "test" });
  expect(frozen.resources.map(r => r.id)).toEqual(["general", "comments", "cpp", "python"]);
  expect(ruleAssetsRoot()).toMatch(/resources[\\/]review-rules$/u);
  for (const r of frozen.resources) expect(digest(r.body)).toBe(r.resourceHash);
});
test("explicit project frameworks, extension overrides and knowledge freeze", async () => {
  const root = await setup({ version: 1, resources: { knowledge: { path: "knowledge.md", version: "v2" } }, languages: { ".h": ["python"] }, projects: { "1": ["qt", "pyqt5", "pyside2", "knowledge"] } });
  await writeFile(join(root, "rules/knowledge.md"), "Project facts");
  const frozen = await freezeReviewRules(root, "1", scope, { NODE_ENV: "test" });
  expect(frozen.resources.map(r => r.id)).toEqual(["general", "comments", "python", "qt", "pyqt5", "pyside2", "knowledge"]);
  await writeFile(join(root, "rules/knowledge.md"), "Changed");
  expect(frozen.resources.at(-1)?.body).toBe("Project facts");
  expect((await freezeReviewRules(root, "2", scope, { NODE_ENV: "test" })).resources.map(r => r.id)).toEqual(["general", "comments", "python"]);
});
test.each(["../outside", "https://example.test/rules", "C:/rules", "missing.md"])("explicit bad resource never falls back: %s", async path => {
  const root = await setup({ version: 1, resources: { custom: { path, version: "1" } }, projects: { "1": ["custom"] } });
  await expect(freezeReviewRules(root, "1", scope, { NODE_ENV: "test" })).rejects.toMatchObject({ code: "REVIEW_RULE_ERROR" });
});
test("unknown profile keys and unknown resource IDs fail closed", async () => {
  const root = await setup({ version: 1, includes: ["remote"] });
  await expect(freezeReviewRules(root, "1", scope, { NODE_ENV: "test" })).rejects.toThrow();
  await writeFile(join(root, "rules/profile.json"), JSON.stringify({ version: 1, projects: { "1": ["absent"] } }));
  await expect(freezeReviewRules(root, "1", scope, { NODE_ENV: "test" })).rejects.toThrow();
});
test("junction resources cannot escape the rules root", async () => {
  const root = await setup({ version: 1, resources: { custom: { path: "linked/fact.md", version: "1" } }, projects: { "1": ["custom"] } });
  const outside = await setup(); await writeFile(join(outside, "fact.md"), "outside data");
  await symlink(outside, join(root, "rules/linked"), "junction");
  await expect(freezeReviewRules(root, "1", scope, { NODE_ENV: "test" })).rejects.toMatchObject({ code: "REVIEW_RULE_ERROR" });
});
