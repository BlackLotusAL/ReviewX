'use strict';
// HTTP server: 127.0.0.1 only, Host/Origin checks against other local pages
// (R13), strict CSP so report content can never load anything (R09).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new HttpError(413, '请求过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new HttpError(400, '请求不是有效的 JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data, headers) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, headers || {}));
  res.end(body);
}

function createServer(app) {
  const port = app.port;
  const allowedHosts = new Set(['127.0.0.1:' + port, 'localhost:' + port]);
  const allowedOrigins = new Set(['http://127.0.0.1:' + port, 'http://localhost:' + port]);

  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

  // ---- API ----
  route('GET', '/api/ping', () => ({ app: 'ReviewX', version: app.snapshot().version, pid: process.pid }));
  route('GET', '/api/state', () => app.snapshot());
  route('GET', '/api/mr/:pid/:iid', (p) => app.detail(p.pid, p.iid));
  route('GET', '/api/logs', () => ({ path: app.logger.currentPath(), entries: app.logger.session.slice().reverse() }));

  route('POST', '/api/projects', async (p, b) => app.addProject(b.id));
  route('GET', '/api/projects/:pid/impact', (p) => ({ tasks: app.removeImpact(p.pid) }));
  route('POST', '/api/projects/:pid/remove', async (p) => app.removeProject(p.pid));
  route('POST', '/api/projects/:pid/clear-cache', async (p) => app.clearCache(p.pid));
  route('POST', '/api/projects/:pid/open', (p) => {
    const pr = app.project(p.pid);
    if (!pr || !/^https?:\/\//i.test(pr.webUrl || '')) throw new HttpError(400, 'CodeHub 没有返回该项目的网页地址');
    app.openExternal(pr.webUrl);
    return { text: '已在浏览器打开 CodeHub 项目 ' + pr.path };
  });

  route('POST', '/api/fetch', (p, b) => { app.startFetch(b.pid ? [String(b.pid)] : null); return { ok: true }; });

  route('POST', '/api/reviews', (p, b) => app.engine.enqueue(b.pid, b.iid));
  route('POST', '/api/reviews/stop', (p, b) => { app.engine.stop(String(b.pid), String(b.iid)); return { ok: true }; });
  route('POST', '/api/reviews/cancel', (p, b) => { app.engine.cancel(String(b.pid), String(b.iid)); return { ok: true }; });

  route('POST', '/api/mr/:pid/:iid/open', (p) => {
    const d = app.detail(p.pid, p.iid);
    const url = d.mr && d.mr.webUrl;
    if (!/^https?:\/\//i.test(url || '')) throw new HttpError(400, 'CodeHub 没有返回该 MR 的网页地址');
    app.openExternal(url);
    return { text: '已在浏览器打开 CodeHub MR !' + p.iid };
  });

  route('POST', '/api/findings/send', (p, b) => { app.send(b.pid, b.iid, b.reportId, b.fid); return { ok: true }; });
  route('POST', '/api/findings/dismiss', (p, b) => { app.decide(b.pid, b.iid, b.reportId, b.fid, 'dismiss'); return { ok: true }; });
  route('POST', '/api/findings/undo', (p, b) => { app.decide(b.pid, b.iid, b.reportId, b.fid, 'undo'); return { ok: true }; });
  route('POST', '/api/findings/mark', (p, b) => { app.decide(b.pid, b.iid, b.reportId, b.fid, 'mark', b.result); return { ok: true }; });
  route('POST', '/api/findings/bulk-dismiss', (p, b) => ({ count: app.bulkDismiss(b.pid, b.iid, b.reportId) }));
  route('POST', '/api/findings/draft', (p, b) => ({ id: app.draftFromFinding(b.pid, b.iid, b.reportId, b.fid) }));

  route('GET', '/api/rules', () => ({ rules: app.rulesView(), dir: app.rules.dir }));
  route('POST', '/api/rules', (p, b) => { const id = app.rules.create(String(b.scope || 'global'), { name: '未命名规则', enabled: false }); app.changed(); return { id }; });
  route('POST', '/api/rules/save', (p, b) => {
    const cur = app.rules.get(b.id);
    if (!cur) throw new HttpError(404, '规则不存在（可能已在外部被删除）');
    const fields = {};
    for (const k of ['name', 'files', 'body']) if (typeof b[k] === 'string') fields[k] = b[k];
    if (fields.name !== undefined && !fields.name.trim()) throw new HttpError(400, '规则名称不能为空');
    if (b.confirmDraft) Object.assign(fields, { draft: false, enabled: true });
    const id = app.rules.update(b.id, fields);
    app.logger.info('rule.save id=' + id);
    app.changed();
    return { id };
  });
  route('POST', '/api/rules/toggle', (p, b) => { const r = app.rules.get(b.id); if (!r) throw new HttpError(404, '规则不存在'); if (r.error) throw new HttpError(400, '规则格式错误：' + r.error); app.rules.update(b.id, { enabled: !r.enabled, draft: false }); app.logger.info('rule.toggle id=' + b.id + ' enabled=' + !r.enabled); app.changed(); return { enabled: !r.enabled }; });
  route('POST', '/api/rules/scope', (p, b) => { const id = app.rules.update(b.id, { scope: String(b.scope) }); app.logger.info('rule.scope id=' + id); app.changed(); return { id }; });
  route('POST', '/api/rules/copy', (p, b) => { const id = app.rules.copy(b.id); app.changed(); return { id }; });
  route('POST', '/api/rules/delete', (p, b) => { app.rules.remove(b.id); app.logger.info('rule.delete id=' + b.id); app.changed(); return { ok: true }; });
  route('POST', '/api/rules/open-dir', () => { app.openExternal(app.rules.dir); return { text: '已在资源管理器打开 ' + app.rules.dir }; });

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only our own host names.
      if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) return send(res, 421, { error: '拒绝访问' });
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);

      // MCP endpoint for OpenCode (no browser origin; guarded by a random per-review token).
      const mcp = /^\/mcp\/([a-f0-9]{36})$/.exec(pathname);
      if (mcp) {
        if (req.headers.origin) return send(res, 403, { error: 'forbidden' });
        if (req.method === 'GET') return send(res, 405, { error: 'SSE not supported' }, { Allow: 'POST' });
        if (req.method === 'DELETE') return send(res, 200, {});
        if (req.method !== 'POST') return send(res, 405, {});
        const body = await readBody(req);
        const r = await app.mcp.handle(mcp[1], body);
        if (r.status === 202) { res.writeHead(202); return res.end(); }
        return send(res, r.status, r.json);
      }

      if (pathname.startsWith('/api/')) {
        // Other local pages must not be able to act as the user.
        const origin = req.headers.origin;
        if (origin && !allowedOrigins.has(origin)) return send(res, 403, { error: '来源不被允许' });
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, { error: '来源不被允许' });
        if (req.method !== 'GET' && req.headers['x-reviewx'] !== '1') return send(res, 403, { error: '缺少请求头' });

        if (pathname === '/api/events' && req.method === 'GET') return sse(app, req, res);
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(pathname);
          if (!m) continue;
          const body = req.method === 'POST' ? await readBody(req) : {};
          const out = await r.fn(m.groups || {}, body);
          return send(res, 200, out === undefined ? {} : out);
        }
        return send(res, 404, { error: '接口不存在' });
      }

      if (req.method !== 'GET') return send(res, 405, {});
      // Static files: only from public/, never anything else on disk.
      const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      const file = path.resolve(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      const status = e.status || 400;
      if (status >= 500 || !e.status) app.logger.warn('http ' + req.method + ' ' + req.url.split('?')[0] + ' error=' + e.message);
      if (!res.headersSent) send(res, status, { error: e.message });
      else res.end();
    }
  });
  server.keepAliveTimeout = 5000;
  return server;
}

function sse(app, req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const write = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n');
  write('state', app.snapshot());
  const listener = (type, data) => write(type, data);
  const logListener = (entry) => write('log', entry);
  app.listeners.add(listener);
  app.logger.listeners.add(logListener);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); app.listeners.delete(listener); app.logger.listeners.delete(logListener); });
}

module.exports = { createServer };
