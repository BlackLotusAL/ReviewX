'use strict';
// Configuration (R13, R26). The config file always lives at
// %APPDATA%\ReviewX\config.json (Roaming); data defaults to %LOCALAPPDATA%\ReviewX
// (Local). ReviewX writes nowhere else. Port and data directory are changed only in
// that file (restart needed); every other item can also be changed on the
// Settings page, which validates all fields and writes them back to the file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
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

function reviewxHome() { return path.join(appDataDir(), 'ReviewX'); }
function defaultConfigPath() { return path.join(reviewxHome(), 'config.json'); }

function defaults() {
  return {
    port: 17080,
    dataDir: path.join(localDataDir(), 'ReviewX'),
    // Settings page items
    autoFetch: true,
    autoFetchIntervalMinutes: 60,
    autoReviewNewMr: true,
    autoReviewNewVersion: true,
    skipKeywords: ['WIP'],
    stopQueueOnFailure: false,
    reviewTimeoutMinutes: 60,
    wrapUpMinutes: 50,
    outputLanguage: '中文',
    concurrency: 6,
    excludeFileTypes: DEFAULT_EXCLUDES.slice(),
    // Config file only, for unusual setups
    codehubCommand: 'codehub',
    opencodeCommand: 'opencode',
    gitCommand: 'git',
    gitProtocol: 'https'
  };
}

const posInt = (min, max) => (v) => (Number.isInteger(v) && v >= min && (max === undefined || v <= max)) ? null
  : (min > 1 ? '须为不小于 ' + min + ' 的整数' : '须为正整数') + (max !== undefined ? '（不超过 ' + max + '）' : '');
const bool = (v) => typeof v === 'boolean' ? null : '须为 true 或 false';
function cmdCheck(v) {
  if (typeof v === 'string' && v.trim()) return null;
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && x)) return null;
  return '须为命令名、路径或字符串数组';
}

// key → [Chinese label, validator]
const SCHEMA = {
  port: ['端口', posInt(1, 65535)],
  dataDir: ['数据目录', (v) => typeof v === 'string' && v.trim() ? null : '须为非空路径'],
  autoFetch: ['自动获取 MR', bool],
  autoFetchIntervalMinutes: ['获取间隔', posInt(5, 7 * 24 * 60)],
  autoReviewNewMr: ['自动检视新 MR', bool],
  autoReviewNewVersion: ['自动检视新版本', bool],
  skipKeywords: ['跳过关键词', (v) => Array.isArray(v) && v.length <= 100 && v.every((x) => typeof x === 'string' && x.trim()) ? null : '须为非空字符串组成的列表'],
  stopQueueOnFailure: ['失败时停止队列', bool],
  reviewTimeoutMinutes: ['检视超时', posInt(1, 24 * 60)],
  wrapUpMinutes: ['收尾时间', posInt(1, 24 * 60)],
  outputLanguage: ['输出语言', (v) => typeof v === 'string' && v.trim() ? null : '须为非空字符串'],
  concurrency: ['CLI 并发数', posInt(1, 64)],
  excludeFileTypes: ['排除文件类型', (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() && !/[\\/\s]/.test(x)) ? null : '只匹配文件名：每项是扩展名（如 .png）或完整文件名（如 go.sum），不能包含目录或空格'],
  codehubCommand: ['CodeHub CLI 命令', cmdCheck],
  opencodeCommand: ['OpenCode 命令', cmdCheck],
  gitCommand: ['Git 命令', cmdCheck],
  gitProtocol: ['Git 协议', (v) => v === 'https' || v === 'ssh' ? null : '须为 https 或 ssh']
};

// Old names still accepted in the config file.
const ALIASES = { opencodeTimeoutMinutes: 'reviewTimeoutMinutes' };

// Items the Settings page can change, in page order.
const EDITABLE = ['autoFetch', 'autoFetchIntervalMinutes', 'autoReviewNewMr', 'autoReviewNewVersion', 'skipKeywords',
  'stopQueueOnFailure', 'reviewTimeoutMinutes', 'wrapUpMinutes', 'outputLanguage', 'concurrency', 'excludeFileTypes'];

class ConfigError extends Error {}

const STARTER = {
  '//': 'ReviewX 配置文件。端口（port）和数据目录（dataDir）只能在这里修改，重启后生效；其余配置项也可以在 ReviewX 的「设置」页修改。只写需要修改的项，未写的项使用默认值，可用的配置项见 README「配置」一节。'
};

// Validate a set of values; returns { key: message } for every bad field.
function validate(values) {
  const errors = {};
  for (const [key, v] of Object.entries(values)) {
    const rule = SCHEMA[key];
    if (!rule) { errors[key] = '未知配置项'; continue; }
    const msg = rule[1](v);
    if (msg) errors[key] = msg;
  }
  const wrap = values.wrapUpMinutes; const timeout = values.reviewTimeoutMinutes;
  if (!errors.wrapUpMinutes && !errors.reviewTimeoutMinutes && Number.isInteger(wrap) && Number.isInteger(timeout) && wrap >= timeout) {
    errors.wrapUpMinutes = '须小于检视超时（' + timeout + ' 分钟）';
  }
  return errors;
}

function readRaw(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError('配置文件格式错误（不是有效的 JSON）：' + file + '\n' + e.message);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('配置文件格式错误：根节点应为对象：' + file);
  return raw;
}

function loadConfig(configPath) {
  const file = configPath || process.env.REVIEWX_CONFIG || defaultConfigPath();
  const cfg = defaults();
  const raw = readRaw(file);
  if (raw) {
    const values = {};
    for (const key of Object.keys(raw)) {
      if (key.startsWith('$') || key.startsWith('//')) continue;
      const name = ALIASES[key] || key;
      if (!SCHEMA[name]) throw new ConfigError('配置文件格式错误：未知配置项「' + key + '」：' + file);
      if (ALIASES[key] && Object.prototype.hasOwnProperty.call(raw, name)) continue; // new name wins
      values[name] = raw[key];
    }
    const errors = validate(Object.assign({}, pick(cfg, ['wrapUpMinutes', 'reviewTimeoutMinutes']), values));
    const bad = Object.keys(errors)[0];
    if (bad) throw new ConfigError('配置文件格式错误：「' + SCHEMA[bad][0] + '」（' + bad + '）' + errors[bad] + '：' + file);
    Object.assign(cfg, values);
  } else {
    // First run: a starter file that pins no values, so items left out keep
    // following ReviewX's defaults across upgrades.
    try {
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, JSON.stringify(STARTER, null, 2) + '\n');
    } catch { /* not fatal */ }
  }
  // The previous version kept data next to the config file in %APPDATA%\ReviewX.
  // An install that never set dataDir keeps using that data where it is,
  // instead of starting empty.
  if (!(raw && Object.prototype.hasOwnProperty.call(raw, 'dataDir'))) {
    const legacy = reviewxHome();
    const hasData = (dir) => fs.existsSync(path.join(dir, 'projects.json'));
    if (path.resolve(legacy) !== path.resolve(cfg.dataDir) && hasData(legacy) && !hasData(cfg.dataDir)) {
      cfg.dataDir = legacy;
      cfg.legacyDataDir = true;
    }
  }
  cfg.dataDir = path.resolve(cfg.dataDir);
  cfg.configPath = file;
  return cfg;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

function editableValues(cfg) {
  const out = pick(cfg, EDITABLE);
  for (const k of ['skipKeywords', 'excludeFileTypes']) out[k] = out[k].slice();
  return out;
}

// Settings page save (R26): validate every field; on success write the file
// and return the merged values. Values equal to the default are left out of
// the file so they keep following ReviewX's defaults.
function saveSettings(file, current, input) {
  const values = {};
  const errors = {};
  for (const k of EDITABLE) {
    let v = Object.prototype.hasOwnProperty.call(input, k) ? input[k] : current[k];
    if (k === 'skipKeywords' || k === 'excludeFileTypes') {
      if (Array.isArray(v)) v = [...new Set(v.map((x) => (typeof x === 'string' ? x.trim() : x)))];
    }
    if (k === 'outputLanguage' && typeof v === 'string') v = v.trim();
    values[k] = v;
  }
  for (const k of Object.keys(input)) if (!EDITABLE.includes(k)) errors[k] = SCHEMA[k] ? '只能在配置文件中修改' : '未知配置项';
  Object.assign(errors, validate(values));
  if (Object.keys(errors).length) return { ok: false, errors };
  const raw = readRaw(file) || Object.assign({}, STARTER);
  for (const [alias] of Object.entries(ALIASES)) delete raw[alias];
  const def = defaults();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const k of EDITABLE) {
    if (same(values[k], def[k])) delete raw[k];
    else raw[k] = values[k];
  }
  ensureDir(path.dirname(file));
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(tmp, file);
  const changed = EDITABLE.filter((k) => !same(values[k], current[k]));
  return { ok: true, values, changed };
}

module.exports = {
  loadConfig, saveSettings, validate, editableValues, defaults, defaultConfigPath, reviewxHome, localDataDir,
  ConfigError, DEFAULT_EXCLUDES, EDITABLE, SCHEMA
};
