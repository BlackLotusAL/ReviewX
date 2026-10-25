'use strict';
// Child process helpers: resolve commands without a shell, run with argument
// arrays (so newlines/quotes/backslashes reach the child unchanged), and kill
// whole process trees.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const isWin = process.platform === 'win32';
const children = new Set();

// Turn an npm .cmd shim into a direct command line ("node script.js" or "x.exe").
function parseCmdShim(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const dir = path.dirname(file);
  const re = /"%~?dp0%?\\?([^"]+)"/g;
  let m; let last = null;
  while ((m = re.exec(text))) last = m[1];
  if (!last) return null;
  const target = path.join(dir, last.replace(/^\\/, ''));
  if (/\.exe$/i.test(target)) return { cmd: target, prefix: [] };
  if (/node(\.exe)?$/i.test(path.basename(target))) return null;
  return { cmd: process.execPath, prefix: [target] };
}

function which(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

// spec: a command name, a path, or an array [cmd, ...args] from the config file.
function resolveCommand(spec) {
  if (Array.isArray(spec)) {
    const [cmd, ...rest] = spec;
    const r = resolveCommand(cmd);
    return r && { cmd: r.cmd, prefix: r.prefix.concat(rest) };
  }
  if (!spec) return null;
  let file = spec;
  if (!path.isAbsolute(spec) && !spec.includes('/') && !spec.includes('\\')) {
    file = which(spec);
    if (!file) return null;
  } else if (!fs.existsSync(file)) {
    if (isWin && fs.existsSync(file + '.exe')) file += '.exe';
    else if (isWin && fs.existsSync(file + '.cmd')) file += '.cmd';
    else return null;
  }
  if (isWin && /\.(cmd|bat)$/i.test(file)) return parseCmdShim(file);
  if (/\.(c|m)?js$/i.test(file)) return { cmd: process.execPath, prefix: [file] };
  return { cmd: file, prefix: [] };
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (!child.pid) return;
  try {
    if (isWin) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* already gone */ }
}

function killAll() {
  for (const c of children) killTree(c);
  children.clear();
}

class ProcError extends Error {
  constructor(message, info) {
    super(message);
    Object.assign(this, info);
  }
}

/**
 * Run a resolved command and collect output.
 * opts: cwd, env, timeoutMs, signal, onLine(line, stream), stdin ('ignore' default)
 * Resolves { code, stdout, stderr, timedOut, aborted }; rejects only if spawn fails.
 */
function run(resolved, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(resolved.cmd, resolved.prefix.concat(args), {
        cwd: opts.cwd,
        env: opts.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWin
      });
    } catch (e) {
      reject(new ProcError(e.message, { spawnError: true, code: e.code }));
      return;
    }
    children.add(child);
    if (opts.onSpawn) opts.onSpawn(child);
    const out = []; const err = [];
    let timedOut = false; let aborted = false; let settled = false;
    let lineBuf = '';
    child.stdout.on('data', (b) => {
      out.push(b);
      if (opts.onLine) {
        lineBuf += b.toString('utf8');
        let i;
        while ((i = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, i).replace(/\r$/, '');
          lineBuf = lineBuf.slice(i + 1);
          if (line) opts.onLine(line);
        }
      }
    });
    child.stderr.on('data', (b) => { err.push(b); });
    let timer = null;
    if (opts.timeoutMs) timer = setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMs);
    const onAbort = () => { aborted = true; killTree(child); };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      children.delete(child);
      if (timer) clearTimeout(timer);
      reject(new ProcError(e.message, { spawnError: true, code: e.code }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      children.delete(child);
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (opts.onLine && lineBuf.trim()) opts.onLine(lineBuf.replace(/\r$/, ''));
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        aborted
      });
    });
  });
}

module.exports = { resolveCommand, run, killTree, killAll, which, parseCmdShim, isWin };
