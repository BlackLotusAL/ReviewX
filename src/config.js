'use strict';
// Config is only changed by editing the config file; read at startup (R13).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureDir } = require('./util');

const DEFAULT_EXCLUDES = [
  // lock files
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum',
  'poetry.lock', 'Pipfile.lock', 'composer.lock', 'Gemfile.lock',
  // minified output and source maps
  '.min.js', '.min.css', '.map',
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  // fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot'
];

function appDataDir() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function localDataDir() {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function defaultConfigPath() {
  return path.join(appDataDir(), 'ReviewX', 'config.json');
}

function defaults() {
  return {
    port: 17080,
    dataDir: path.join(localDataDir(), 'ReviewX'),
    concurrency: 6,
    excludeFileTypes: DEFAULT_EXCLUDES.slice(),
    outputLanguage: '中文',
    wrapUpMinutes: 50,
    opencodeTimeoutMinutes: 60,
    codehubCommand: 'codehub',
    opencodeCommand: 'opencode',
    gitCommand: 'git',
    gitProtocol: 'https'
  };
}

// Field name → [Chinese label, validator returning an error string or null]
const SCHEMA = {
  port: ['端口', (v) => Number.isInteger(v) && v > 0 && v < 65536 ? null : '应为 1–65535 的整数'],
  dataDir: ['数据目录', (v) => typeof v === 'string' && v.trim() ? null : '应为非空路径'],
  concurrency: ['并发数', (v) => Number.isInteger(v) && v >= 1 && v <= 64 ? null : '应为 1–64 的整数'],
  excludeFileTypes: ['排除文件类型', (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() && !/[\\/]/.test(x)) ? null : '应为字符串数组，每项是扩展名（如 .png）或完整文件名（如 go.sum），不含目录'],
  outputLanguage: ['输出语言', (v) => typeof v === 'string' && v.trim() ? null : '应为非空字符串'],
  wrapUpMinutes: ['收尾时间', (v) => typeof v === 'number' && v > 0 ? null : '应为大于 0 的分钟数'],
  opencodeTimeoutMinutes: ['OpenCode 超时', (v) => typeof v === 'number' && v > 0 ? null : '应为大于 0 的分钟数'],
  codehubCommand: ['CodeHub CLI 命令', cmdCheck],
  opencodeCommand: ['OpenCode 命令', cmdCheck],
  gitCommand: ['Git 命令', cmdCheck],
  gitProtocol: ['Git 协议', (v) => v === 'https' || v === 'ssh' ? null : '应为 https 或 ssh']
};

function cmdCheck(v) {
  if (typeof v === 'string' && v.trim()) return null;
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && x)) return null;
  return '应为命令名、路径或字符串数组';
}

class ConfigError extends Error {}

const STARTER = {
  '//': 'ReviewX 配置文件。只写需要修改的配置项，未写的项使用默认值；可用的配置项见 README「配置」一节。修改后重启 ReviewX 生效。'
};

function loadConfig(configPath) {
  const file = configPath || process.env.REVIEWX_CONFIG || defaultConfigPath();
  const cfg = defaults();
  let raw = null;
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new ConfigError('配置文件格式错误（不是有效的 JSON）：' + file + '\n' + e.message);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigError('配置文件格式错误：根节点应为对象：' + file);
    }
    for (const key of Object.keys(raw)) {
      if (key.startsWith('$') || key.startsWith('//')) continue;
      const rule = SCHEMA[key];
      if (!rule) throw new ConfigError('配置文件格式错误：未知配置项「' + key + '」：' + file);
      const msg = rule[1](raw[key]);
      if (msg) throw new ConfigError('配置文件格式错误：「' + rule[0] + '」（' + key + '）' + msg + '：' + file);
      cfg[key] = raw[key];
    }
    if (cfg.wrapUpMinutes >= cfg.opencodeTimeoutMinutes) {
      throw new ConfigError('配置文件格式错误：「收尾时间」（wrapUpMinutes）应小于「OpenCode 超时」（opencodeTimeoutMinutes）：' + file);
    }
  } else {
    // First run: create a starter file the user can find. It lists no values,
    // so items left out keep following ReviewX's defaults across upgrades.
    try {
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, JSON.stringify(STARTER, null, 2) + '\n');
    } catch { /* not fatal */ }
  }
  cfg.dataDir = path.resolve(cfg.dataDir);
  cfg.configPath = file;
  return cfg;
}

module.exports = { loadConfig, defaults, defaultConfigPath, localDataDir, ConfigError, DEFAULT_EXCLUDES };
