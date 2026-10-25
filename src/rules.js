'use strict';
// Review rules (R20). Each rule is a Markdown file with a small front matter:
//
//   ---
//   name: 安全
//   files: "*.java, src/db/**"     (empty = all files)
//   enabled: true
//   ---
//   ## 检查要点 ...
//
// Global rules live in rules/global/, project rules in rules/projects/<pid>/.
// Files are re-read on every list and at review start, so edits made outside
// ReviewX apply without a restart.
const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./util');

const BUILTIN = [
  ['correctness.md', '正确性', `## 检查要点
- 边界条件：空输入、空集合、零值、超长输入、循环或自引用
- 错误分支：异常是否被吞掉，失败时是否释放资源、回滚状态
- 并发与时序：共享状态的读改写是否串行化，异步结果是否按预期等待
- 修改是否让调用方的假设失效（返回值、参数含义、副作用）

## 反例
\`\`\`js
const root = parse(source);
return root.entries[0]; // source 为空时 root.entries 为 undefined
\`\`\`

## 正例
\`\`\`js
if (!source.trim()) return { entries: [], warnings: ['配置为空'] };
\`\`\`
`],
  ['security.md', '安全', `## 检查要点
- 外部输入进入 SQL、命令、文件路径或 HTML 前是否校验或转义
- 按 ID 读取的资源是否核对所属用户或项目
- 日志、报告和错误信息中是否出现凭据、令牌或个人信息
- 新增的接口是否缺少鉴权

## 反例
\`\`\`js
db.query("SELECT * FROM users WHERE id = " + req.query.id);
\`\`\`

## 正例
\`\`\`js
db.query("SELECT * FROM users WHERE id = ?", [req.query.id]);
\`\`\`
`],
  ['performance.md', '性能', `## 检查要点
- 循环内的 I/O、网络请求或数据库查询
- 大集合上的重复遍历、不必要的全量加载
- 大目录逐个文件操作、缺少分页
- 缓存键是否覆盖所有影响结果的输入

## 反例
\`\`\`js
for (const id of ids) await db.get(id);
\`\`\`

## 正例
\`\`\`js
const rows = await db.getMany(ids);
\`\`\`
`],
  ['maintainability.md', '可维护性', `## 检查要点
- 命名是否表达含义和单位
- 重复逻辑超过两处是否抽取
- 修复边界条件是否附带回归测试
- 删除功能时是否同步清理残留代码与配置

## 反例
\`\`\`js
function wait(t) { /* t 是秒还是毫秒？ */ }
\`\`\`

## 正例
\`\`\`js
function wait(timeoutMs) { }
\`\`\`
`]
];

function parseFrontMatter(text) {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { error: '缺少开头的 --- 元信息块' };
  const end = src.indexOf('\n---', 4);
  if (end < 0) return { error: '元信息块没有以 --- 结束' };
  const head = src.slice(4, end);
  const body = src.slice(end + 4).replace(/^[^\n]*\n/, '');
  const meta = {};
  for (const raw of head.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) return { error: '元信息格式错误：「' + line + '」' };
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else if (v === 'true') v = true;
    else if (v === 'false') v = false;
    meta[m[1]] = v;
  }
  return { meta, body };
}

function q(v) { return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

function serialize(rule) {
  const lines = ['---', 'name: ' + q(rule.name), 'files: ' + q(rule.files || ''), 'enabled: ' + Boolean(rule.enabled)];
  if (rule.builtin) lines.push('builtin: true');
  if (rule.draft) lines.push('draft: true');
  if (rule.source) lines.push('source: ' + q(rule.source));
  lines.push('---', '');
  return lines.join('\n') + (rule.body || '').replace(/\r\n/g, '\n').replace(/\s*$/, '') + '\n';
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

function splitPatterns(files) {
  return String(files || '').split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
}

function fileMatches(files, filePath) {
  const pats = splitPatterns(files);
  if (!pats.length) return true;
  const p = filePath.replace(/\\/g, '/');
  const base = p.split('/').pop();
  return pats.some((pat) => {
    const norm = pat.replace(/\\/g, '/').replace(/^\.\//, '');
    const re = globToRegex(norm);
    return norm.includes('/') ? re.test(p) : re.test(base) || re.test(p);
  });
}

function slug(name) {
  const s = String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'rule';
}

class Rules {
  constructor(dir) {
    this.dir = dir;
  }

  ensureBuiltins() {
    const marker = path.join(this.dir, '.initialized');
    if (fs.existsSync(marker)) return;
    const g = ensureDir(path.join(this.dir, 'global'));
    for (const [file, name, body] of BUILTIN) {
      const f = path.join(g, file);
      if (!fs.existsSync(f)) fs.writeFileSync(f, serialize({ name, files: '', enabled: true, builtin: true, body }));
    }
    ensureDir(path.join(this.dir, 'projects'));
    fs.writeFileSync(marker, 'built-in rules created ' + new Date().toISOString() + '\n');
  }

  scopeDir(scope) {
    return scope === 'global' ? path.join(this.dir, 'global') : path.join(this.dir, 'projects', String(scope));
  }

  readScope(scope) {
    const dir = this.scopeDir(scope);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort(); } catch { return []; }
    return files.map((f) => {
      const rel = path.relative(this.dir, path.join(dir, f)).split(path.sep).join('/');
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return { id: rel, file: rel, scope, name: f, error: '无法读取：' + e.message, enabled: false, body: '' }; }
      const fm = parseFrontMatter(text);
      if (fm.error) return { id: rel, file: rel, scope, name: f.replace(/\.md$/i, ''), error: fm.error, enabled: false, body: text, raw: text };
      const m = fm.meta;
      let error = null;
      if (!m.name || typeof m.name !== 'string') error = '缺少 name（规则名称）';
      else if (m.enabled !== undefined && typeof m.enabled !== 'boolean') error = 'enabled 应为 true 或 false';
      else if (m.files !== undefined && typeof m.files !== 'string') error = 'files 应为字符串';
      else if (!fm.body.trim()) error = '缺少检查要点正文';
      return {
        id: rel, file: rel, scope,
        name: typeof m.name === 'string' && m.name ? m.name : f.replace(/\.md$/i, ''),
        files: typeof m.files === 'string' ? m.files : '',
        enabled: m.enabled === true && !m.draft,
        builtin: m.builtin === true,
        draft: m.draft === true,
        source: typeof m.source === 'string' ? m.source : '',
        body: fm.body,
        error
      };
    });
  }

  scopes() {
    const out = ['global'];
    try {
      for (const d of fs.readdirSync(path.join(this.dir, 'projects'))) if (/^\d+$/.test(d)) out.push(d);
    } catch { /* none */ }
    return out;
  }

  all() {
    const rules = [];
    for (const s of this.scopes()) rules.push(...this.readScope(s));
    // Names must be unique among rules that can be used together.
    const global = rules.filter((r) => r.scope === 'global' && !r.error);
    const seen = new Map();
    for (const r of rules) {
      if (r.error) continue;
      const key = (r.scope === 'global' ? 'g' : 'p' + r.scope) + ':' + r.name;
      if (seen.has(key)) { r.error = '名称与 ' + seen.get(key) + ' 重复'; continue; }
      seen.set(key, r.file);
      if (r.scope !== 'global') {
        const dup = global.find((g) => g.name === r.name);
        if (dup) r.error = '名称与全局规则 ' + dup.file + ' 重复';
      }
    }
    return rules;
  }

  get(id) { return this.all().find((r) => r.id === id) || null; }

  // Rules used when reviewing an MR of project pid with these changed files.
  forReview(pid, files) {
    const all = this.all().filter((r) => r.scope === 'global' || r.scope === String(pid));
    const used = []; const skipped = [];
    for (const r of all) {
      if (r.error) { if (r.enabled !== false || r.error) skipped.push({ name: r.name, file: r.file, reason: r.error }); continue; }
      if (!r.enabled) continue;
      if (!files.some((f) => fileMatches(r.files, f))) continue;
      used.push({ name: r.name, scope: r.scope, files: r.files, file: r.file, content: r.body });
    }
    return { used, skipped };
  }

  absPath(id) {
    const abs = path.resolve(this.dir, id);
    if (!abs.startsWith(path.resolve(this.dir) + path.sep) || !abs.toLowerCase().endsWith('.md')) throw new Error('非法的规则路径');
    return abs;
  }

  uniqueFile(scope, name) {
    const dir = ensureDir(this.scopeDir(scope));
    const base = slug(name);
    let f = base + '.md'; let i = 2;
    while (fs.existsSync(path.join(dir, f))) f = base + '-' + (i++) + '.md';
    return path.relative(this.dir, path.join(dir, f)).split(path.sep).join('/');
  }

  write(id, rule) {
    const abs = this.absPath(id);
    ensureDir(path.dirname(abs));
    const tmp = abs + '.tmp';
    fs.writeFileSync(tmp, serialize(rule));
    fs.renameSync(tmp, abs);
  }

  create(scope, fields) {
    const id = this.uniqueFile(scope, fields.name || '未命名规则');
    this.write(id, Object.assign({ name: '未命名规则', files: '', enabled: false, body: '## 检查要点\n- \n\n## 正例\n\n## 反例\n' }, fields));
    return id;
  }

  update(id, fields) {
    const cur = this.get(id);
    if (!cur) throw new Error('规则不存在');
    if (cur.error && fields.body === undefined) throw new Error('规则格式错误，请直接编辑文件：' + cur.error);
    const next = Object.assign({ name: cur.name, files: cur.files, enabled: cur.enabled, builtin: cur.builtin, draft: cur.draft, source: cur.source, body: cur.body }, fields);
    this.write(id, next);
    if (fields.scope && fields.scope !== cur.scope) {
      if (cur.builtin) throw new Error('内置规则固定为全局');
      const nid = this.uniqueFile(fields.scope, next.name);
      fs.renameSync(this.absPath(id), this.absPath(nid));
      return nid;
    }
    return id;
  }

  remove(id) {
    const cur = this.get(id);
    if (cur && cur.builtin) throw new Error('内置规则不能删除，可以停用');
    fs.rmSync(this.absPath(id), { force: true });
  }

  copy(id) {
    const cur = this.get(id);
    if (!cur) throw new Error('规则不存在');
    return this.create(cur.scope, { name: cur.name + ' 副本', files: cur.files, enabled: false, body: cur.body });
  }
}

module.exports = { Rules, fileMatches, parseFrontMatter, serialize, globToRegex };
