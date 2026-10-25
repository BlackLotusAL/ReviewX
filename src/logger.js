'use strict';
// Diagnostic log (R21): one file per day, kept 30 days and at most 100 MB total.
// Every line passes through redact() so credentials never reach disk (R06).
const fs = require('fs');
const path = require('path');
const { ensureDir, localDate, localTime } = require('./util');

const KEEP_DAYS = 30;
const MAX_BYTES = 100 * 1024 * 1024;
const SESSION_MAX = 500;

function redact(text) {
  return String(text)
    // URL userinfo: https://user:secret@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1***@')
    // header or key=value style secrets
    .replace(/((?:private[-_]?token|x-auth-token|authorization|access[-_]?token|refresh[-_]?token|api[-_]?key|apikey|appcode|x-apig-appcode|password|passwd|secret|newToken|token)\s*["']?\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+)?[^\s"',;&}]+/gi, '$1***')
    // bare bearer tokens
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer ***')
    // well-known token shapes
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '***');
}

class Logger {
  constructor(dir) {
    this.dir = ensureDir(dir);
    this.day = null;
    this.session = [];
    this.listeners = new Set();
    this.cleanup();
  }

  file(day) { return path.join(this.dir, (day || localDate()) + '.log'); }

  currentPath() { return this.file(localDate()); }

  write(level, msg) {
    const now = new Date();
    const day = localDate(now);
    if (this.day && this.day !== day) this.cleanup(day);
    this.day = day;
    const text = redact(msg);
    const line = localTime(now) + ' ' + level.padEnd(5) + ' ' + text.replace(/\r?\n/g, '\n    ') + '\n';
    try { fs.appendFileSync(this.file(day), line); } catch { /* disk issue: keep running */ }
    const entry = { t: localTime(now), at: now.getTime(), lvl: level, msg: text };
    this.session.push(entry);
    if (this.session.length > SESSION_MAX) this.session.shift();
    for (const l of this.listeners) l(entry);
  }

  info(msg) { this.write('INFO', msg); }
  warn(msg) { this.write('WARN', msg); }
  error(msg) { this.write('ERROR', msg); }

  // Delete files older than 30 days, then oldest first while over 100 MB.
  // Today's file is never deleted.
  cleanup(today) {
    today = today || localDate();
    let files;
    try {
      files = fs.readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    } catch { return; }
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
    const cutoffDay = localDate(cutoff);
    const kept = [];
    for (const f of files) {
      const day = f.slice(0, 10);
      if (day === today) { kept.push(f); continue; }
      if (day < cutoffDay) { try { fs.unlinkSync(path.join(this.dir, f)); } catch { /* ignore */ } continue; }
      kept.push(f);
    }
    const sizes = kept.map((f) => { try { return fs.statSync(path.join(this.dir, f)).size; } catch { return 0; } });
    let total = sizes.reduce((a, b) => a + b, 0);
    for (let i = 0; i < kept.length && total > MAX_BYTES; i++) {
      if (kept[i].slice(0, 10) === today) continue;
      try { fs.unlinkSync(path.join(this.dir, kept[i])); total -= sizes[i]; } catch { /* ignore */ }
    }
  }
}

module.exports = { Logger, redact };
