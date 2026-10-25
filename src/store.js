'use strict';
// Local data directory layout (R13). Reports are immutable files; attempt and
// decision records are append-only JSONL, so nothing is ever overwritten.
//
//   meta.json                         data format version
//   projects.json                     watch list (removed projects are kept, flagged)
//   fetch/<pid>.json                  last successful MR fetch of a project
//   mrs/<pid>/<iid>/attempts.jsonl    review lifecycle events
//   mrs/<pid>/<iid>/reports/<id>.json saved reports
//   mrs/<pid>/<iid>/records.jsonl     decisions and publish results per finding
//   cache/<pid>.git                   code cache (bare partial clone)
//   tmp/                              review copies, deleted after each review
//   rules/                            rule Markdown files
//   logs/                             diagnostic logs
//   backups/                          pre-upgrade backups
const fs = require('fs');
const path = require('path');
const { ensureDir, readJSON, writeJSONAtomic, appendJsonl, readJsonl } = require('./util');

const FORMAT_VERSION = 1;
// Migrations from version N to N+1 rewrite index and state records only.
const MIGRATIONS = {};

class StoreError extends Error {}

function copyDir(src, dst, skip) {
  ensureDir(dst);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(ent.name)) continue;
    const s = path.join(src, ent.name); const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d, []);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

class Store {
  constructor(dir) {
    this.dir = ensureDir(dir);
    this.reportCache = new Map();
  }

  p(...parts) { return path.join(this.dir, ...parts); }

  // Check data format version; back up and migrate older data (R13 数据升级).
  checkVersion(appVersion) {
    const metaFile = this.p('meta.json');
    const meta = readJSON(metaFile, null);
    const hasData = fs.existsSync(this.p('projects.json'));
    if (!meta) {
      if (hasData) throw new StoreError('数据目录缺少版本记录（meta.json），无法判断数据格式：' + this.dir);
      writeJSONAtomic(metaFile, { formatVersion: FORMAT_VERSION, createdBy: appVersion, createdAt: new Date().toISOString() });
      return { migrated: false };
    }
    const v = meta.formatVersion;
    if (!Number.isInteger(v)) throw new StoreError('数据目录的版本记录格式错误：' + metaFile);
    if (v > FORMAT_VERSION) throw new StoreError('数据目录的格式版本（' + v + '）高于当前 ReviewX 支持的版本（' + FORMAT_VERSION + '），请升级 ReviewX。');
    if (v === FORMAT_VERSION) return { migrated: false };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = this.p('backups', 'v' + v + '-' + stamp);
    try {
      copyDir(this.dir, backup, ['cache', 'backups', 'tmp']);
    } catch (e) {
      throw new StoreError('数据升级前备份失败，原数据未改动：' + e.message);
    }
    this.pruneBackups();
    const staging = this.p('tmp', 'migrate-' + stamp);
    try {
      copyDir(this.dir, staging, ['cache', 'backups', 'tmp', 'logs']);
      for (let cur = v; cur < FORMAT_VERSION; cur++) {
        const step = MIGRATIONS[cur];
        if (!step) throw new Error('缺少从版本 ' + cur + ' 升级的迁移');
        step(staging);
      }
      // Every write succeeded: swap the migrated index/state files in.
      for (const ent of fs.readdirSync(staging, { withFileTypes: true })) {
        if (ent.name === 'reports') continue;
        const s = path.join(staging, ent.name); const d = this.p(ent.name);
        fs.rmSync(d, { recursive: true, force: true });
        fs.renameSync(s, d);
      }
      writeJSONAtomic(metaFile, Object.assign({}, meta, { formatVersion: FORMAT_VERSION, migratedAt: new Date().toISOString() }));
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new StoreError('数据升级失败，原数据未改动。备份位置：' + backup + '。原因：' + e.message);
    }
    fs.rmSync(staging, { recursive: true, force: true });
    return { migrated: true, backup };
  }

  pruneBackups() {
    const dir = this.p('backups');
    let list = [];
    try { list = fs.readdirSync(dir).sort(); } catch { return; }
    while (list.length > 3) fs.rmSync(path.join(dir, list.shift()), { recursive: true, force: true });
  }

  // ---- projects ----
  loadProjects() { return readJSON(this.p('projects.json'), []); }
  saveProjects(list) { writeJSONAtomic(this.p('projects.json'), list); }

  // ---- fetch results ----
  loadFetch(pid) { return readJSON(this.p('fetch', pid + '.json'), null); }
  saveFetch(pid, data) { writeJSONAtomic(this.p('fetch', pid + '.json'), data); }

  // ---- per-MR records ----
  mrDir(pid, iid) { return this.p('mrs', String(pid), String(iid)); }

  listMrKeys(pid) {
    const dir = this.p('mrs', String(pid));
    try { return fs.readdirSync(dir).filter((x) => /^\d+$/.test(x)); } catch { return []; }
  }

  listProjectsWithData() {
    try { return fs.readdirSync(this.p('mrs')).filter((x) => /^\d+$/.test(x)); } catch { return []; }
  }

  appendAttempt(pid, iid, rec) { appendJsonl(path.join(this.mrDir(pid, iid), 'attempts.jsonl'), rec); }
  readAttemptEvents(pid, iid) { return readJsonl(path.join(this.mrDir(pid, iid), 'attempts.jsonl')); }

  // Merge lifecycle events into attempts, newest first.
  attempts(pid, iid) {
    const map = new Map();
    for (const e of this.readAttemptEvents(pid, iid)) {
      const a = map.get(e.id) || { id: e.id };
      if (e.t === 'queued') { a.queuedAt = e.at; a.status = 'queued'; }
      if (e.t === 'started') { a.startedAt = e.at; a.status = 'running'; }
      if (e.t === 'ended') Object.assign(a, { endedAt: e.at, status: e.status, reportId: e.reportId, conclusion: e.conclusion, failure: e.failure, stopReason: e.stopReason, steps: e.steps });
      map.set(e.id, a);
    }
    return [...map.values()].sort((x, y) => (y.queuedAt || 0) - (x.queuedAt || 0));
  }

  saveReport(pid, iid, report) {
    const file = path.join(this.mrDir(pid, iid), 'reports', report.id + '.json');
    writeJSONAtomic(file, report);
    this.reportCache.set(file, report);
  }

  loadReport(pid, iid, id) {
    const file = path.join(this.mrDir(pid, iid), 'reports', id + '.json');
    if (this.reportCache.has(file)) return this.reportCache.get(file);
    const r = readJSON(file, null);
    if (r) this.reportCache.set(file, r);
    return r;
  }

  // Successful reports, newest first.
  reports(pid, iid) {
    return this.attempts(pid, iid)
      .filter((a) => a.status === 'completed' && a.reportId)
      .map((a) => this.loadReport(pid, iid, a.reportId))
      .filter(Boolean);
  }

  appendRecord(pid, iid, rec) { appendJsonl(path.join(this.mrDir(pid, iid), 'records.jsonl'), rec); }
  readRecords(pid, iid) { return readJsonl(path.join(this.mrDir(pid, iid), 'records.jsonl')); }

  cacheDir(pid) { return this.p('cache', String(pid) + '.git'); }
  tmpDir() { return ensureDir(this.p('tmp')); }
  rulesDir() { return ensureDir(this.p('rules')); }
  logsDir() { return ensureDir(this.p('logs')); }
}

// Replay decision records into a state per finding.
// States: pending, dismissed, sending, published, manual, failed, unknown
function findingStates(records, reportId) {
  const st = {};
  for (const r of records) {
    if (r.reportId !== reportId) continue;
    const cur = st[r.fid] || { state: 'pending' };
    const at = r.at;
    switch (r.a) {
      case 'dismiss': st[r.fid] = { state: 'dismissed', at }; break;
      case 'undo': st[r.fid] = { state: 'pending', at }; break;
      case 'sending': st[r.fid] = { state: 'sending', at, attempts: (cur.attempts || 0) + 1 }; break;
      case 'result':
        st[r.fid] = { state: r.result, at, reason: r.reason, commentUrl: r.url, attempts: cur.attempts || 1 };
        break;
      case 'mark':
        st[r.fid] = r.result === 'published'
          ? { state: 'manual', at, attempts: cur.attempts }
          : { state: 'failed', at, reason: '已核对：确认未发布', manual: true, attempts: cur.attempts };
        break;
      default: break;
    }
  }
  return st;
}

module.exports = { Store, StoreError, findingStates, FORMAT_VERSION };
