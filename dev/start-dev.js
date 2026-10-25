#!/usr/bin/env node
'use strict';
// npm run dev: build the sandbox (if needed) and start ReviewX against it.
const path = require('path');
const { spawn, execFileSync } = require('child_process');

execFileSync(process.execPath, [path.join(__dirname, 'setup.js'), ...process.argv.slice(2).filter((a) => a === '--reset')], { stdio: 'inherit' });
const env = Object.assign({}, process.env, {
  MOCK_CODEHUB_STATE: path.join(__dirname, '.mock', 'state.json'),
  REVIEWX_LOCK_DIR: path.join(__dirname, '.mock')
});
const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'reviewx.js'), '--config', path.join(__dirname, '.mock', 'config.json'), ...process.argv.slice(2).filter((a) => a === '--no-open')], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code || 0));
process.on('SIGINT', () => {});
