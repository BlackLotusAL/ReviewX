#!/usr/bin/env node
'use strict';
// Regenerates the README images in docs/assets/readme/ from the real UI.
//
//   node scripts/readme-screenshots.js
//
// It starts a throwaway ReviewX server (temporary data directory, random port),
// opens /preview (sample data, no CodeHub / Git / OpenCode needed) in a headless
// Chrome or Edge through the DevTools protocol, arranges each scene and saves a
// 2x PNG. No dependencies: Node 22+ ships a WebSocket client.
// Set BROWSER=<path to chrome.exe or msedge.exe> to choose the browser.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const { App } = require('../src/app');
const { createServer } = require('../src/server');

const OUT = path.join(__dirname, '..', 'docs', 'assets', 'readme');
const WIDTH = 1440;
const HEIGHT = 900;

function findBrowser() {
  if (process.env.BROWSER) return process.env.BROWSER;
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const list = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ];
  const found = list.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('没有找到 Chrome 或 Edge，请用 BROWSER 环境变量指定浏览器路径');
  return found;
}

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-shots-data-'));
  const app = new App({ dataDir, port, concurrency: 2, codehubCommand: 'codehub', gitCommand: 'git', opencodeCommand: 'opencode', excludeFileTypes: [], opencodeTimeoutMinutes: 60, wrapUpMinutes: 50 });
  app.init();
  const server = createServer(app);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { port, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

async function startBrowser() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-shots-profile-'));
  const proc = spawn(findBrowser(), [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
    '--force-color-profile=srgb', '--lang=zh-CN', 'about:blank'
  ], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket('ws://127.0.0.1:' + port + wsPath);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  };
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params: params || {}, sessionId }));
  });
  const close = () => {
    try { ws.close(); } catch { /* ignore */ }
    proc.kill();
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), 500);
  };
  return { send, close };
}

async function openPage(browser, url) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => browser.send(method, params, sessionId);
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
  const page = {
    async goto(u) { await call('Page.navigate', { url: u }); await sleep(1500); },
    async eval(expr) {
      const r = await call('Runtime.evaluate', { expression: '(async () => {' + expr + '})()', awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('页面脚本出错：' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
      return r.result.value;
    },
    async shot(name, clip) {
      const r = await call('Page.captureScreenshot', Object.assign({ format: 'png' }, clip ? { clip: Object.assign({ scale: 1 }, clip) } : {}));
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
      console.log('  ' + name);
    }
  };
  await page.goto(url);
  return page;
}

// Helpers injected before each scene: click by data attributes, hide the preview bar.
const PRELUDE = `
  const W = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  if (!document.getElementById('shot-css')) {
    // The UI re-renders constantly, so hide the preview banner with a rule, not inline style.
    const st = document.createElement('style'); st.id = 'shot-css';
    st.textContent = '.preview-bar{display:none!important}';
    document.head.appendChild(st);
  }
  document.documentElement.style.scrollBehavior = 'auto';
`;

function bannerHtml(dark) {
  const c = dark
    ? { bg: '#0f1113', fg: '#f3f4f5', sub: '#a3a8ad', chip: '#1c1f22', chipBd: '#2d3135', logo: '#f3f4f5', logoFg: '#0f1113' }
    : { bg: '#f5f7f8', fg: '#121212', sub: '#62686c', chip: '#ffffff', chipBd: '#e1e3e6', logo: '#121212', logoFg: '#ffffff' };
  const chips = ['只读 AI 检视', '逐条确认后发布', '本机运行', '记录只追加'].map((t) => '<span class="chip">' + t + '</span>').join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${WIDTH}px;height:360px;background:${c.bg};overflow:hidden}
    body{display:flex;align-items:center;justify-content:center;font-family:-apple-system,'Segoe UI','Microsoft YaHei','PingFang SC',sans-serif;color:${c.fg}}
    .wrap{display:flex;flex-direction:column;align-items:center;gap:22px}
    .row{display:flex;align-items:center;gap:22px}
    .logo{display:grid;place-items:center;width:84px;height:84px;border-radius:24px;background:${c.logo};color:${c.logoFg};font-size:44px;font-weight:700;letter-spacing:-0.06em}
    .logo i{display:inline-block;width:10px;height:10px;margin-left:4px;background:#3d9bff;border-radius:50%}
    h1{margin:0;font-size:68px;font-weight:650;letter-spacing:-0.03em}
    p{margin:0;font-size:26px;color:${c.sub}}
    .chips{display:flex;gap:12px}
    .chip{padding:7px 16px;border-radius:999px;border:1px solid ${c.chipBd};background:${c.chip};font-size:17px;color:${c.sub}}
  </style></head><body><div class="wrap">
    <div class="row"><span class="logo"><span>rx<i></i></span></span><h1>ReviewX</h1></div>
    <p>CodeHub 本机辅助检视工具 · AI 负责找问题，你决定什么发出去</p>
    <div class="chips">${chips}</div>
  </div></body></html>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await startBrowser();
  const base = 'http://127.0.0.1:' + server.port;
  try {
    console.log('生成 README 图片 → ' + path.relative(process.cwd(), OUT));

    for (const dark of [false, true]) {
      const page = await openPage(browser, 'data:text/html;charset=utf-8,' + encodeURIComponent(bannerHtml(dark)));
      await page.shot(dark ? 'banner-dark.png' : 'banner-light.png', { x: 0, y: 0, width: WIDTH, height: 360 });
    }

    // 1. Workspace: projects, MR cards, a review in progress.
    let page = await openPage(browser, base + '/preview');
    await page.eval(PRELUDE + `await W(2600);`);
    await page.shot('workspace.png');

    // 2. Report drawer with findings in different states.
    await page.eval(PRELUDE + `
      $('[data-act="open"][data-iid="404"]').click(); await W(1400);
      const d = $('#drawer'); const first = d.querySelector('article[id^="f-"]');
      d.scrollTop = first.offsetTop - 330; await W(400);`);
    await page.shot('report.png');

    // 3. Progress of a running review (7 steps).
    page = await openPage(browser, base + '/preview');
    await page.eval(PRELUDE + `
      await W(400);
      $('[data-act="open"][data-iid="403"]').click(); await W(4200);`);
    await page.shot('progress.png');

    // 4. Rules with 30-day stats and the editor.
    page = await openPage(browser, base + '/preview');
    await page.eval(PRELUDE + `
      $('[data-act="go"][data-view="rules"]').click(); await W(900);`);
    await page.shot('rules.png');
  } finally {
    browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
