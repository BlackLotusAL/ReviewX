'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig, ConfigError } = require('../src/config');
const { validateFinding, renderComment, sortFindings } = require('../src/finding');
const { fileMatches, Rules, parseFrontMatter } = require('../src/rules');
const { Store, findingStates } = require('../src/store');
const { redact } = require('../src/logger');
const { matchExcluded, classify } = require('../src/git');
const { McpHub } = require('../src/mcp');
const { versionOk, buildConfig, cleanEnv } = require('../src/opencode');
const { splitDiff, pickCloneUrl } = require('../src/review');
const { parseCmdShim } = require('../src/proc');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rx-test-'));

function goodFinding(extra) {
  return Object.assign({
    severity: 'major', title: '空配置会中断后续任务', summary: '配置为空时 root 为 null。',
    location: { path: 'src/config/parse.js', start_line: 8, end_line: 9 },
    impact: { consequence: '抛出 TypeError', scope: '新建项目', trigger: '配置文件为空' },
    solutions: [{ description: '先处理空输入', code: { language: 'js', code: 'if (!root) return { entries: [] };' } }],
    evidence: 'src/config/parse.js:8 const root = yaml.parse(source);'
  }, extra || {});
}

test('config: defaults written, bad values rejected with field name', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  const cfg = loadConfig(file);
  assert.equal(cfg.port, 17080);
  assert.ok(fs.existsSync(file));
  fs.writeFileSync(file, JSON.stringify({ concurrency: 0 }));
  assert.throws(() => loadConfig(file), (e) => e instanceof ConfigError && /并发数/.test(e.message));
  fs.writeFileSync(file, JSON.stringify({ nope: 1 }));
  assert.throws(() => loadConfig(file), /未知配置项「nope」/);
  fs.writeFileSync(file, '{oops');
  assert.throws(() => loadConfig(file), /不是有效的 JSON/);
  fs.writeFileSync(file, JSON.stringify({ excludeFileTypes: ['dist/x.js'] }));
  assert.throws(() => loadConfig(file), /排除文件类型/);
});

test('finding: validation reports field and reason; rule names are restricted', () => {
  assert.ok(validateFinding(goodFinding(), []).ok);
  const bad = validateFinding({ severity: 'high', location: {} }, ['安全']);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.startsWith('severity')));
  assert.ok(bad.errors.some((e) => e.startsWith('location.path')));
  assert.ok(bad.errors.some((e) => e.startsWith('evidence')));
  const r = validateFinding(goodFinding({ rule: '编造的规则' }), ['安全']);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /^rule/);
  assert.ok(validateFinding(goodFinding({ rule: '安全', extraField: 1 }), ['安全']).ok);
  assert.equal(validateFinding(goodFinding({ location: { path: '../etc/passwd' } }), []).ok, false);
});

test('finding: comment template and ordering', () => {
  const f = validateFinding(goodFinding({ tags: ['正确性'], prevention: ['补测试'] }), []).finding;
  const body = renderComment(f);
  assert.match(body, /^### 🟠 Major 空配置会中断后续任务/);
  assert.match(body, /\*\*问题位置\*\*：`src\/config\/parse.js:8-9`/);
  assert.match(body, /- 标签：`#正确性`/);
  assert.match(body, /\*\*影响分析\*\*：\n- \*\*直接后果\*\*：抛出 TypeError/);
  assert.match(body, /```js\nif \(!root\)/);
  assert.match(body, /\*\*预防措施\*\*：\n- 补测试/);
  const list = [
    Object.assign({}, f, { severity: 'minor', location: { path: 'a.js', start_line: 1 } }),
    Object.assign({}, f, { severity: 'fatal', location: { path: 'z.js', start_line: 5 } }),
    Object.assign({}, f, { severity: 'minor', location: { path: 'a.js', start_line: 0 } }),
    Object.assign({}, f, { severity: 'minor', location: { path: '', start_line: null } })
  ];
  const s = sortFindings(list);
  assert.deepEqual(s.map((x) => x.severity + x.location.path + x.location.start_line), ['fatalz.js5', 'minora.js0', 'minora.js1', 'minornull']);
});

test('rules: glob matching, built-ins, format errors, selection for review', () => {
  assert.ok(fileMatches('', 'any/file.go'));
  assert.ok(fileMatches('*.java', 'src/a/B.java'));
  assert.ok(fileMatches('src/db/**', 'src/db/x/y.sql'));
  assert.ok(!fileMatches('src/db/**', 'src/web/y.sql'));
  assert.ok(fileMatches('*.ts, src/db/**', 'lib/a.ts'));
  const dir = tmp();
  const rules = new Rules(dir);
  rules.ensureBuiltins();
  assert.equal(rules.all().filter((r) => r.builtin).length, 4);
  fs.mkdirSync(path.join(dir, 'projects', '101'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', '101', 'bad.md'), 'no front matter');
  rules.create('101', { name: 'SQL 拼接', files: 'src/db/**', enabled: true, body: '## 检查要点\n- 参数化查询\n' });
  const sel = rules.forReview('101', ['src/db/q.js']);
  assert.ok(sel.used.some((r) => r.name === 'SQL 拼接'));
  assert.ok(sel.skipped.some((r) => /元信息/.test(r.reason)));
  assert.ok(!rules.forReview('101', ['web/a.js']).used.some((r) => r.name === 'SQL 拼接'));
  assert.ok(!rules.forReview('202', ['src/db/q.js']).used.some((r) => r.name === 'SQL 拼接'));
  const builtin = rules.all().find((r) => r.builtin);
  assert.throws(() => rules.remove(builtin.id), /内置规则/);
  assert.equal(parseFrontMatter('---\nname: "a"\nenabled: true\n---\nbody').meta.enabled, true);
});

test('store: decision replay and append-only records', () => {
  const st = new Store(tmp());
  st.checkVersion('test');
  const recs = [
    { a: 'dismiss', reportId: 'r1', fid: 'f1' }, { a: 'undo', reportId: 'r1', fid: 'f1' },
    { a: 'sending', reportId: 'r1', fid: 'f2' }, { a: 'result', reportId: 'r1', fid: 'f2', result: 'unknown' },
    { a: 'mark', reportId: 'r1', fid: 'f2', result: 'unpublished' },
    { a: 'sending', reportId: 'r1', fid: 'f3' }, { a: 'result', reportId: 'r1', fid: 'f3', result: 'unknown' },
    { a: 'mark', reportId: 'r1', fid: 'f3', result: 'published' },
    { a: 'dismiss', reportId: 'r2', fid: 'f1' }
  ];
  const s = findingStates(recs, 'r1');
  assert.equal(s.f1.state, 'pending');
  assert.equal(s.f2.state, 'failed');
  assert.equal(s.f3.state, 'manual');
  st.appendAttempt('1', '2', { t: 'queued', id: 'a', at: 1 });
  st.appendAttempt('1', '2', { t: 'started', id: 'a', at: 2 });
  st.appendAttempt('1', '2', { t: 'ended', id: 'a', at: 3, status: 'completed', reportId: 'rp1' });
  st.saveReport('1', '2', { id: 'rp1', findings: [] });
  assert.equal(st.attempts('1', '2')[0].status, 'completed');
  assert.equal(st.reports('1', '2').length, 1);
});

test('store: refuses newer data versions', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ formatVersion: 99 }));
  assert.throws(() => new Store(dir).checkVersion('t'), /升级 ReviewX/);
});

test('logger: credentials are redacted', () => {
  assert.equal(redact('clone https://user:s3cret@host/x.git'), 'clone https://***@host/x.git');
  assert.doesNotMatch(redact('private-token: abcdef123456'), /abcdef/);
  assert.doesNotMatch(redact('{"X-Auth-token":"tok_123456789"}'), /tok_1234/);
  assert.doesNotMatch(redact('Authorization: Bearer eyJhbGciOi.xyz'), /eyJhb/);
});

test('git: exclusion matching and error classification', () => {
  const ex = ['.png', '.min.js', 'go.sum'];
  assert.equal(matchExcluded('web/LOGO.PNG', ex), '.png');
  assert.equal(matchExcluded('dist/app.min.js', ex), '.min.js');
  assert.equal(matchExcluded('go.sum', ex), 'go.sum');
  assert.equal(matchExcluded('go.sum/real.go', ex), null);
  assert.equal(matchExcluded('src/app.js', ex), null);
  assert.equal(classify('fatal: Authentication failed for https://x'), 'auth');
  assert.equal(classify('Could not resolve host: x'), 'network');
  assert.equal(classify("fatal: couldn't find remote ref refs/heads/x"), 'missing-branch');
  assert.equal(classify('error: object file is corrupt'), 'corrupt');
});

test('mcp: initialize, list tools, submit and finish', async () => {
  const hub = new McpHub();
  const got = [];
  const token = hub.open({ ruleNames: ['安全'], report: async (a) => { got.push(a); return { ok: true, text: 'ok' }; }, finish: async () => ({ ok: false, text: 'unread' }) });
  const init = await hub.handle(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
  assert.equal((await hub.handle(token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await hub.handle(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.json.result.tools.map((t) => t.name), ['report_finding', 'finish_review']);
  assert.deepEqual(list.json.result.tools[0].inputSchema.properties.rule.enum, ['安全', '']);
  await hub.handle(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'report_finding', arguments: { x: 1 } } });
  assert.equal(got.length, 1);
  const fin = await hub.handle(token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'finish_review', arguments: {} } });
  assert.equal(fin.json.result.isError, true);
  assert.equal((await hub.handle('nope', { jsonrpc: '2.0', id: 5, method: 'ping' })).status, 404);
});

test('opencode: version gate, read-only config, clean environment', () => {
  assert.ok(versionOk('1.18.0'));
  assert.ok(versionOk('opencode 2.0.1'));
  assert.ok(!versionOk('1.17.9'));
  assert.ok(!versionOk(''));
  const c = buildConfig({ mcpUrl: 'http://127.0.0.1:1/mcp/x', excludes: ['.png', 'go.sum'], wrapUp: false });
  assert.equal(c.permission['*'], 'deny');
  assert.equal(c.permission.read['*.png'], 'deny');
  assert.equal(c.permission.read['*/go.sum'], 'deny');
  assert.equal(c.permission.external_directory, 'deny');
  const w = buildConfig({ mcpUrl: 'x', excludes: [], wrapUp: true });
  assert.equal(w.permission.read, 'deny');
  assert.equal(w.tools.grep, false);
  process.env.GIT_SSH_COMMAND = 'x'; process.env.CODEHUB_TOKEN = 'y'; process.env.SOME_API_KEY = 'z';
  const env = cleanEnv();
  assert.equal(env.GIT_SSH_COMMAND, undefined);
  assert.equal(env.CODEHUB_TOKEN, undefined);
  assert.equal(env.SOME_API_KEY, 'z');
  delete process.env.GIT_SSH_COMMAND; delete process.env.CODEHUB_TOKEN; delete process.env.SOME_API_KEY;
});

test('review helpers: diff splitting and clone URL choice', () => {
  const big = ['diff --git a/x b/x', '--- a/x', '+++ b/x'];
  for (let h = 0; h < 6; h++) { big.push('@@ -1 +1 @@'); for (let i = 0; i < 500; i++) big.push('+line ' + i); }
  const parts = splitDiff(big.join('\n'));
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.startsWith('diff --git')));
  assert.equal(splitDiff('small').length, 1);
  assert.equal(pickCloneUrl({ https: 'https://h/x.git', ssh: 'git@h:x.git' }, 'ssh'), 'git@h:x.git');
  assert.equal(pickCloneUrl(['git@h:x.git', 'https://h/x.git'], 'https'), 'https://h/x.git');
});

test('proc: npm .cmd shim resolves to a direct command', () => {
  const dir = tmp();
  const shim = path.join(dir, 'tool.cmd');
  fs.writeFileSync(shim, '@ECHO off\r\nSETLOCAL\r\n"%dp0%\\node_modules\\tool\\bin\\tool.exe"   %*\r\n');
  assert.equal(parseCmdShim(shim).cmd, path.join(dir, 'node_modules', 'tool', 'bin', 'tool.exe'));
  fs.writeFileSync(shim, '@IF EXIST "%dp0%\\node.exe" (\r\n  "%_prog%"  "%dp0%\\node_modules\\x\\cli.js" %*\r\n)');
  const r = parseCmdShim(shim);
  assert.equal(r.cmd, process.execPath);
  assert.equal(r.prefix[0], path.join(dir, 'node_modules', 'x', 'cli.js'));
});
