'use strict';
// Code cache and review copy (R11 代码准备). The cache is a bare repository
// per project, fetched with --filter=blob:none, holding only the branches a
// review needs. Git credentials come from the user's own setup (R06).
const fs = require('fs');
const path = require('path');
const { resolveCommand, run } = require('./proc');
const { ensureDir } = require('./util');

class GitError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.kind = kind; // 'auth' | 'network' | 'corrupt' | 'missing-branch' | 'other' | 'cancelled'
    this.detail = detail || '';
  }
  get isEnv() { return this.kind === 'auth' || this.kind === 'network' || this.kind === 'cli'; }
}

function classify(stderr) {
  const s = stderr || '';
  if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|HTTP (Basic: )?Access denied|returned error: 40[13]|invalid credentials/i.test(s)) return 'auth';
  if (/Could not resolve host|Failed to connect|Connection (timed out|refused|reset)|Network is unreachable|unable to access|Operation timed out|SSL|early EOF|The remote end hung up/i.test(s)) return 'network';
  if (/couldn't find remote ref|not our ref|Remote branch .* not found/i.test(s)) return 'missing-branch';
  if (/corrupt|bad object|loose object|index-pack failed|unable to read (tree|sha1 file)|missing (object|blob|tree)|not a git repository|fatal: bad (tree|revision)|packed object .* is corrupt|invalid (index|object)/i.test(s)) return 'corrupt';
  return 'other';
}

function matchExcluded(file, patterns) {
  const base = path.posix.basename(file).toLowerCase();
  for (const p of patterns) {
    const q = p.toLowerCase();
    if (q.startsWith('.')) { if (base.endsWith(q)) return p; }
    else if (base === q) return p;
  }
  return null;
}

const KIND_LABEL = (p) => {
  const q = p.toLowerCase();
  if (/lock|go\.sum|shrinkwrap/.test(q)) return '锁文件';
  if (/\.(png|jpe?g|gif|bmp|ico|webp|svg)$/.test(q)) return '图片';
  if (/\.(ttf|otf|woff2?|eot)$/.test(q)) return '字体';
  if (/\.min\.(js|css)$|\.map$/.test(q)) return '压缩产物';
  return '排除规则 ' + p;
};

class Git {
  constructor(cfg, logger) {
    this.spec = cfg.gitCommand;
    this.logger = logger;
  }

  async git(args, opts = {}) {
    const cmd = resolveCommand(this.spec);
    if (!cmd) throw new GitError('cli', '未找到 Git（请确认已安装并可在终端运行 git）');
    const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_ASKPASS: process.env.GIT_ASKPASS || '' }, opts.env || {});
    if (!env.GIT_ASKPASS) delete env.GIT_ASKPASS;
    const res = await run(cmd, ['-c', 'core.longpaths=true', '-c', 'core.quotepath=false', '-c', 'core.autocrlf=false'].concat(args), { cwd: opts.cwd, env, signal: opts.signal, timeoutMs: opts.timeoutMs || 30 * 60 * 1000 });
    if (res.aborted) throw new GitError('cancelled', '已取消');
    if (res.code !== 0 && !opts.allowFail) {
      const kind = res.timedOut ? 'network' : classify(res.stderr);
      throw new GitError(kind, 'git ' + args.filter((a) => !/^https?:/.test(a)).slice(0, 3).join(' ') + ' 失败', res.stderr.trim().slice(-2000));
    }
    return res;
  }

  async ensureCache(dir, url, signal) {
    if (!fs.existsSync(path.join(dir, 'HEAD'))) {
      ensureDir(dir);
      await this.git(['init', '--bare', '--quiet', dir], { signal });
      await this.git(['--git-dir', dir, 'remote', 'add', 'origin', url], { signal });
      await this.git(['--git-dir', dir, 'config', 'remote.origin.promisor', 'true'], { signal });
      await this.git(['--git-dir', dir, 'config', 'remote.origin.partialclonefilter', 'blob:none'], { signal });
      await this.git(['--git-dir', dir, 'config', 'core.longpaths', 'true'], { signal });
    } else {
      await this.git(['--git-dir', dir, 'remote', 'set-url', 'origin', url], { signal });
    }
  }

  // Fetch one branch (allowing non-fast-forward) and pin it to the fetched commit.
  async fetchBranch(dir, branch, localRef, signal) {
    await this.git(['--git-dir', dir, 'fetch', '--no-tags', '--force', '--filter=blob:none', 'origin', '+refs/heads/' + branch + ':' + localRef], { signal });
    const r = await this.git(['--git-dir', dir, 'rev-parse', '--verify', localRef + '^{commit}'], { signal });
    return r.stdout.trim();
  }

  async mergeBase(dir, a, b, signal) {
    const r = await this.git(['--git-dir', dir, 'merge-base', a, b], { signal });
    return r.stdout.trim();
  }

  // Changed files of a three-dot diff: [{path, status, add, del, binary}]
  async changedFiles(dir, base, head, signal) {
    const ns = await this.git(['--git-dir', dir, 'diff', '--numstat', '-z', '--no-renames', base, head], { signal });
    const st = await this.git(['--git-dir', dir, 'diff', '--name-status', '-z', '--no-renames', base, head], { signal });
    const status = {};
    const sp = st.stdout.split('\0');
    for (let i = 0; i + 1 < sp.length; i += 2) status[sp[i + 1]] = sp[i];
    const out = [];
    for (const rec of ns.stdout.split('\0')) {
      if (!rec) continue;
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
      if (!m) continue;
      const binary = m[1] === '-' && m[2] === '-';
      out.push({ path: m[3], status: status[m[3]] || 'M', add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary });
    }
    return out;
  }

  async fileDiff(dir, base, head, file, signal) {
    const r = await this.git(['--git-dir', dir, 'diff', '--function-context', '--no-color', '--no-ext-diff', '--no-renames', base, head, '--', file], { signal });
    return r.stdout;
  }

  async commitMessages(dir, base, head, signal) {
    const r = await this.git(['--git-dir', dir, 'log', '--no-merges', '--format=%h%x00%s%x00%b%x1e', base + '..' + head], { signal });
    return r.stdout.split('\x1e').map((x) => x.trim()).filter(Boolean).map((x) => {
      const [sha, subject, body] = x.split('\0');
      return { sha, subject, body: (body || '').trim() };
    });
  }

  // Export the full tree of a commit, without .git or git config (R11 检视副本).
  async exportTree(dir, sha, dest, signal) {
    ensureDir(dest);
    const indexFile = dest + '.index';
    try {
      // core.symlinks=false: repository symlinks become plain files holding the link text.
      await this.git(['-c', 'core.symlinks=false', '--git-dir', dir, '--work-tree', dest, 'checkout', '-f', sha, '--', '.'], { signal, env: { GIT_INDEX_FILE: indexFile } });
    } finally {
      fs.rmSync(indexFile, { force: true });
    }
  }
}

module.exports = { Git, GitError, matchExcluded, KIND_LABEL, classify };
