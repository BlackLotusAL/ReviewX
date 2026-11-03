'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

// Write to a temp file then rename, so a crash never leaves a half-written file.
function writeJSONAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// Append one JSON record per line and fsync, so records survive crashes.
function appendJsonl(file, record) {
  ensureDir(path.dirname(file));
  const fd = fs.openSync(file, 'a+');
  try {
    // A crash can leave a partial last line. Start the new record on a fresh
    // line so only the torn fragment is skipped by readJsonl.
    const size = fs.fstatSync(fd).size;
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    fs.writeSync(fd, prefix + JSON.stringify(record) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn last line from a crash is ignored.
    }
  }
  return out;
}

async function rmrf(target) {
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function newId(prefix) {
  const t = Date.now().toString(36);
  return (prefix || '') + t + crypto.randomBytes(3).toString('hex');
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function abortError() {
  const e = new Error('已取消');
  e.name = 'AbortError';
  return e;
}

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.waiters = [];
  }
  // signal (optional): stop waiting when it aborts; rejects with an AbortError.
  async acquire(signal) {
    if (signal && signal.aborted) throw abortError();
    if (this.active < this.max) { this.active++; return; }
    // The slot is taken for us in drain() before we are woken.
    await new Promise((resolve, reject) => {
      const waiter = () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) { this.waiters.splice(i, 1); reject(abortError()); }
      };
      this.waiters.push(waiter);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  release() {
    this.active--;
    this.drain();
  }
  // Start waiters only while there is room under the current limit.
  drain() {
    while (this.active < this.max && this.waiters.length) {
      this.active++;
      this.waiters.shift()();
    }
  }
  // A new limit applies at once: more room starts waiters now; less room lets
  // running calls finish and starts nothing until below the new limit.
  setMax(max) {
    this.max = Math.max(1, max);
    this.drain();
  }
  async use(fn, signal) {
    await this.acquire(signal);
    try { return await fn(); } finally { this.release(); }
  }
}

function pad2(n) { return String(n).padStart(2, '0'); }

function localDate(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function localTime(d) {
  d = d || new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function isPositiveIntString(v) {
  return typeof v === 'string' && /^[1-9]\d*$/.test(v);
}

module.exports = {
  ensureDir, readJSON, writeJSONAtomic, appendJsonl, readJsonl, rmrf, newId, sleep,
  Semaphore, localDate, localTime, pad2, isPositiveIntString
};
