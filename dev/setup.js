#!/usr/bin/env node
'use strict';
// Builds a local sandbox for trying ReviewX without CodeHub:
//   dev/.mock/repos/*.git   bare Git repositories with MR branches
//   dev/.mock/state.json    data served by dev/mock-codehub.js
//   dev/.mock/config.json   a ReviewX config pointing at the sandbox
// Run again with --reset to rebuild from scratch.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const MOCK = path.join(__dirname, '.mock');
const REPOS = path.join(MOCK, 'repos');
const WORK = path.join(MOCK, 'work');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (content === null) fs.rmSync(abs, { force: true });
    else fs.writeFileSync(abs, content);
  }
}

function makeRepo(name, base, branches) {
  const work = path.join(WORK, name);
  const bare = path.join(REPOS, name + '.git');
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '--quiet');
  write(work, base);
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'Initial import');
  for (const b of branches) {
    git(work, 'checkout', '--quiet', '-B', b.name, 'main');
    for (const c of b.commits) {
      write(work, c.files);
      git(work, 'add', '-A');
      git(work, 'commit', '--quiet', '-m', c.msg);
    }
  }
  git(work, 'checkout', '--quiet', 'main');
  execFileSync('git', ['clone', '--bare', '--quiet', work, bare]);
  git(bare, 'config', 'uploadpack.allowFilter', 'true');
  git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  return pathToFileURL(bare).href;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

function main() {
  if (process.argv.includes('--reset')) fs.rmSync(MOCK, { recursive: true, force: true });
  if (fs.existsSync(path.join(MOCK, 'state.json'))) { console.log('sandbox exists: ' + MOCK + '（用 --reset 重建）'); return; }
  fs.mkdirSync(REPOS, { recursive: true });

  const engineUrl = makeRepo('review-engine', {
    'package.json': '{\n  "name": "review-engine",\n  "version": "0.1.0"\n}\n',
    'src/config/parse.js': [
      "'use strict';",
      "const yaml = require('./yaml');",
      '',
      '// Parse a review config file and return the first entry.',
      'function parseConfig(source) {',
      '  const root = yaml.parse(source);',
      '  return { entries: root.entries, first: root.entries[0] };',
      '}',
      '',
      'module.exports = { parseConfig };',
      ''
    ].join('\n'),
    'src/config/yaml.js': "'use strict';\n// Minimal stand-in parser: returns null for empty input.\nfunction parse(text) {\n  if (!text.trim()) return null;\n  return { entries: text.split('\\n').filter(Boolean).map((l) => l.trim()) };\n}\nmodule.exports = { parse };\n",
    'src/services/report-loader.js': [
      "'use strict';",
      "const store = require('./store');",
      '',
      'async function readReport(projectId, id) {',
      '  const report = await store.get(id);',
      '  if (!report) throw new Error("Report not found");',
      '  if (report.projectId !== projectId) throw new Error("Report not found");',
      '  return report.body;',
      '}',
      '',
      'module.exports = { readReport };',
      ''
    ].join('\n'),
    'src/services/store.js': "'use strict';\nconst data = new Map();\nmodule.exports = { get: async (id) => data.get(id) || null, put: async (r) => data.set(r.id, r) };\n",
    'README.md': '# review-engine\n'
  }, [
    { name: 'feat/config-validate', commits: [
      { msg: '补充配置校验\n\n读取配置后校验条目数量，超过上限时报错。', files: {
        'src/config/parse.js': [
          "'use strict';",
          "const yaml = require('./yaml');",
          '',
          'const MAX_ENTRIES = 100;',
          '',
          '// Parse a review config file, validate it and return the first entry.',
          'function parseConfig(source) {',
          '  const root = yaml.parse(source);',
          '  if (root.entries.length > MAX_ENTRIES) {',
          "    throw new Error('too many entries: ' + root.entries.length);",
          '  }',
          '  return { entries: root.entries, first: root.entries[0] };',
          '}',
          '',
          'module.exports = { parseConfig, MAX_ENTRIES };',
          ''
        ].join('\n')
      } }
    ] },
    { name: 'fix/report-loader', commits: [
      { msg: '简化报告读取逻辑', files: {
        'src/services/report-loader.js': [
          "'use strict';",
          "const store = require('./store');",
          '',
          '// Reports are cached by id for faster reads.',
          'const cache = {};',
          '',
          'async function readReport(projectId, id) {',
          '  if (cache[id]) return cache[id];',
          '  const report = await store.get(id);',
          '  cache[id] = report.body;',
          '  return report.body;',
          '}',
          '',
          'module.exports = { readReport };',
          ''
        ].join('\n')
      } }
    ] },
    { name: 'chore/assets', commits: [
      { msg: '升级图片资源与锁文件', files: { 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n', 'public/logo.png': PNG, 'public/icons.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n' } }
    ] }
  ]);

  const consoleUrl = makeRepo('task-console', {
    'src/index.js': "'use strict';\nconsole.log('task console');\n"
  }, [
    { name: 'feat/send-one', commits: [{ msg: '支持逐条发送检视意见', files: { 'src/send.js': "'use strict';\nlet sending = false;\nasync function send(item, api) {\n  sending = true;\n  await api.post(item);\n  sending = false;\n}\nmodule.exports = { send };\n" } }] }
  ]);

  const state = {
    auth: true,
    commentResults: [],
    comments: [],
    projects: {
      101: { id: '101', full_name: 'platform/review-engine', clone_url: engineUrl, web_url: 'https://codehub.example.com/platform/review-engine', mrs: [
        { iid: 401, title: '补充配置校验', source_branch: 'feat/config-validate', target_branch: 'main', updated_at: '2026-10-25T08:00:00Z', author: 'zhang.san' },
        { iid: 404, title: '修复报告读取的缓存逻辑，减少重复的存储访问', source_branch: 'fix/report-loader', target_branch: 'main', updated_at: '2026-10-25T14:02:00Z', author: 'li.si' },
        { iid: 405, title: '升级图片资源与锁文件', source_branch: 'chore/assets', target_branch: 'main', updated_at: '2026-10-25T09:05:00Z', author: 'wang.wu' }
      ] },
      202: { id: '202', full_name: 'apps/internal/tools/task-console', clone_url: consoleUrl, web_url: 'https://codehub.example.com/apps/internal/tools/task-console', fail: { list: 'NETWORK_ERROR' }, mrs: [
        { iid: 603, title: '支持逐条发送检视意见', source_branch: 'feat/send-one', target_branch: 'main', updated_at: '2026-10-25T09:03:00Z', author: 'zhao.liu' }
      ] },
      512: { id: '512', full_name: 'apps/data/etl-runner', clone_url: consoleUrl, web_url: 'https://codehub.example.com/apps/data/etl-runner', mrs: [] }
    }
  };
  fs.writeFileSync(path.join(MOCK, 'state.json'), JSON.stringify(state, null, 2));

  const config = {
    port: 17081,
    dataDir: path.join(MOCK, 'data'),
    codehubCommand: [process.execPath, path.join(__dirname, 'mock-codehub.js')],
    wrapUpMinutes: 6,
    opencodeTimeoutMinutes: 9
  };
  fs.writeFileSync(path.join(MOCK, 'config.json'), JSON.stringify(config, null, 2));
  console.log('sandbox ready: ' + MOCK);
  console.log('试用项目：101（review-engine）、202（task-console，获取会失败）、512；999 不存在。');
}

main();
