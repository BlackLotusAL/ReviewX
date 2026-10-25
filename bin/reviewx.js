#!/usr/bin/env node
'use strict';
// Entry point: `reviewx` (R13 启动 / 停止服务 / 单实例 / 端口与访问).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadConfig, localDataDir, ConfigError } = require('../src/config');
const { StoreError } = require('../src/store');
const { App, openExternal } = require('../src/app');
const { createServer } = require('../src/server');
const { killAll } = require('../src/proc');
const { ensureDir } = require('../src/util');

function parseArgs(argv) {
  const out = { open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.config = argv[++i];
    else if (a === '--no-open') out.open = false;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-v' || a === '--version') out.version = true;
  }
  return out;
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', headers: { Host: '127.0.0.1:' + port }, timeout: 1500 }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = require('../package.json');
  if (args.version) { console.log(pkg.version); return; }
  if (args.help) {
    console.log('用法：reviewx [--config <配置文件>] [--no-open]\n\n启动本机 ReviewX 服务并在默认浏览器打开页面；按 Ctrl+C 停止服务。');
    return;
  }

  let cfg;
  try {
    cfg = loadConfig(args.config);
  } catch (e) {
    if (e instanceof ConfigError) { console.error('ReviewX 拒绝启动：' + e.message); process.exit(2); }
    throw e;
  }

  // Single instance per machine.
  const lockDir = ensureDir(process.env.REVIEWX_LOCK_DIR || path.join(localDataDir(), 'ReviewX'));
  const lockFile = path.join(lockDir, 'instance.json');
  let lock = null;
  try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* none */ }
  if (lock && lock.pid !== process.pid && alive(lock.pid)) {
    const info = await ping(lock.port);
    if (info && info.app === 'ReviewX') {
      const url = 'http://127.0.0.1:' + lock.port + '/';
      console.log('ReviewX 已在运行：' + url);
      if (args.open) openExternal(url);
      return;
    }
  }

  const app = new App(cfg);
  try {
    app.init();
  } catch (e) {
    if (e instanceof StoreError) { console.error('ReviewX 拒绝启动：' + e.message); process.exit(2); }
    throw e;
  }

  const server = createServer(app);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error('ReviewX 拒绝启动：端口 ' + cfg.port + ' 已被其他程序占用。请在配置文件中更换「端口」（port）后重试：' + cfg.configPath);
    } else {
      console.error('ReviewX 拒绝启动：' + e.message);
    }
    process.exit(2);
  });
  server.listen(cfg.port, '127.0.0.1', () => {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: cfg.port, startedAt: new Date().toISOString() }));
    const url = 'http://127.0.0.1:' + cfg.port + '/';
    app.logger.info('server.start addr=127.0.0.1:' + cfg.port + ' data=' + cfg.dataDir + ' version=' + pkg.version);
    console.log('ReviewX ' + pkg.version + ' 已启动');
    console.log('  访问地址：' + url);
    console.log('  诊断日志：' + app.logger.currentPath());
    console.log('  配置文件：' + cfg.configPath);
    console.log('  数据目录：' + cfg.dataDir);
    console.log('按 Ctrl+C 停止服务。');
    if (args.open && !openExternal(url)) console.log('无法自动打开浏览器，请手动访问上面的地址。');
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) { killAll(); process.exit(1); }
    stopping = true;
    console.log('\n正在停止 ReviewX…');
    app.logger.info('server.stop');
    const done = app.engine.stopAll().catch(() => {});
    await Promise.race([done, new Promise((r) => setTimeout(r, 8000))]);
    killAll();
    server.close();
    try {
      const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (cur.pid === process.pid) fs.unlinkSync(lockFile);
    } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGBREAK', shutdown);
  process.on('exit', () => killAll());
  process.on('uncaughtException', (e) => { try { app.logger.error('uncaught ' + e.stack); } catch { /* ignore */ } console.error(e); });
  process.on('unhandledRejection', (e) => { try { app.logger.error('unhandled ' + (e && e.stack || e)); } catch { /* ignore */ } });
}

main().catch((e) => { console.error(e); process.exit(1); });
