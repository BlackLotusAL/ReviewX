/** Small executable repositories; unchanged callers/tests are intentionally outside the legacy bundle. */
export interface QualityFixture {
  id: string;
  label: string;
  positive: boolean;
  changedPath: string;
  expected: string;
  matches: RegExp;
  base: Record<string, string>;
  change: string;
}
const lines = (...text: string[]) => `${text.join("\n")}\n`;
const testHeader = lines('import assert from "node:assert/strict";');
export const qualityFixtures: QualityFixture[] = [
  {
    id: "authorization", label: "真实越权", positive: true, changedPath: "src/policy.mjs",
    expected: "Non-owner member can delete another owner's document after the change.", matches: /越权|所有者|非所有|owner|授权|权限/iu,
    base: {
      "src/policy.mjs": lines('export function canDelete(userId, ownerId, role) {', '  return userId === ownerId || role === "admin";', '}'),
      "src/delete.mjs": lines('import { canDelete } from "./policy.mjs";', 'export function deleteDocument(user, document) {', '  if (!canDelete(user.id, document.ownerId, user.role)) throw new Error("Forbidden");', '  document.deleted = true;', '}'),
      "contract.test.mjs": testHeader + lines('import { deleteDocument } from "./src/delete.mjs";', 'const document = { ownerId: "owner", deleted: false };', 'assert.throws(() => deleteDocument({ id: "stranger", role: "member" }, document), /Forbidden/);', 'assert.equal(document.deleted, false);', 'deleteDocument({ id: "owner", role: "member" }, document);', 'assert.equal(document.deleted, true);'),
    },
    change: lines('export function canDelete(userId, ownerId, role) {', '  return Boolean(userId) || role === "admin";', '}'),
  },
  {
    id: "cross_file_contract", label: "跨文件契约破坏", positive: true, changedPath: "src/lookup.mjs",
    expected: "A wrapper replaces the product return value; unchanged checkout reads undefined price and computes NaN.", matches: /NaN|price|契约|返回.*结构|返回.*类型/iu,
    base: {
      "src/lookup.mjs": lines('export function findProduct(products, id) {', '  return products.find(product => product.id === id) ?? null;', '}'),
      "src/checkout.mjs": lines('import { findProduct } from "./lookup.mjs";', 'export function checkout(products, id, quantity) {', '  const product = findProduct(products, id);', '  if (product === null) throw new Error("Product not found");', '  return product.price * quantity;', '}'),
      "contract.test.mjs": testHeader + lines('import { checkout } from "./src/checkout.mjs";', 'assert.equal(checkout([{ id: "tea", price: 4 }], "tea", 3), 12);', 'assert.throws(() => checkout([], "absent", 1), /Product not found/);'),
    },
    change: lines('export function findProduct(products, id) {', '  return { item: products.find(product => product.id === id) ?? null };', '}'),
  },
  {
    id: "boundary", label: "边界回归", positive: true, changedPath: "src/window.mjs",
    expected: "Adjacent half-open windows both match at their shared endpoint, dispatching the event twice.", matches: /边界|重复|两[个次]|闭区间|半开|endpoint|重复派发/iu,
    base: {
      "src/window.mjs": lines('export function beforeEnd(timestamp, end) {', '  return timestamp < end;', '}'),
      "src/schedule.mjs": lines('import { beforeEnd } from "./window.mjs";', 'export function dispatch(timestamp, windows) {', '  return windows.filter(window => timestamp >= window.start && beforeEnd(timestamp, window.end)).map(window => window.id);', '}'),
      "contract.test.mjs": testHeader + lines('import { dispatch } from "./src/schedule.mjs";', 'const windows = [{ id: "first", start: 0, end: 10 }, { id: "second", start: 10, end: 20 }];', 'assert.deepEqual(dispatch(10, windows), ["second"]);'),
    },
    change: lines('export function beforeEnd(timestamp, end) {', '  return timestamp <= end;', '}'),
  },
  {
    id: "caller_guard", label: "调用方已保护", positive: false, changedPath: "src/read.mjs",
    expected: "The sole public entry validates integer bounds before calling the internal reader; removed guard is redundant.", matches: /./u,
    base: {
      "src/read.mjs": lines('// Internal reader; public requests enter through route.mjs.', 'export function readName(items, index) {', '  if (index < 0 || index >= items.length) throw new RangeError("index");', '  return items[index].name.trim();', '}'),
      "src/route.mjs": lines('import { readName } from "./read.mjs";', 'export function handleRequest(items, index) {', '  if (!Number.isInteger(index) || index < 0 || index >= items.length) return { status: 400 };', '  return { status: 200, name: readName(items, index) };', '}'),
      "package.json": JSON.stringify({ name: "guarded-reader", type: "module", exports: "./src/route.mjs" }),
      "contract.test.mjs": testHeader + lines('import { handleRequest } from "./src/route.mjs";', 'assert.deepEqual(handleRequest([], 0), { status: 400 });', 'assert.deepEqual(handleRequest([{ name: " A " }], -1), { status: 400 });', 'assert.deepEqual(handleRequest([{ name: " A " }], 0.5), { status: 400 });', 'assert.deepEqual(handleRequest([{ name: " A " }], 0), { status: 200, name: "A" });'),
    },
    change: lines('// Internal reader; public requests enter through route.mjs.', 'export function readName(items, index) {', '  return items[index].name.trim();', '}'),
  },
  {
    id: "default_protection", label: "已有默认值保障", positive: false, changedPath: "src/render.mjs",
    expected: "The only caller always normalizes the theme to a string, including omitted/null values; local fallback is redundant.", matches: /./u,
    base: {
      "src/render.mjs": lines('// Internal renderer; app.mjs supplies normalized settings.', 'export function render(config) {', '  const theme = config.theme ?? "light";', '  return theme.toUpperCase();', '}'),
      "src/settings.mjs": lines('export function normalizeSettings(raw) {', '  return { theme: typeof raw.theme === "string" ? raw.theme : "light" };', '}'),
      "src/app.mjs": lines('import { normalizeSettings } from "./settings.mjs";', 'import { render } from "./render.mjs";', 'export function display(raw = {}) {', '  return render(normalizeSettings(raw));', '}'),
      "package.json": JSON.stringify({ name: "normalized-renderer", type: "module", exports: "./src/app.mjs" }),
      "contract.test.mjs": testHeader + lines('import { display } from "./src/app.mjs";', 'assert.equal(display(), "LIGHT");', 'assert.equal(display({ theme: null }), "LIGHT");', 'assert.equal(display({ theme: "dark" }), "DARK");'),
    },
    change: lines('// Internal renderer; app.mjs supplies normalized settings.', 'export function render(config) {', '  return config.theme.toUpperCase();', '}'),
  },
  {
    id: "existing_defect", label: "既有缺陷", positive: false, changedPath: "src/totals.mjs",
    expected: "Empty input returns NaN on both commits. Renaming the local parameter does not introduce this defect.", matches: /./u,
    base: {
      "src/totals.mjs": lines('export function average(orders) {', '  return orders.reduce((sum, order) => sum + order.total, 0) / orders.length;', '}'),
      "src/report.mjs": lines('import { average } from "./totals.mjs";', 'export function summary(orders) { return { average: average(orders) }; }'),
      "contract.test.mjs": testHeader + lines('import { summary } from "./src/report.mjs";', 'assert.equal(summary([{ total: 2 }, { total: 4 }]).average, 3);', '// Capture the existing empty-input defect to verify whether a change introduces it.', 'assert.equal(Number.isNaN(summary([]).average), true);'),
    },
    change: lines('export function average(items) {', '  return items.reduce((sum, item) => sum + item.total, 0) / items.length;', '}'),
  },
];
