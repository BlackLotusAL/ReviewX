'use strict';
// Preview mode: the /preview route and the in-browser sample backend.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const vm = require('vm');

const { App } = require('../src/app');
const { createServer } = require('../src/server');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { Host: '127.0.0.1:' + port } }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
    }).on('error', reject);
  });
}

test('/preview serves the preview page and its scripts', async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-pv-'));
  const app = new App({ dataDir: dir, port, concurrency: 2, codehubCommand: 'codehub', gitCommand: 'git', opencodeCommand: 'opencode', excludeFileTypes: [], opencodeTimeoutMinutes: 2, wrapUpMinutes: 1 });
  app.init();
  const server = createServer(app);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    for (const p of ['/preview', '/preview/']) {
      const r = await get(port, p);
      assert.equal(r.status, 200);
      assert.match(r.type, /text\/html/);
      assert.match(r.body, /<script src="\/preview\.js"><\/script>\s*<script src="\/app\.js">/);
    }
    assert.equal((await get(port, '/preview.js')).status, 200);
    const home = await get(port, '/');
    assert.doesNotMatch(home.body, /preview\.js/);
  } finally {
    server.close();
  }
});

function loadPreview() {
  const window = {};
  const timers = [];
  const ctx = vm.createContext({ window, console, Date, JSON, Math, Promise, setTimeout, clearTimeout, setInterval: (fn, ms) => { const t = setInterval(fn, ms); timers.push(t); return t; }, clearInterval });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'preview.js'), 'utf8'), ctx);
  return { be: window.ReviewXPreview, stop: () => timers.forEach(clearInterval) };
}

test('preview backend: sample data, decisions and project validation', async () => {
  const { be, stop } = loadPreview();
  try {
    const s = await be.request('GET', '/api/state');
    assert.equal(s.preview, true);
    assert.deepEqual(s.projects.map((p) => p.id), ['101', '202', '318']);
    assert.ok(s.queue.some((j) => j.status === 'running'));
    const m404 = s.mrs.find((m) => m.iid === '404');
    assert.equal(m404.stale, true);
    assert.equal(m404.pending, 2);
    assert.equal(m404.verify, 2);

    const d = await be.request('GET', '/api/mr/101/404');
    assert.equal(d.reports.length, 2);
    assert.ok(d.reports[1].findings.some((f) => f.state === 'superseded'));
    const pend = d.reports[0].findings.find((f) => f.state === 'pending');
    const body = { pid: '101', iid: '404', reportId: d.reports[0].id, fid: pend.id };
    await be.request('POST', '/api/findings/dismiss', body);
    assert.equal((await be.request('GET', '/api/mr/101/404')).reports[0].findings.find((f) => f.id === pend.id).state, 'dismissed');
    await be.request('POST', '/api/findings/undo', body);
    await assert.rejects(be.request('POST', '/api/findings/undo', body), /只有标为不发送/);

    assert.equal((await be.request('POST', '/api/projects', { id: 'abc' })).ok, false);
    assert.equal((await be.request('POST', '/api/projects', { id: '999' })).text, '项目不存在或无访问权限');
    assert.equal((await be.request('POST', '/api/projects', { id: '101' })).tone, 'info');
    assert.equal((await be.request('POST', '/api/projects', { id: '512' })).ok, true);
    await assert.rejects(be.request('POST', '/api/reviews', { pid: '101', iid: '403' }), /已有检视/);
    const q = await be.request('POST', '/api/reviews', { pid: '101', iid: '401' });
    assert.equal(q.position, 2);
    await be.request('POST', '/api/reviews/cancel', { pid: '101', iid: '401' });
    const rules = await be.request('GET', '/api/rules');
    assert.ok(rules.rules.some((r) => r.error));
    assert.ok(rules.rules.some((r) => r.draft));
  } finally {
    stop();
  }
});
