#!/usr/bin/env node
'use strict';
// A stand-in for the CodeHub CLI, for development and tests only. It follows
// the CLI's JSON contract (stdout = result, stderr = {code,message,http_status},
// exit codes 0/2/3/4/8) and keeps its data in a JSON state file.
//
// State file: $MOCK_CODEHUB_STATE or dev/.mock/state.json
const fs = require('fs');
const path = require('path');

const stateFile = process.env.MOCK_CODEHUB_STATE || path.join(__dirname, '.mock', 'state.json');
const EXIT = { INVALID_ARGUMENT: 2, CONFIG_ERROR: 3, AUTH_ERROR: 3, HTTP_ERROR: 4, NETWORK_ERROR: 8, WRITE_RESULT_UNKNOWN: 8 };

function fail(code, message, http) {
  const e = { code, message };
  if (http) e.http_status = http;
  process.stderr.write(JSON.stringify(e, null, 2) + '\n');
  process.exit(EXIT[code] || 1);
}
function ok(v) { process.stdout.write(JSON.stringify(v, null, 2) + '\n'); process.exit(0); }

function load() { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
function save(s) { fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); }

const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i++; } else pos.push(argv[i]);
}
const delay = Number(process.env.MOCK_CODEHUB_DELAY_MS || 300);

setTimeout(() => {
  let s;
  try { s = load(); } catch { fail('CONFIG_ERROR', 'Mock state missing.'); }
  if (s.auth === false) fail('AUTH_ERROR', 'Not logged in.');
  const [group, cmd, sub] = pos;
  const project = (id) => {
    if (!/^[1-9]\d*$/.test(String(id || ''))) fail('INVALID_ARGUMENT', 'Project ID must be a positive integer.');
    const p = s.projects[id];
    if (!p) fail('HTTP_ERROR', 'CodeHub request failed.', 404);
    return p;
  };
  const mrOut = (p, m, detail) => {
    const o = { repo_id: p.id, mr_id: String(1000 + Number(m.iid)), iid: String(m.iid), title: m.title, state: m.state || 'opened', is_draft: false, author: m.author || 'dev', source_branch: m.source_branch, target_branch: m.target_branch, updated_at: m.updated_at, web_url: p.web_url + '/merge_requests/' + m.iid };
    if (detail) Object.assign(o, { description: m.description || '', labels: [], created_at: m.created_at || m.updated_at, changes: null });
    return o;
  };

  if (group === 'repo' && cmd === 'view') {
    const p = project(pos[2]);
    if (p.fail && p.fail.view) fail(p.fail.view, 'Injected failure.');
    ok({ repo_id: p.id, full_name: p.full_name, clone_urls: { https: p.clone_url, ssh: null }, archived: false, updated_at: '2026-10-20T08:00:00Z', default_branch: 'main', web_url: p.web_url });
  }
  if (group === 'mr') {
    const p = project(flags['project-id']);
    if (cmd === 'list') {
      if (p.fail && p.fail.list) fail(p.fail.list, 'Injected failure.');
      ok(p.mrs.filter((m) => (m.state || 'opened') === 'opened').map((m) => mrOut(p, m, false)));
    }
    const iid = pos[2];
    const m = p.mrs.find((x) => String(x.iid) === String(iid));
    if (cmd === 'view') { if (!m) fail('HTTP_ERROR', 'CodeHub request failed.', 404); ok(mrOut(p, m, true)); }
    if (cmd === 'commits') { if (!m) fail('HTTP_ERROR', 'CodeHub request failed.', 404); ok([]); }
    if (cmd === 'comment' && sub === 'create') {
      const realIid = pos[3];
      const mm = p.mrs.find((x) => String(x.iid) === String(realIid));
      if (!mm) fail('HTTP_ERROR', 'CodeHub request failed.', 404);
      if (!flags.body) fail('INVALID_ARGUMENT', 'body is required.');
      if (flags.severity && !['suggestion', 'minor', 'major', 'fatal'].includes(flags.severity)) fail('INVALID_ARGUMENT', 'Invalid severity.');
      // Optional scripted outcomes: state.commentResults = ["ok","unknown","network"]
      const next = (s.commentResults || []).shift() || 'ok';
      s.comments = s.comments || [];
      if (next === 'ok' || next === 'unknown') s.comments.push({ project: p.id, iid: realIid, severity: flags.severity || 'suggestion', body: flags.body, at: new Date().toISOString() });
      save(s);
      if (next === 'unknown') fail('WRITE_RESULT_UNKNOWN', 'Write result unknown.');
      if (next === 'network') fail('NETWORK_ERROR', 'Network unavailable.');
      ok({ comment_id: String(s.comments.length), repo_id: p.id, mr_iid: String(realIid), severity: flags.severity || 'suggestion', resolved: false, web_url: p.web_url + '/merge_requests/' + realIid + '#note_' + s.comments.length });
    }
  }
  fail('INVALID_ARGUMENT', 'Unknown command.');
}, delay);
