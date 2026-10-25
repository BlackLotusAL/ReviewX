'use strict';
// Regression tests for review findings on PR #1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { safeWrite } = require('../src/review');
const { run } = require('../src/proc');
const { appendJsonl, readJsonl } = require('../src/util');
const { App } = require('../src/app');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rx-fix-'));

function trySymlink(target, link, type) {
  try { fs.symlinkSync(target, link, type); return true; } catch { return false; }
}

test('safeWrite does not follow a linked directory', (t) => {
  const root = tmp();
  const outsideDir = tmp();
  if (!trySymlink(outsideDir, path.join(root, 'linkdir'), 'junction')) { t.skip('cannot create links here'); return; }
  safeWrite(root, 'linkdir/a.diff', 'x');
  assert.deepEqual(fs.readdirSync(outsideDir), []);
  assert.equal(fs.readFileSync(path.join(root, 'linkdir', 'a.diff'), 'utf8'), 'x');
  assert.throws(() => safeWrite(root, '../escape.diff', 'x'), /越出/);
});

test('safeWrite does not follow a linked file', (t) => {
  const root = tmp();
  const outside = path.join(tmp(), 'victim.txt');
  fs.writeFileSync(outside, 'original');
  if (!trySymlink(outside, path.join(root, '.ignore'), 'file')) { t.skip('file symlinks need extra privileges on this machine'); return; }
  safeWrite(root, '.ignore', 'generated');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(root, '.ignore'), 'utf8'), 'generated');
});

test('exportTree writes committed symlinks as plain files', async () => {
  const { execFileSync } = require('child_process');
  const { Git } = require('../src/git');
  const repo = tmp();
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo }).toString().trim();
  g('init', '--quiet');
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: '../../outside' }).toString().trim();
  g('update-index', '--add', '--cacheinfo', '120000,' + blob + ',.ignore');
  g('commit', '--quiet', '-m', 'link');
  const sha = g('rev-parse', 'HEAD');
  const dest = path.join(tmp(), 'copy');
  await new Git({ gitCommand: 'git' }).exportTree(path.join(repo, '.git'), sha, dest);
  const st = fs.lstatSync(path.join(dest, '.ignore'));
  assert.ok(st.isFile() && !st.isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dest, '.ignore'), 'utf8'), '../../outside');
});

test('run() keeps multibyte characters split across stdout chunks', async () => {
  const script = path.join(tmp(), 'emit.js');
  // Write "中文" in two chunks that split the first character's bytes.
  fs.writeFileSync(script, "const b=Buffer.from('{\"p\":\"中文.js\"}\\n');process.stdout.write(b.subarray(0,8));setTimeout(()=>process.stdout.write(b.subarray(8)),50);");
  const lines = [];
  await run({ cmd: process.execPath, prefix: [script] }, [], { onLine: (l) => lines.push(l) });
  assert.deepEqual(lines, ['{"p":"中文.js"}']);
});

test('appendJsonl isolates a torn trailing record', () => {
  const file = path.join(tmp(), 'r.jsonl');
  appendJsonl(file, { a: 'sending', fid: 'f1' });
  fs.appendFileSync(file, '{"a":"result","fi');
  appendJsonl(file, { a: 'result', fid: 'f1', result: 'unknown' });
  assert.deepEqual(readJsonl(file).map((r) => r.a), ['sending', 'result']);
});

test('concurrent project additions both persist', async () => {
  const dir = tmp();
  const app = new App({ dataDir: dir, port: 1, concurrency: 2, codehubCommand: 'codehub', gitCommand: 'git', opencodeCommand: 'opencode', excludeFileTypes: [], opencodeTimeoutMinutes: 2, wrapUpMinutes: 1 });
  app.init();
  let n = 0;
  app.codehub.repoView = async (id) => { await new Promise((r) => setTimeout(r, 30 + (n++) * 10)); return { full_name: 'g/p' + id, web_url: null, clone_urls: null }; };
  const [a, b, c] = await Promise.all([app.addProject('11'), app.addProject('22'), app.addProject('11')]);
  assert.ok(a.ok && b.ok);
  assert.equal(c.ok, false);
  assert.deepEqual(app.activeProjects().map((p) => p.id).sort(), ['11', '22']);
});
