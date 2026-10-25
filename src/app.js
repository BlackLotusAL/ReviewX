'use strict';
// Application core: watch list (R05, R22), MR fetching (R04), publishing
// (R03, R08), decisions (R16, R24), rule stats (R20) and the UI snapshot.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Store, findingStates } = require('./store');
const { Logger } = require('./logger');
const { CodeHub, CodeHubError } = require('./codehub');
const { Git } = require('./git');
const { OpenCode } = require('./opencode');
const { Rules } = require('./rules');
const { McpHub } = require('./mcp');
const { ReviewEngine, pickCloneUrl } = require('./review');
const { renderComment, locText } = require('./finding');
const { rmrf, isPositiveIntString, localTime, pad2 } = require('./util');

const VERSION = require('../package.json').version;
const SENT = ['published', 'manual', 'failed', 'unknown', 'sending'];

function hm(ts) { const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

function openExternal(target) {
  try {
    if (process.platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}

function shortName(p) { const parts = String(p || '').split('/'); return parts[parts.length - 1] || p; }
function folderOf(p) { const parts = String(p || '').split('/'); parts.pop(); return parts.join(' / ') || '—'; }

class App {
  constructor(cfg) {
    this.cfg = cfg;
    this.store = new Store(cfg.dataDir);
    this.logger = new Logger(this.store.logsDir());
    this.codehub = new CodeHub(cfg, this.logger);
    this.git = new Git(cfg, this.logger);
    this.opencode = new OpenCode(cfg, this.logger);
    this.rules = new Rules(this.store.rulesDir());
    this.mcp = new McpHub();
    this.engine = new ReviewEngine(this);
    this.fetchState = {}; // pid → {status, error, startedAt}
    this.fetch = { active: false, total: 0, done: 0, ok: 0, failed: 0, summary: '', finishedAt: null };
    this.sending = null;
    this.removing = new Set();
    this.rev = 0;
    this.mrRev = {};
    this.listeners = new Set();
    this.port = cfg.port;
    this.broadcastTimer = null;
  }

  // Startup steps that must succeed before serving (R13).
  init() {
    const v = this.store.checkVersion(VERSION);
    if (v.migrated) this.logger.info('data.migrated backup=' + v.backup);
    // Leftover temp dirs from a previous run.
    const tmp = this.store.p('tmp');
    try { for (const d of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, d), { recursive: true, force: true }); } catch { /* none */ }
    this.rules.ensureBuiltins();
    this.engine.recover();
    this.recoverSending();
    for (const p of this.activeProjects()) {
      const f = this.store.loadFetch(p.id);
      this.fetchState[p.id] = f ? { status: 'updated', lastSuccessAt: f.at } : { status: 'never' };
    }
  }

  // R08: comments that were being sent when ReviewX closed become "unknown".
  recoverSending() {
    for (const pid of this.store.listProjectsWithData()) {
      for (const iid of this.store.listMrKeys(pid)) {
        const recs = this.store.readRecords(pid, iid);
        const open = new Map();
        for (const r of recs) {
          const k = r.reportId + '#' + r.fid;
          if (r.a === 'sending') open.set(k, r); else if (r.a === 'result') open.delete(k);
        }
        for (const r of open.values()) {
          this.store.appendRecord(pid, iid, { a: 'result', reportId: r.reportId, fid: r.fid, result: 'unknown', reason: 'ReviewX 关闭时发送中断', at: Date.now(), by: 'recover' });
          this.logger.warn('comment.recover !' + iid + ' ' + r.fid + ' result=unknown');
        }
      }
    }
  }

  // ---- change notification ----
  changed(pid, iid) {
    this.rev++;
    if (pid && iid) this.mrRev[pid + '/' + iid] = this.rev;
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.emit('state', this.snapshot());
    }, 60);
  }

  notify(text) { this.emit('toast', { text }); }
  emit(type, data) { for (const l of this.listeners) l(type, data); }
  mcpUrl(token) { return 'http://127.0.0.1:' + this.port + '/mcp/' + token; }

  // ---- projects ----
  projectsAll() { return this.store.loadProjects(); }
  activeProjects() { return this.projectsAll().filter((p) => !p.removed).sort((a, b) => a.order - b.order); }
  project(pid) { return this.activeProjects().find((p) => p.id === String(pid)) || null; }

  updateProjectInfo(pid, repo) {
    const list = this.projectsAll();
    const p = list.find((x) => x.id === String(pid));
    if (!p) return;
    p.path = repo.full_name || p.path;
    p.webUrl = repo.web_url || p.webUrl;
    p.cloneUrls = repo.clone_urls || p.cloneUrls;
    p.defaultBranch = repo.default_branch || p.defaultBranch;
    this.store.saveProjects(list);
  }

  async addProject(raw) {
    const id = String(raw == null ? '' : raw).trim();
    if (!isPositiveIntString(id)) return { ok: false, tone: 'bad', text: 'Project ID 应为正整数' };
    const list = this.projectsAll();
    const exists = list.find((p) => p.id === id && !p.removed);
    if (exists) return { ok: false, tone: 'info', text: '该项目已在关注列表中：' + exists.path + '（' + id + '）', flash: id };
    let repo;
    try {
      repo = await this.codehub.repoView(id);
    } catch (e) {
      const reason = e instanceof CodeHubError ? (e.code === 'AUTH_ERROR' ? 'CodeHub CLI 未登录（请重新登录）' : e.reason) : e.message;
      this.logger.warn('project.add id=' + id + ' failed reason=' + (e.code || '') + ' ' + reason);
      return { ok: false, tone: 'bad', text: reason };
    }
    const order = list.reduce((m, p) => Math.max(m, p.order || 0), 0) + 1;
    const fullName = repo.full_name || ('project-' + id);
    const prev = list.find((p) => p.id === id);
    const rec = { id, path: fullName, webUrl: repo.web_url || null, cloneUrls: repo.clone_urls || null, defaultBranch: repo.default_branch || null, addedAt: Date.now(), order, removed: false };
    let text;
    if (prev) {
      Object.assign(prev, rec, { removedAt: undefined });
      let n = 0;
      for (const iid of this.store.listMrKeys(id)) n += this.store.reports(id, iid).length;
      text = '已恢复关注 ' + fullName + '，已恢复 ' + n + ' 份历史报告';
      this.logger.info('project.restore id=' + id + ' reports=' + n);
    } else {
      list.push(rec);
      text = '已添加 ' + fullName + '（' + id + '）';
      this.logger.info('project.add id=' + id + ' path=' + fullName);
    }
    this.store.saveProjects(list);
    const f = this.store.loadFetch(id);
    this.fetchState[id] = f ? { status: 'updated', lastSuccessAt: f.at } : { status: 'never' };
    this.changed();
    return { ok: true, tone: 'ok', text };
  }

  removeImpact(pid) {
    return this.engine.view().filter((j) => j.pid === String(pid)).map((j) => ({ iid: j.iid, title: j.title, status: j.status }));
  }

  async removeProject(pid) {
    pid = String(pid);
    const p = this.project(pid);
    if (!p) throw new Error('项目不在关注列表中');
    if (this.sending && this.sending.pid === pid) throw new Error('该项目有评论正在发送，请等发送结束后再移除');
    this.removing.add(pid);
    this.changed();
    try {
      await this.engine.stopProject(pid);
      const list = this.projectsAll();
      const rec = list.find((x) => x.id === pid);
      rec.removed = true;
      rec.removedAt = Date.now();
      this.store.saveProjects(list);
      await rmrf(this.store.cacheDir(pid));
      delete this.fetchState[pid];
      this.logger.info('project.remove id=' + pid + ' cache=deleted');
    } finally {
      this.removing.delete(pid);
      this.changed();
    }
    return { text: '已移除 ' + shortName(p.path) };
  }

  async clearCache(pid) {
    pid = String(pid);
    const p = this.project(pid);
    if (!p) throw new Error('项目不在关注列表中');
    const busy = this.engine.view().find((j) => j.pid === pid && j.status !== 'queued');
    if (busy) throw new Error('该项目有检视进行中，请等它结束后再清除代码缓存');
    await rmrf(this.store.cacheDir(pid));
    this.logger.info('cache.clear project=' + pid);
    return { text: '已清除 ' + shortName(p.path) + ' 的代码缓存，下次检视时重建' };
  }

  // ---- MR fetching (R04) ----
  openMrs(pid) {
    const f = this.store.loadFetch(pid);
    return f ? f.mrs : [];
  }

  openMr(pid, iid) {
    if (!this.project(pid)) return null;
    return this.openMrs(pid).find((m) => String(m.iid) === String(iid)) || null;
  }

  async fetchProject(pid) {
    this.fetchState[pid] = Object.assign({}, this.fetchState[pid], { status: 'fetching', startedAt: Date.now() });
    this.changed();
    try {
      const list = await this.codehub.mrList(pid);
      if (!Array.isArray(list)) throw new CodeHubError('BAD_OUTPUT');
      const details = await Promise.all(list.map((m) => this.codehub.mrView(pid, m.iid)));
      const mrs = details.map((d, i) => {
        const m = Object.assign({}, list[i], d);
        return {
          iid: String(m.iid), title: String(m.title || ''), state: m.state, isDraft: Boolean(m.is_draft),
          author: m.author && typeof m.author === 'object' ? (m.author.name || m.author.username || '') : (m.author || ''),
          sourceBranch: m.source_branch, targetBranch: m.target_branch, updatedAt: m.updated_at, createdAt: m.created_at || null,
          webUrl: m.web_url || null
        };
      });
      const at = Date.now();
      // Atomic per project: replaced only after the list and every detail succeeded.
      this.store.saveFetch(pid, { at, mrs });
      this.fetchState[pid] = { status: 'updated', lastSuccessAt: at };
      this.logger.info('mr.fetch project=' + pid + ' updated open=' + mrs.length);
      return true;
    } catch (e) {
      const prev = this.store.loadFetch(pid);
      const reason = e instanceof CodeHubError ? e.reason : e.message;
      this.fetchState[pid] = { status: 'failed', error: reason, lastSuccessAt: prev ? prev.at : null };
      this.logger.warn('mr.fetch project=' + pid + ' failed reason=' + (e.code || 'ERROR') + ' kept_previous=' + (prev ? localTime(new Date(prev.at)) : 'none'));
      return false;
    } finally {
      this.changed();
    }
  }

  startFetch(pids) {
    if (this.fetch.active) throw new Error('正在获取 MR，请稍候');
    const all = this.activeProjects().map((p) => p.id);
    const list = pids && pids.length ? all.filter((id) => pids.includes(id)) : all;
    if (!list.length) throw new Error('没有关注项目');
    this.fetch = { active: true, total: list.length, done: 0, ok: 0, failed: 0, summary: '', finishedAt: null };
    this.logger.info('mr.fetch start projects=' + list.length + ' concurrency=' + this.cfg.concurrency);
    for (const pid of list) this.fetchState[pid] = Object.assign({}, this.fetchState[pid], { status: 'fetching' });
    this.changed();
    const one = async (pid) => {
      const ok = await this.fetchProject(pid);
      this.fetch.done++;
      if (ok) this.fetch.ok++; else this.fetch.failed++;
      this.changed();
    };
    (async () => {
      // First project alone so only one CLI process refreshes the DevUC token.
      await one(list[0]);
      await Promise.all(list.slice(1).map(one));
      const f = this.fetch;
      f.active = false;
      f.finishedAt = Date.now();
      f.summary = '已更新 ' + f.ok + '/' + f.total + ' 个项目，' + f.failed + ' 个失败';
      this.logger.info('mr.fetch done ok=' + f.ok + ' failed=' + f.failed);
      this.notify('获取完成：' + f.summary);
      this.changed();
    })().catch((e) => {
      this.fetch.active = false;
      this.logger.error('mr.fetch crashed ' + e.stack);
      this.changed();
    });
  }

  // ---- reports and decisions ----
  reviewInfo(pid, iid) {
    const reports = this.store.reports(pid, iid);
    const attempts = this.store.attempts(pid, iid);
    const latest = reports[0] || null;
    const records = this.store.readRecords(pid, iid);
    return { reports, attempts, latest, records };
  }

  stateOf(states, reportId, fid) {
    if (this.sending && this.sending.reportId === reportId && this.sending.fid === fid) return { state: 'sending' };
    return states[fid] || { state: 'pending' };
  }

  counts(pid, iid, info) {
    const { latest, records } = info || this.reviewInfo(pid, iid);
    let pending = 0; let verify = 0;
    if (latest && latest.conclusion === 'issues') {
      const st = findingStates(records, latest.id);
      for (const f of latest.findings) {
        const s = this.stateOf(st, latest.id, f.id).state;
        if (s === 'pending') pending++;
        if (s === 'failed' || s === 'unknown') verify++;
      }
    }
    return { pending, verify, total: latest ? latest.findings.length : 0 };
  }

  requireLatest(pid, iid, reportId) {
    if (!this.openMr(pid, iid)) throw new Error('该 MR 已不在开放 MR 列表中');
    const info = this.reviewInfo(pid, iid);
    if (!info.latest || info.latest.id !== reportId) throw new Error('只能处理最新报告中的意见');
    return info;
  }

  findingOf(info, fid) {
    const f = info.latest.findings.find((x) => x.id === fid);
    if (!f) throw new Error('意见不存在');
    return f;
  }

  decide(pid, iid, reportId, fid, action, extra) {
    pid = String(pid); iid = String(iid);
    const info = this.requireLatest(pid, iid, reportId);
    this.findingOf(info, fid);
    const st = this.stateOf(findingStates(info.records, reportId), reportId, fid).state;
    const rec = { reportId, fid, at: Date.now(), by: 'user' };
    if (action === 'dismiss') {
      if (st !== 'pending') throw new Error('只有待处理的意见可以标为不发送');
      this.store.appendRecord(pid, iid, Object.assign(rec, { a: 'dismiss' }));
    } else if (action === 'undo') {
      if (st !== 'dismissed') throw new Error('只有标为不发送的意见可以撤销');
      this.store.appendRecord(pid, iid, Object.assign(rec, { a: 'undo' }));
    } else if (action === 'mark') {
      if (st !== 'unknown') throw new Error('只有结果未知的意见需要核对标记');
      const result = extra === 'published' ? 'published' : 'unpublished';
      this.store.appendRecord(pid, iid, Object.assign(rec, { a: 'mark', result }));
    } else throw new Error('未知操作');
    this.logger.info('finding.' + action + ' !' + iid + ' ' + fid + (extra ? ' ' + extra : ''));
    this.changed(pid, iid);
  }

  bulkDismiss(pid, iid, reportId) {
    pid = String(pid); iid = String(iid);
    const info = this.requireLatest(pid, iid, reportId);
    const st = findingStates(info.records, reportId);
    let n = 0;
    for (const f of info.latest.findings) {
      if (this.stateOf(st, reportId, f.id).state !== 'pending') continue;
      this.store.appendRecord(pid, iid, { a: 'dismiss', reportId, fid: f.id, at: Date.now(), by: 'user', bulk: true });
      n++;
    }
    this.logger.info('finding.bulk_dismiss !' + iid + ' count=' + n);
    this.changed(pid, iid);
    return n;
  }

  // R03: one comment at a time, only on an explicit click; never retried automatically.
  send(pid, iid, reportId, fid) {
    pid = String(pid); iid = String(iid);
    if (this.sending) throw new Error('有一条评论正在发送，请稍候');
    if (this.removing.has(pid)) throw new Error('项目正在移除');
    const info = this.requireLatest(pid, iid, reportId);
    const f = this.findingOf(info, fid);
    const st = this.stateOf(findingStates(info.records, reportId), reportId, fid).state;
    if (st !== 'pending' && st !== 'failed') throw new Error('该意见当前不能发送');
    const body = renderComment(f);
    this.store.appendRecord(pid, iid, { a: 'sending', reportId, fid, at: Date.now(), by: 'user' });
    this.sending = { pid, iid, reportId, fid };
    this.logger.info('comment.publish !' + iid + ' ' + fid + ' start');
    this.changed(pid, iid);
    (async () => {
      let rec;
      try {
        const r = await this.codehub.commentCreate(pid, iid, body, f.severity);
        rec = { result: 'published', url: r && r.web_url ? r.web_url : null };
        this.notify('已发布为 !' + iid + ' 的 MR 评论');
      } catch (e) {
        if (e instanceof CodeHubError && e.code === 'WRITE_RESULT_UNKNOWN') {
          rec = { result: 'unknown', reason: '发送结果未知' };
          this.notify('!' + iid + ' 的评论发送结果未知，请到 CodeHub 核对');
        } else {
          const reason = e instanceof CodeHubError ? e.reason : e.message;
          rec = { result: 'failed', reason };
          this.notify('!' + iid + ' 的评论发布失败：' + reason);
        }
      }
      this.store.appendRecord(pid, iid, Object.assign({ a: 'result', reportId, fid, at: Date.now(), by: 'cli' }, rec));
      this.logger[rec.result === 'published' ? 'info' : 'warn']('comment.publish !' + iid + ' ' + fid + ' result=' + rec.result + (rec.reason ? ' reason=' + rec.reason : ''));
      this.sending = null;
      this.changed(pid, iid);
    })();
  }

  // ---- views ----
  mrView(pid, iid, open, project, jobsByKey) {
    const info = this.reviewInfo(pid, iid);
    const job = jobsByKey[pid + '/' + iid];
    const c = this.counts(pid, iid, info);
    const lastAttempt = info.attempts.find((a) => a.status === 'failed' || a.status === 'stopped' || a.status === 'completed');
    const latest = info.latest;
    let state = 'unreviewed';
    if (job) state = job.status === 'queued' ? 'queued' : job.status === 'stopping' ? 'stopping' : 'running';
    else if (latest) state = 'done';
    else if (lastAttempt) state = lastAttempt.status;
    return {
      pid, iid, title: open.title, updatedAt: open.updatedAt, webUrl: open.webUrl, author: open.author,
      sourceBranch: open.sourceBranch, targetBranch: open.targetBranch, isDraft: open.isDraft,
      state,
      conclusion: latest ? latest.conclusion : null,
      pending: c.pending, verify: c.verify, total: c.total,
      stale: Boolean(latest && latest.mrUpdatedAt !== open.updatedAt),
      reportAt: latest ? latest.createdAt : null,
      durationMs: latest ? latest.durationMs : null,
      excludedCount: latest ? latest.excluded.length : 0,
      last: lastAttempt ? { status: lastAttempt.status, at: lastAttempt.endedAt, failure: lastAttempt.failure ? { title: lastAttempt.failure.title, step: lastAttempt.failure.step } : null, stopReason: lastAttempt.stopReason || null } : null,
      lastNewer: Boolean(lastAttempt && latest && lastAttempt.status !== 'completed' && lastAttempt.endedAt > latest.createdAt),
      rev: this.mrRev[pid + '/' + iid] || 0
    };
  }

  snapshot() {
    const jobs = this.engine.view();
    const jobsByKey = {};
    for (const j of jobs) jobsByKey[j.pid + '/' + j.iid] = j;
    const projects = this.activeProjects().map((p) => {
      const fs0 = this.fetchState[p.id] || { status: 'never' };
      return { id: p.id, path: p.path, short: shortName(p.path), folder: folderOf(p.path), webUrl: p.webUrl, fetch: fs0, removing: this.removing.has(p.id) };
    });
    const mrs = [];
    for (const p of projects) {
      for (const m of this.openMrs(p.id)) mrs.push(this.mrView(p.id, m.iid, m, p, jobsByKey));
    }
    const drafts = this.rules.all().filter((r) => r.draft && !r.error);
    return {
      version: VERSION, rev: this.rev, now: Date.now(),
      dataDir: this.cfg.dataDir, logPath: this.logger.currentPath(), configPath: this.cfg.configPath, rulesDir: this.rules.dir,
      projects, mrs, queue: jobs, fetch: this.fetch, sending: this.sending,
      drafts: drafts.map((d) => ({ id: d.id, name: d.name, source: d.source }))
    };
  }

  // Full report data for the drawer.
  detail(pid, iid) {
    pid = String(pid); iid = String(iid);
    const projectAll = this.projectsAll().find((p) => p.id === pid);
    const open = this.openMr(pid, iid);
    const info = this.reviewInfo(pid, iid);
    const job = this.engine.view().find((j) => j.pid === pid && j.iid === iid) || null;
    const reports = info.reports.map((r, idx) => {
      const st = findingStates(info.records, r.id);
      const isLatest = idx === 0;
      return {
        id: r.id, latest: isLatest, createdAt: r.createdAt, conclusion: r.conclusion, model: r.model,
        sourceSha: r.sourceSha, mrUpdatedAt: r.mrUpdatedAt, durationMs: r.durationMs,
        rules: r.rules.map((x) => x.name), skippedRules: r.skippedRules || [], excluded: r.excluded,
        changedFiles: r.changedFiles.length,
        findings: r.findings.map((f) => {
          let s = this.stateOf(st, r.id, f.id);
          if (!isLatest && s.state === 'pending') s = { state: 'superseded' };
          if (!isLatest && s.state === 'sending') s = { state: 'unknown' };
          return Object.assign({}, f, { evidence: undefined, loc: locText(f.location), state: s.state, stateAt: s.at || null, reason: s.reason || null, commentUrl: s.commentUrl || null });
        })
      };
    });
    const lastAttempt = info.attempts.find((a) => a.status === 'failed' || a.status === 'stopped' || a.status === 'completed') || null;
    const p = projectAll || { path: '' };
    const mr = open || (info.latest ? { iid, title: info.latest.mrTitle, webUrl: info.latest.mrWebUrl, updatedAt: info.latest.mrUpdatedAt } : { iid, title: '!' + iid });
    return {
      pid, iid, projectPath: p.path, projectWebUrl: p.webUrl || null,
      open: Boolean(open), mr, job, reports,
      last: lastAttempt,
      stale: Boolean(open && info.latest && info.latest.mrUpdatedAt !== open.updatedAt),
      rev: this.mrRev[pid + '/' + iid] || 0
    };
  }

  // R20 效果反馈: per rule hits / sent / dismissed over the last 30 days.
  ruleStats() {
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const stats = {};
    const bump = (key, k) => { stats[key] = stats[key] || { hits: 0, sent: 0, dismissed: 0 }; stats[key][k]++; };
    for (const pid of this.store.listProjectsWithData()) {
      for (const iid of this.store.listMrKeys(pid)) {
        const info = this.reviewInfo(pid, iid);
        info.reports.forEach((r, idx) => {
          if (r.createdAt < since) return;
          const st = findingStates(info.records, r.id);
          for (const f of r.findings) {
            if (!f.rule) continue;
            const snap = r.rules.find((x) => x.name === f.rule);
            const key = (snap ? snap.scope : 'global') + ':' + f.rule;
            bump(key, 'hits');
            const s = (st[f.id] || { state: 'pending' }).state;
            if (SENT.includes(s)) bump(key, 'sent');
            else if (s === 'dismissed') bump(key, 'dismissed');
            void idx;
          }
        });
      }
    }
    return stats;
  }

  rulesView() {
    const stats = this.ruleStats();
    return this.rules.all().map((r) => Object.assign({}, r, { stats: stats[r.scope + ':' + r.name] || { hits: 0, sent: 0, dismissed: 0 } }));
  }

  draftFromFinding(pid, iid, reportId, fid) {
    const info = this.reviewInfo(String(pid), String(iid));
    const r = info.reports.find((x) => x.id === reportId);
    if (!r) throw new Error('报告不存在');
    const f = r.findings.find((x) => x.id === fid);
    if (!f) throw new Error('意见不存在');
    const ext = (f.location.path.match(/\.[A-Za-z0-9]+$/) || [''])[0];
    const body = ['## 检查要点', '- ' + f.summary, '- ' + f.solutions[0].description, '', '## 反例', f.related_code ? '```' + f.related_code.language + '\n' + f.related_code.code + '\n```' : '（补充反例代码）', '', '## 正例', f.solutions[0].code ? '```' + f.solutions[0].code.language + '\n' + f.solutions[0].code.code + '\n```' : '（补充正例代码）', ''].join('\n');
    const id = this.rules.create('global', { name: f.title, files: ext ? '*' + ext : '', enabled: false, draft: true, source: '来自 !' + iid + '「' + f.title + '」', body });
    this.logger.info('rule.draft id=' + id + ' from=!' + iid + ' ' + fid);
    this.changed();
    return id;
  }

  openExternal(target) { return openExternal(target); }
}

module.exports = { App, VERSION, openExternal, hm };
