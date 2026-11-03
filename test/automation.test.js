'use strict';
// Automation phase 1 (R26–R28), the review timeout (R11) and queue handling on failure (R17).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../src/store');
const { ReviewEngine } = require('../src/review');
const { Automation, skipHit } = require('../src/automation');
const { CodeHubError } = require('../src/codehub');
const { saveSettings, editableValues, loadConfig, defaults } = require('../src/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rx-auto-'));
const quiet = { info() {}, warn() {}, error() {} };

// A minimal app around a real Store and ReviewEngine.
function fakeApp(cfgPatch, codehub) {
  const store = new Store(tmp());
  store.checkVersion('test');
  const app = {
    cfg: Object.assign(defaults(), { excludeFileTypes: [] }, cfgPatch || {}),
    store, logger: quiet, paused: null, pauses: [], ended: [],
    codehub: codehub || {},
    project: (pid) => ({ id: pid, path: 'g/p' + pid, cloneUrls: 'https://example.invalid/x.git' }),
    openMr: (pid, iid) => ({ iid, title: 'MR ' + iid, updatedAt: 'v1' }),
    changed() {}, notify() {},
    isPaused() { return Boolean(this.paused); },
    pauseAutomation(info) { this.paused = info; this.pauses.push(info); },
    onReviewEnded(pid, iid) { this.ended.push(pid + '/' + iid); }
  };
  app.engine = new ReviewEngine(app);
  return app;
}

async function settle(engine) {
  for (let i = 0; i < 200 && (engine.pumping || engine.jobs.length); i++) await new Promise((r) => setTimeout(r, 10));
}

test('review timeout counts from step 1 and fails in the step it was in (R11)', async () => {
  const app = fakeApp({ reviewTimeoutMinutes: 0.002, wrapUpMinutes: 0.001 }, {
    // step 1 never answers; only the timeout ends it
    mrView: (pid, iid, o) => new Promise((resolve, reject) => o.signal.addEventListener('abort', () => reject(new CodeHubError('CANCELLED')), { once: true }))
  });
  app.engine.enqueue('1', '7');
  await settle(app.engine);
  const a = app.store.attempts('1', '7')[0];
  assert.equal(a.status, 'failed');
  assert.equal(a.failure.code, 'REVIEW_TIMEOUT');
  assert.equal(a.failure.step, 1);
  assert.equal(a.failure.title, '步骤 1/7 超时');
  assert.equal(a.failure.stopsQueue, false); // steps 1–5: only this review
  assert.deepEqual(app.ended, ['1/7']);
});

test('environment errors stop the queue and pause automation (R17)', async () => {
  const app = fakeApp({}, { mrView: async () => { throw new CodeHubError('AUTH_ERROR'); } });
  app.engine.enqueue('1', '7');
  app.engine.enqueue('1', '8', 'auto');
  await settle(app.engine);
  const a = app.store.attempts('1', '7')[0];
  assert.equal(a.failure.kind, 'env');
  assert.equal(a.failure.stopsQueue, true);
  assert.equal(a.failure.pausesAutomation, true);
  assert.equal(app.pauses.length, 1);
  const b = app.store.attempts('1', '8')[0];
  assert.equal(b.status, 'stopped');
  assert.match(b.stopReason, /队列已停止/);
  assert.equal(b.trigger, 'auto');
});

test('a paused queue starts nothing until resumed', async () => {
  let calls = 0;
  const app = fakeApp({}, { mrView: async () => { calls++; throw new CodeHubError('HTTP_ERROR', 'x', 404); } });
  app.paused = { reason: 'x' };
  app.engine.enqueue('1', '7');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 0);
  assert.equal(app.engine.jobs[0].status, 'queued');
  app.paused = null;
  await app.engine.pump();
  assert.equal(calls, 1);
  // A step 1–5 failure that is not environment-level leaves the queue running.
  assert.equal(app.store.attempts('1', '7')[0].failure.stopsQueue, false);
});

// Automation with a scripted MR list.
function autoApp(cfgPatch) {
  const store = new Store(tmp());
  store.checkVersion('test');
  const app = {
    cfg: Object.assign(defaults(), cfgPatch || {}),
    store, logger: quiet, notes: [], fetch: { active: false },
    mrs: { 1: [] }, reports: {}, attempts: {}, jobs: {}, enq: [],
    activeProjects: () => [{ id: '1' }],
    openMrs: (pid) => app.mrs[pid] || [],
    reviewInfo: (pid, iid) => ({ attempts: app.attempts[pid + '/' + iid] || [], latest: app.reports[pid + '/' + iid] || null }),
    notify(t) { this.notes.push(t); }, changed() {},
    engine: {
      find: (pid, iid) => app.jobs[pid + '/' + iid] || null,
      enqueue: (pid, iid, trigger) => { app.enq.push(iid + ':' + trigger); app.jobs[pid + '/' + iid] = { status: 'queued' }; },
      stopQueue() {}, pump() {}
    }
  };
  app.automation = new Automation(app);
  return app;
}
const mr = (iid, updatedAt, title) => ({ iid, updatedAt, title: title || 'MR ' + iid });

test('auto review: baseline, new MRs, new versions, keywords, once per version (R28)', () => {
  const app = autoApp();
  app.mrs[1] = [mr('1', 'a')];
  app.automation.load(); // first run with auto review on: baseline
  assert.deepEqual(app.automation.autoReview(), []);

  // A new MR, and one whose title has a skip keyword.
  app.mrs[1].push(mr('2', 'a'), mr('3', 'a', 'wip: 草稿'));
  assert.deepEqual(app.automation.autoReview(), ['!2']);
  assert.deepEqual(app.enq, ['2:auto']);

  // Keyword removed later: judged again as a new MR.
  app.mrs[1][2] = mr('3', 'b', '正式提交');
  assert.deepEqual(app.automation.autoReview(), ['!3']);

  // MR 1 gets a report, then a new version.
  app.reports['1/1'] = { mrUpdatedAt: 'a' };
  app.attempts['1/1'] = [{ status: 'completed' }];
  app.mrs[1][0] = mr('1', 'b');
  assert.deepEqual(app.automation.autoReview(), ['!1']);
  // Same version again (e.g. that review failed): not queued again.
  delete app.jobs['1/1'];
  assert.deepEqual(app.automation.autoReview(), []);

  // A new version while a review of that MR is running: queued after it ends.
  app.mrs[1][0] = mr('1', 'c');
  app.jobs['1/1'] = { status: 'running' };
  assert.deepEqual(app.automation.autoReview(), []);
  delete app.jobs['1/1'];
  app.automation.onReviewEnded('1', '1');
  assert.equal(app.enq[app.enq.length - 1], '1:auto');
});

test('auto review respects the switches and the pause', () => {
  const app = autoApp({ autoReviewNewMr: false });
  app.mrs[1] = [];
  app.automation.load();
  app.mrs[1].push(mr('5', 'a'));
  assert.deepEqual(app.automation.autoReview(), []); // new-MR switch off

  // Turning a switch on takes a new baseline: MR 5 stays manual.
  const prev = editableValues(app.cfg);
  app.cfg.autoReviewNewMr = true;
  app.automation.onSettingsChanged(prev);
  assert.deepEqual(app.automation.autoReview(), []);

  app.mrs[1].push(mr('6', 'a'));
  app.automation.pause({ reason: '网络不可用' });
  assert.deepEqual(app.automation.autoReview(), []);
  app.automation.resume();
  assert.deepEqual(app.automation.autoReview(), ['!6']);
});

test('fetch results: environment errors pause, project failures do not (R27)', () => {
  const app = autoApp();
  app.automation.load();
  app.automation.onFetchDone('auto', [{ ok: false, code: 'NETWORK_ERROR', reason: '网络不可用' }, { ok: true }], true);
  assert.equal(app.automation.isPaused(), false);
  app.automation.onFetchDone('manual', [{ ok: false, code: 'NETWORK_ERROR', reason: '网络不可用' }], false);
  assert.equal(app.automation.isPaused(), false); // a single-project retry
  app.automation.onFetchDone('auto', [{ ok: false, code: 'NETWORK_ERROR', reason: '网络不可用' }], true);
  assert.equal(app.automation.isPaused(), true);
  assert.equal(app.automation.state.lastFetch.mode, 'auto');
  app.automation.resume();
  app.automation.onFetchDone('auto', [{ ok: false, code: 'AUTH_ERROR', env: true, reason: '未登录' }], true);
  assert.equal(app.automation.state.paused.code, 'AUTH_ERROR');
  // The pause survives a restart.
  const again = new Automation(app);
  again.load();
  assert.equal(again.isPaused(), true);
});

test('skip keywords match case-insensitively', () => {
  assert.ok(skipHit(['WIP', 'Draft'], 'wip: 调整'));
  assert.ok(skipHit(['[skip-review]'], '修复 [Skip-Review]'));
  assert.ok(!skipHit(['WIP'], '正式提交'));
});

test('settings save: validates every field, writes only non-defaults (R26)', () => {
  const file = path.join(tmp(), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 18080, opencodeTimeoutMinutes: 90, wrapUpMinutes: 80 }));
  const cfg = loadConfig(file);
  const cur = editableValues(cfg);
  const bad = saveSettings(file, cur, { autoFetchIntervalMinutes: 3, wrapUpMinutes: 95, excludeFileTypes: ['src/gen/'], port: 1 });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['autoFetchIntervalMinutes', 'excludeFileTypes', 'port', 'wrapUpMinutes']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).opencodeTimeoutMinutes, 90); // untouched
  const ok = saveSettings(file, cur, { autoFetchIntervalMinutes: 30, skipKeywords: [' WIP ', 'Draft', 'WIP'], wrapUpMinutes: 50, reviewTimeoutMinutes: 60 });
  assert.equal(ok.ok, true);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.port, 18080);
  assert.equal(raw.autoFetchIntervalMinutes, 30);
  assert.equal(raw.opencodeTimeoutMinutes, undefined); // old name dropped
  assert.equal(raw.reviewTimeoutMinutes, undefined); // back to the default: not pinned
  assert.equal(raw.skipKeywords, undefined); // deduplicated to the default
  assert.deepEqual(ok.changed.sort(), ['autoFetchIntervalMinutes', 'reviewTimeoutMinutes', 'wrapUpMinutes']);
  assert.equal(loadConfig(file).autoFetchIntervalMinutes, 30);
});

test('an install that never set dataDir keeps its data in the old default location', () => {
  const home = tmp();
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  try {
    process.env.APPDATA = process.env.XDG_CONFIG_HOME = path.join(home, 'roaming');
    process.env.LOCALAPPDATA = process.env.XDG_DATA_HOME = path.join(home, 'local');
    const file = path.join(home, 'roaming', 'ReviewX', 'config.json');
    assert.equal(loadConfig(file).dataDir, path.join(home, 'roaming', 'ReviewX')); // fresh install: new default
    fs.mkdirSync(path.join(home, 'local', 'ReviewX'), { recursive: true });
    fs.writeFileSync(path.join(home, 'local', 'ReviewX', 'projects.json'), '[]');
    const cfg = loadConfig(file);
    assert.equal(cfg.dataDir, path.join(home, 'local', 'ReviewX'));
    assert.equal(cfg.legacyDataDir, true);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ---- PR #8 review fixes ----

test('wrap-up keeps the configured point unless preparation used it up', () => {
  const { effectiveWrapAt } = require('../src/opencode');
  const now = 1000000;
  // 2-minute timeout, 1-minute wrap-up, steps 1–5 finished at once: wrap up at minute 1.
  assert.equal(effectiveWrapAt(now + 60000, now + 120000, now), now + 60000);
  // Wrap-up point already passed: a few minutes to read the diff, capped at the deadline.
  assert.equal(effectiveWrapAt(now - 1000, now + 3600000, now), now + 300000);
  assert.equal(effectiveWrapAt(now - 1000, now + 120000, now), now + 120000);
});

test('the model export stops when the review is aborted', async () => {
  const { OpenCode } = require('../src/opencode');
  const script = path.join(tmp(), 'slow.js');
  fs.writeFileSync(script, 'setTimeout(() => {}, 20000);');
  const oc = new OpenCode({ opencodeCommand: [process.execPath, script] }, quiet);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 100);
  const t0 = Date.now();
  assert.equal(await oc.modelOf('ses_x', tmp(), ctl.signal), null);
  assert.ok(Date.now() - t0 < 5000);
});

test('no deferred auto review starts for a project being removed', () => {
  const app = autoApp();
  app.removing = new Set();
  app.mrs[1] = [mr('1', 'a')];
  app.automation.load();
  app.reports['1/1'] = { mrUpdatedAt: 'a' };
  app.attempts['1/1'] = [{ status: 'completed' }];
  app.mrs[1][0] = mr('1', 'b');
  app.jobs['1/1'] = { status: 'running' };
  app.automation.autoReview(); // deferred while running
  app.removing.add('1');
  app.automation.forgetProject('1');
  delete app.jobs['1/1'];
  app.automation.onReviewEnded('1', '1');
  assert.deepEqual(app.enq, []);
  // Even with the deferral still recorded, a project being removed is skipped.
  app.automation.state.deferred['1/1'] = true;
  app.automation.onReviewEnded('1', '1');
  assert.deepEqual(app.enq, []);
});

test('changing the CLI concurrency applies to calls already waiting', async () => {
  const { Semaphore } = require('../src/util');
  const sem = new Semaphore(3);
  let running = 0; let peak = 0; const releases = [];
  const job = () => sem.use(() => new Promise((r) => { running++; peak = Math.max(peak, running); releases.push(() => { running--; r(); }); }));
  const all = Array.from({ length: 8 }, job);
  await new Promise((r) => setImmediate(r));
  assert.equal(running, 3);
  sem.setMax(1);
  peak = 0;
  // Finish the three running calls: only one waiter may start in their place.
  for (let i = 0; i < 3; i++) { releases.shift()(); await new Promise((r) => setImmediate(r)); }
  assert.equal(running, 1);
  sem.setMax(4); // more room starts waiters at once
  await new Promise((r) => setImmediate(r));
  assert.equal(running, 4);
  while (releases.length) { releases.shift()(); await new Promise((r) => setImmediate(r)); }
  await Promise.all(all);
  assert.equal(running, 0);
});

test('waiting for a CLI slot ends when the review is aborted', async () => {
  const { CodeHub } = require('../src/codehub');
  const ch = new CodeHub({ codehubCommand: [process.execPath, '-e', ''], concurrency: 1 }, quiet);
  await ch.sem.acquire(); // a fetch holds the only slot
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 50);
  const t0 = Date.now();
  await assert.rejects(ch.mrView('1', '2', { signal: ctl.signal }), (e) => e.code === 'CANCELLED');
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(ch.sem.waiters.length, 0);
  ch.sem.release();
  assert.equal(ch.sem.active, 0);
});

test('a running older version (lock in the old location) blocks startup before data is touched', async () => {
  const http = require('http');
  const { spawn } = require('child_process');
  const home = tmp();
  const roaming = path.join(home, 'roaming'); const local = path.join(home, 'local');
  const legacy = path.join(local, 'ReviewX');
  fs.mkdirSync(path.join(legacy, 'tmp', 'rv-active'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'projects.json'), '[]');
  // A stand-in for the older instance.
  const old = http.createServer((req, res) => { res.end(JSON.stringify({ app: 'ReviewX', version: '1.0.0' })); });
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(legacy, 'instance.json'), JSON.stringify({ pid: process.pid, port: old.address().port }));
  const env = Object.assign({}, process.env, { APPDATA: roaming, LOCALAPPDATA: local, XDG_CONFIG_HOME: roaming, XDG_DATA_HOME: local });
  delete env.REVIEWX_LOCK_DIR; delete env.REVIEWX_CONFIG;
  // The test process stands in for the old pid, so the lock reads as alive.
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'reviewx.js'), '--no-open'], { env });
    let s = ''; p.stdout.on('data', (b) => { s += b; });
    p.on('close', () => resolve(s));
    setTimeout(() => p.kill(), 15000);
  });
  old.close();
  assert.match(out, /ReviewX 已在运行/);
  assert.ok(fs.existsSync(path.join(legacy, 'tmp', 'rv-active')), 'the older instance\'s working files are kept');
});
