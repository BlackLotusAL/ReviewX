'use strict';
/* ReviewX web UI. All external content (MR titles, AI output, rule text) is
 * escaped before it reaches the DOM; links and images inside it stay text (R09). */
(function () {
  // ---------- helpers ----------
  const STEPS = ['读取 MR 信息', '拉取源分支', '拉取目标分支', '校验 MR 未变化', '生成变更快照', 'OpenCode 检视', '保存报告与意见'];
  const IC = {
    play: 'm8 5 11 7-11 7Z', stop: 'M6 6h12v12H6Z', x: 'm6 6 12 12M6 18 18 6', plus: 'M12 5v14M5 12h14',
    refresh: 'M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 19.5 10M4.5 14A8 8 0 0 0 17.9 17.9',
    arrow: 'M5 12h14m-5-5 5 5-5 5', chevDown: 'm6 9 6 6 6-6', chevRight: 'm9 5 7 7-7 7',
    branch: 'M6 6v12m0-8c8 0 12-1 12-4M4 4a2 2 0 1 0 4 0 2 2 0 1 0-4 0M4 20a2 2 0 1 0 4 0 2 2 0 1 0-4 0M16 4a2 2 0 1 0 4 0 2 2 0 1 0-4 0',
    clock: 'M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', doc: 'M14 3H5v18h14V8Zm0 0v5h5M8 12h8M8 16h6',
    log: 'M4 6h16M4 12h16M4 18h10', check: 'm5 12 4 4L19 6',
    warn: 'M12 8v5m0 3v.01M10.3 4.8 2.8 18a1.5 1.5 0 0 0 1.3 2h15.8a1.5 1.5 0 0 0 1.3-2L13.7 4.8a2 2 0 0 0-3.4 0Z',
    minus: 'M5 12h14', folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    send: 'm21 3-7 18-4-7-7-4ZM21 3 10 14', ext: 'M14 4h6v6m0-6L10 14M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5',
    file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Zm0 0v5h5'
  };
  const SEVC = { fatal: ['Fatal', '#c62f3a', '#ffffff', '#c62f3a'], major: ['Major', '#fdebdc', '#a14a0b', '#f2c49d'], minor: ['Minor', '#fff6d6', '#7a5b00', '#ecd68c'], suggestion: ['Suggestion', '#eaf1f8', '#3d5a80', '#c9d8ea'] };
  const FST = {
    pending: ['待处理', '#0059b8'], sending: ['发送中…', '#0059b8'], published: ['已发布', '#18733f'], manual: ['已发布 · 人工确认', '#18733f'],
    dismissed: ['不发送', '#62686c'], unknown: ['结果未知', '#3b3f42'], failed: ['发布失败', '#ac3039'], superseded: ['已被新报告取代', '#62686c']
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ico = (d, cls, style) => '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true"' + (style ? ' style="' + style + '"' : '') + '><path d="' + d + '"></path></svg>';
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (ts) => { if (!ts) return ''; const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const mdhm = (ts) => { if (!ts) return ''; const d = new Date(ts); if (isNaN(d)) return String(ts); return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + hm(d); };
  const ymdhm = (ts) => { const d = new Date(ts); return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + hm(d); };
  const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return pad(Math.floor(s / 60)) + ':' + pad(s % 60); };
  const dur = (ms) => { if (ms == null) return ''; const s = Math.round(ms / 1000); return Math.floor(s / 60) + 'm' + pad(s % 60) + 's'; };
  const stepTime = (ms) => { if (ms == null) return ''; const s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + pad(s % 60); };
  const attr = (o) => Object.keys(o).filter((k) => o[k] !== false && o[k] != null).map((k) => o[k] === true ? k : k + '="' + esc(o[k]) + '"').join(' ');
  const data = (o) => Object.keys(o).map((k) => 'data-' + k + '="' + esc(o[k]) + '"').join(' ');

  // Untrusted text: markdown links/images become plain text, `code` gets styled.
  function plain(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '[图片] $2');
    s = s.replace(/<img\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)[^>]*>/gi, '[图片] $1');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '$1（$2）');
    const parts = s.split(/(`[^`\n]+`)/g);
    return parts.map((p) => (/^`[^`\n]+`$/.test(p) ? '<code>' + esc(p.slice(1, -1)) + '</code>' : esc(p))).join('');
  }

  function hl(code) {
    if (!code) return '';
    const re = /(\/\/[^\n]*|#[^\n]*$)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(const|let|var|function|func|def|return|if|else|elif|for|while|of|in|new|throw|await|async|export|import|from|package|class|extends|implements|try|catch|except|finally|typeof|interface|type|struct|null|nil|None|undefined|true|false|True|False|this|self|public|private|protected|static|void|int|string)\b|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)(?=\s*\()/gm;
    let out = ''; let last = 0; let m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      const c = m[1] ? '#6e7781' : m[2] ? '#0a3069' : m[3] ? '#cf222e' : m[4] ? '#0550ae' : '#8250df';
      out += '<span style="color: ' + c + '">' + esc(m[0]) + '</span>';
      last = re.lastIndex;
    }
    return out + esc(code.slice(last));
  }

  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: Object.assign({ 'X-ReviewX': '1' }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let j = {};
    try { j = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new Error(j.error || ('请求失败（' + res.status + '）'));
    return j;
  }

  // ---------- state ----------
  const S = {
    srv: null, connected: false,
    view: 'mr', drawer: null, drawerClosing: false, detail: null, detailRev: -1, tab: null, groupOrder: null,
    menu: null, queueOpen: false, dialog: null, dialogTasks: [],
    pid: '', pidMsg: null, pidBusy: false, flash: null,
    confirmBulk: false, toast: null,
    rules: null, ruleScope: 'global', ruleSel: null, edit: null, scopeMenu: null, scopeQ: '',
    logs: [], logPath: '', logErrorsOnly: false, busy: {}
  };

  function toast(text) {
    S.toast = { text, at: Date.now() };
    render();
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { S.toast = null; render(); }, 4000);
  }

  async function act(fn, okText) {
    try {
      const r = await fn();
      if (okText) toast(typeof okText === 'function' ? okText(r) : okText);
      else if (r && r.text) toast(r.text);
      return r;
    } catch (e) {
      toast(e.message);
      return null;
    }
  }

  const proj = (pid) => (S.srv ? S.srv.projects.find((p) => p.id === pid) : null);
  const mrOf = (pid, iid) => (S.srv ? S.srv.mrs.find((m) => m.pid === pid && m.iid === iid) : null);
  const jobOf = (pid, iid) => (S.srv ? S.srv.queue.find((j) => j.pid === pid && j.iid === iid) : null);
  const now = () => Date.now() + (S.clockSkew || 0);

  function queuePos(pid, iid) {
    const q = S.srv.queue.filter((j) => j.status === 'queued');
    return { pos: q.findIndex((j) => j.pid === pid && j.iid === iid) + 1, n: q.length };
  }

  function stepDetail(j, long) {
    if (!j || !j.step) return '';
    const el = now() - (j.stepStartedAt || now());
    if (j.step === 5) return (long ? '文件 ' : '') + j.obj + '/' + j.objN + (long ? '' : ' 个文件');
    if (j.step === 6) return (j.phase === 'wrapup' ? '收尾中 · ' : '') + '差异 ' + j.diffRead + '/' + j.diffN + ' · 意见 ' + j.findings + ' 条 · ' + mmss(el) + ' / ' + mmss(j.limitMs);
    if (j.step === 7) return '意见 ' + j.objN + '/' + j.objN;
    return '已运行 ' + mmss(el);
  }

  // ---------- render ----------
  const root = document.getElementById('root');

  function render() {
    if (!S.srv) {
      root.innerHTML = '<div style="padding: 48px; color: #62686c">' + (S.connected ? '加载中…' : '正在连接 ReviewX 服务…') + '</div>';
      return;
    }
    const html = '<div>' + (S.connected ? '' : '<div class="conn" role="alert">与 ReviewX 服务的连接已断开，正在重连…（服务停止后请在终端重新运行 reviewx）</div>') +
      '<div class="layout">' + sidebar() + '<main class="main">' + (S.view === 'mr' ? viewMr() : S.view === 'rules' ? viewRules() : viewLogs()) + '</main></div>' +
      drawer() + dialog() + (S.toast ? '<div class="toast" role="status">' + esc(S.toast.text) + '</div>' : '') + '</div>';
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const next = tpl.content.firstElementChild;
    if (!root.firstElementChild) root.appendChild(next);
    else morph(root.firstElementChild, next);
    const dr = document.getElementById('drawer');
    if (dr && dr.firstElementChild) {
      const h0 = dr.firstElementChild.offsetHeight + 'px';
      if (dr.style.getPropertyValue('--dh') !== h0) dr.style.setProperty('--dh', h0);
    }
  }

  // ---- DOM morph: keeps focus, scroll and input state between renders ----
  const keyOf = (n) => (n.nodeType === 1 ? (n.getAttribute('data-key') || n.id || null) : null);
  function morph(a, b) {
    if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) { a.replaceWith(b); return; }
    if (a.nodeType === 3 || a.nodeType === 8) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
    const keepOpen = a.nodeName === 'DETAILS';
    for (const at of [...a.attributes]) if (!b.hasAttribute(at.name) && !(keepOpen && at.name === 'open')) a.removeAttribute(at.name);
    for (const at of [...b.attributes]) {
      if (keepOpen && at.name === 'open') continue;
      if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    }
    if (a.nodeName === 'INPUT' || a.nodeName === 'TEXTAREA') {
      const v = b.nodeName === 'TEXTAREA' ? b.value : (b.getAttribute('value') || '');
      if (document.activeElement !== a && a.value !== v) a.value = v;
      if (a.nodeName === 'TEXTAREA') return;
    }
    const bk = [...b.childNodes];
    const keyed = new Map();
    for (const c of a.childNodes) { const k = keyOf(c); if (k) keyed.set(k, c); }
    let cur = a.firstChild;
    for (const nb of bk) {
      const k = keyOf(nb);
      let match = null;
      if (k) { match = keyed.get(k) || null; if (match) keyed.delete(k); }
      else if (cur && !keyOf(cur) && cur.nodeName === nb.nodeName) match = cur;
      if (match) {
        if (match === cur) cur = cur.nextSibling; else a.insertBefore(match, cur);
        morph(match, nb);
      } else a.insertBefore(nb, cur);
    }
    while (cur) { const n = cur.nextSibling; a.removeChild(cur); cur = n; }
  }

  // ---- sidebar ----
  function sidebar() {
    const s = S.srv;
    const pendingTotal = s.mrs.reduce((n, m) => n + (projFailed(m.pid) ? 0 : m.pending), 0);
    const nav = [['mr', '检视队列', IC.branch, pendingTotal ? pendingTotal + ' 待处理' : ''], ['rules', '规则配置', IC.doc, s.drafts.length ? s.drafts.length + ' 草稿' : ''], ['logs', '会话日志', IC.log, '']];
    let h = '<aside aria-label="导航与项目" class="side">';
    h += '<div style="display: flex; align-items: center; gap: 10px; padding: 0 4px"><span aria-hidden="true" style="position: relative; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; background: #121212; color: #ffffff; font-size: 17px; line-height: 1; font-weight: 700; letter-spacing: -0.06em; padding: 0 0 2px 1px; box-sizing: border-box"><span style="display: inline-flex; align-items: baseline">rx<span style="display: inline-block; width: 4px; height: 4px; margin-left: 2px; background: #3d9bff; border-radius: 50%"></span></span></span><span style="font-size: 17px; font-weight: 600; letter-spacing: -0.02em">ReviewX</span></div>';
    h += '<nav aria-label="视图" style="display: flex; flex-direction: column; gap: 4px">';
    for (const n of nav) {
      const on = S.view === n[0];
      h += '<button type="button" class="navlink" ' + data({ act: 'go', view: n[0] }) + (on ? ' aria-current="page"' : '') + ' style="background: ' + (on ? '#ffffff' : 'transparent') + '; border-color: ' + (on ? '#e1e3e6' : 'transparent') + '; color: ' + (on ? '#121212' : '#62686c') + '; font-weight: ' + (on ? 500 : 400) + '">' + ico(n[2]) + esc(n[1]) +
        (n[3] ? '<span style="margin-left: auto; font-size: 12px; font-weight: 500; color: ' + (n[0] === 'mr' ? '#0059b8' : '#62686c') + '; background: ' + (n[0] === 'mr' ? '#eaf3ff' : '#eef0f2') + '; padding: 0 8px; border-radius: 999px">' + esc(n[3]) + '</span>' : '') + '</button>';
    }
    h += '</nav>';
    const bad = S.pidMsg && S.pidMsg.tone === 'bad';
    const tone = { bad: '#ac3039', info: '#0059b8', ok: '#18733f', muted: '#62686c' };
    h += '<section aria-labelledby="pj-h" style="display: flex; flex-direction: column; gap: 10px"><h2 id="pj-h" style="margin: 0 0 0 2px; font-size: 13px; font-weight: 600; color: #62686c">关注项目</h2>';
    h += '<div style="display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px"><label for="pid-input" class="sr-only">Project ID</label>' +
      '<input id="pid-input" class="field" inputmode="numeric" autocomplete="off" placeholder="Project ID，例如 512" ' + attr({ value: S.pid, 'aria-invalid': bad ? 'true' : 'false', 'data-input': 'pid' }) + ' style="border-color: ' + (bad ? '#ac3039' : '#c6c9cc') + '">' +
      '<button type="button" class="btn btn-s" style="padding: 0 13px" ' + attr({ disabled: S.pidBusy, 'data-act': 'addProject' }) + '>' + (S.pidBusy ? '<span class="spin"></span>校验中' : ico(IC.plus) + '添加') + '</button></div>';
    if (S.pidMsg) h += '<p role="status" style="margin: -2px 0 0 2px; font-size: 12px; color: ' + tone[S.pidMsg.tone] + '">' + esc(S.pidMsg.text) + '</p>';
    const folders = [];
    for (const p of s.projects) { let g = folders.find((x) => x.folder === p.folder); if (!g) { g = { folder: p.folder, items: [] }; folders.push(g); } g.items.push(p); }
    h += '<ul style="list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px">';
    for (const g of folders) {
      h += '<li data-key="fd-' + esc(g.folder) + '"><div style="display: flex; align-items: center; gap: 6px; min-height: 28px; padding-left: 2px; color: #62686c; font-size: 12px">' + ico(IC.folder, 'ico-s') + esc(g.folder) + '</div><ul style="list-style: none; margin: 0; padding: 0">';
      for (const p of g.items) {
        const st = p.fetch.status;
        const dot = { updated: '#18733f', failed: '#ac3039', fetching: '#8c9195', never: '#a3a8ad' }[st];
        const label = { updated: '已更新', failed: '获取失败', fetching: '获取中', never: '尚未获取' }[st];
        const open = S.menu === p.id;
        const sendingHere = s.sending && s.sending.pid === p.id;
        h += '<li data-key="pj-' + p.id + '" style="position: relative"><div style="display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 0 4px 0 10px; border-radius: 10px; background: ' + (S.flash === p.id ? '#eaf3ff' : 'transparent') + '; transition: background 200ms">' +
          '<span title="' + esc(label) + '" style="width: 7px; height: 7px; border-radius: 50%; background: ' + dot + '; flex: 0 0 auto"></span>' +
          '<button type="button" class="tbtn" ' + data({ act: 'goProject', pid: p.id }) + ' title="' + esc(p.path) + '" style="flex: 1; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">' + esc(p.short) + '</button>' +
          (st === 'fetching' || p.removing ? '<span class="spin" style="color: #62686c"></span>' : '') +
          '<span class="mono" style="font-size: 12px; color: #62686c">#' + esc(p.id) + '</span>' +
          '<button type="button" class="btn btn-q" aria-label="' + esc(p.short) + ' 更多操作" aria-expanded="' + open + '" ' + data({ act: 'menu', pid: p.id }) + ' style="min-height: 28px; width: 28px; padding: 0; color: #8c9195">⋯</button></div>';
        if (open) {
          h += '<div role="menu" style="position: absolute; right: 0; top: 38px; z-index: 6; width: 190px; padding: 6px; background: #ffffff; border: 1px solid #e1e3e6; border-radius: 12px; box-shadow: 0 8px 28px rgba(18,18,18,0.14); display: flex; flex-direction: column">' +
            '<button type="button" role="menuitem" class="btn btn-q" style="justify-content: flex-start; min-height: 36px; color: #121212; font-weight: 500" ' + attr({ disabled: !p.webUrl }) + ' ' + data({ act: 'openProject', pid: p.id }) + '>在 CodeHub 打开</button>' +
            '<button type="button" role="menuitem" class="btn btn-q" style="justify-content: flex-start; min-height: 36px; color: #121212; font-weight: 500" ' + data({ act: 'clearCache', pid: p.id }) + '>清除代码缓存</button>' +
            '<button type="button" role="menuitem" class="btn btn-q" style="justify-content: flex-start; min-height: 36px; color: #ac3039; font-weight: 500" ' + attr({ disabled: sendingHere || p.removing, title: sendingHere ? '评论发送中，发送结束后可移除' : false }) + ' ' + data({ act: 'askRemove', pid: p.id }) + '>移除项目…</button></div>';
        }
        h += '</li>';
      }
      h += '</ul></li>';
    }
    h += '</ul></section>';
    h += '<p style="margin: auto 0 0 4px; font-size: 12px; color: #8c9195">ReviewX ' + esc(s.version) + '</p>';
    return h + '</aside>';
  }

  const projFailed = (pid) => { const p = proj(pid); return p && p.fetch.status === 'failed'; };

  // ---- MR workspace ----
  function rank(m) {
    if (m.pending) return 0; if (m.verify) return 1;
    return ({ failed: 1.5, running: 2, stopping: 2, queued: 3, unreviewed: 5, stopped: 6 })[m.state] || 7;
  }

  function nextPendingMr() {
    for (const p of S.srv.projects) {
      if (p.fetch.status === 'failed') continue;
      const list = S.srv.mrs.filter((m) => m.pid === p.id && m.pending > 0).map((m, i) => [m, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]);
      if (list.length) return list[0][0];
    }
    return null;
  }

  function card(m, staleGroup, nextKey) {
    const j = jobOf(m.pid, m.iid);
    const tm = '更新于 ' + mdhm(m.updatedAt) + (m.durationMs != null && m.state === 'done' ? ' · 耗时 ' + dur(m.durationMs) : '');
    const vm = { border: '1px solid #e3e6e9', bg: '#f7f8fa', status: '', stFg: '#62686c', stW: 500, spin: false, dot: true, sub: '', stale: false, segs: null, btn: null };
    const btn = (cls, label, act, dis) => { vm.btn = { cls, label, act, dis }; };
    if (j && (j.status === 'running' || j.status === 'stopping')) {
      const stopping = j.status === 'stopping';
      Object.assign(vm, { status: stopping ? '停止中' : '检视中 ' + j.step + '/7', stFg: stopping ? '#62686c' : '#3b3f42', spin: true, dot: false, bg: '#ffffff',
        sub: stopping ? (j.stopNote || '正在停止') : (j.step ? STEPS[j.step - 1] + ' · ' + stepDetail(j) : '准备中'),
        segs: Array.from({ length: 7 }, (_, i) => ({ c: i + 1 < j.step ? '#3b3f42' : (i + 1 === j.step ? '#9aa0a6' : '#e1e3e6'), a: i + 1 === j.step && !stopping })) });
      if (!stopping) btn('btn-q', '停止', 'stop');
    } else if (j && j.status === 'queued') {
      const q = queuePos(m.pid, m.iid);
      Object.assign(vm, { status: '排队中 · 第 ' + q.pos + '/' + q.n + ' 位' });
      btn('btn-q', '取消排队', 'cancel');
    } else if (m.state === 'done') {
      if (m.conclusion === 'issues') {
        if (m.pending > 0) {
          const isNext = nextKey === m.pid + '/' + m.iid && !staleGroup;
          Object.assign(vm, { status: m.pending + ' 条待处理', stFg: '#0059b8', stW: 600, sub: m.verify ? m.verify + ' 条需到 CodeHub 核对' : '', stale: m.stale });
          if (isNext) Object.assign(vm, { border: '1.5px solid #0059b8', bg: '#f4f8fe' });
          btn(isNext ? 'btn-p' : 'btn-s', '处理意见', 'open');
        } else if (m.verify > 0) { Object.assign(vm, { status: m.verify + ' 条需到 CodeHub 核对', stFg: '#9a4a08', stale: m.stale }); btn('btn-s', '去核对', 'open'); }
        else Object.assign(vm, { status: '已处理完', stFg: '#18733f', stale: m.stale });
      } else if (m.conclusion === 'pass') Object.assign(vm, { status: '未发现问题', stFg: '#18733f', stale: m.stale });
      else Object.assign(vm, { status: '无可检视的变更', sub: '已排除 ' + m.excludedCount + ' 个文件', stale: m.stale });
      if (m.lastNewer && m.last) vm.sub = (m.last.status === 'failed' ? '最近一次检视失败' : '最近一次检视已停止') + (vm.sub ? ' · ' + vm.sub : '');
    } else if (m.state === 'failed') {
      Object.assign(vm, { status: '检视失败', stFg: '#ac3039', bg: staleGroup ? vm.bg : '#fff8f8', border: staleGroup ? vm.border : '1px solid #efc9cc', sub: m.last && m.last.failure ? m.last.failure.title : '' });
      btn('btn-s', '重新检视', 'start');
    } else if (m.state === 'stopped') {
      Object.assign(vm, { status: '已停止', sub: (m.last && m.last.stopReason) || '' });
      btn('btn-s', '重新检视', 'start');
    } else {
      vm.status = '未检视';
      btn('btn-s', '开始检视', 'start');
    }
    if (staleGroup) vm.btn = null;
    const k = { pid: m.pid, iid: m.iid };
    let h = '<article data-key="c-' + m.pid + '-' + m.iid + '" style="position: relative; display: flex; flex-direction: column; gap: 10px; min-height: 204px; box-sizing: border-box; padding: 20px 24px 18px; border: ' + vm.border + '; border-radius: 14px; background: ' + vm.bg + '; opacity: ' + (staleGroup ? 0.55 : 1) + '; overflow: hidden">';
    h += '<div style="display: flex; align-items: center; gap: 10px; font-size: 13px"><button type="button" class="tbtn mono" ' + data(Object.assign({ act: 'openMrWeb' }, k)) + ' aria-label="在 CodeHub 打开 MR !' + esc(m.iid) + '" ' + attr({ disabled: !m.webUrl }) + ' style="font-weight: 600; color: #121212">!' + esc(m.iid) + '</button>' +
      (m.isDraft ? '<span class="pill" style="background: #eef0f2; color: #62686c; padding: 0 8px">Draft</span>' : '') +
      (vm.stale ? '<span class="pill" style="background: #fdf6ec; color: #7a4a10; padding: 0 8px" title="报告基于旧版本">旧版本</span>' : '') + '</div>';
    h += '<h3 style="margin: 0; font-size: 17px; font-weight: 600; line-height: 1.5"><button type="button" class="tbtn title2" ' + data(Object.assign({ act: 'open' }, k)) + ' title="' + esc(m.title) + '">' + esc(m.title) + '</button></h3>';
    h += '<p style="margin: -4px 0 0; font-size: 13px; color: #8c9195; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">' + esc(tm) + (m.author ? ' · ' + esc(m.author) : '') + '</p>';
    if (vm.segs) h += '<div role="img" aria-label="步骤 ' + (j ? j.step : 0) + '/7" style="display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 3px; margin-top: 4px">' + vm.segs.map((sg) => '<span style="height: 4px; border-radius: 2px; background: ' + sg.c + '; animation: ' + (sg.a ? 'rxbreathe 1.6s ease-in-out infinite' : 'none') + '"></span>').join('') + '</div>';
    h += '<div style="margin-top: auto; display: flex; align-items: center; gap: 12px; min-height: 34px"><span style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; font-size: 14px; white-space: nowrap; overflow: hidden"><span style="display: inline-flex; align-items: center; gap: 6px; color: ' + vm.stFg + '; font-weight: ' + vm.stW + '">' + (vm.spin ? '<span class="spin"></span>' : '<span class="dot" style="width: 7px; height: 7px"></span>') + esc(vm.status) + '</span>' +
      (vm.sub ? '<span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 13px; color: #62686c">' + esc(vm.sub) + '</span>' : '') + '</span>';
    if (vm.btn) h += '<button type="button" class="btn ' + vm.btn.cls + '" style="min-height: 34px; padding: 0 15px" ' + data(Object.assign({ act: vm.btn.act }, k)) + '>' + esc(vm.btn.label) + '</button>';
    return h + '</div></article>';
  }

  function viewMr() {
    const s = S.srv;
    const f = s.fetch;
    const running = s.queue.filter((j) => j.status !== 'queued').length;
    const queued = s.queue.filter((j) => j.status === 'queued').length;
    const pendingTotal = s.mrs.reduce((n, m) => n + (projFailed(m.pid) ? 0 : m.pending), 0);
    const next = nextPendingMr();
    const nextKey = next ? next.pid + '/' + next.iid : null;
    let h = '<header style="position: relative; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px 24px">';
    h += '<div style="display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px 20px"><h1 style="margin: 0; font-size: 32px; line-height: 1.4; font-weight: 600">检视队列</h1>' +
      '<span role="status" style="font-size: 13px; color: #62686c">' + (f.active ? '<span class="spin" style="color: #62686c; margin-right: 6px; vertical-align: -1px"></span>获取中 · 项目 ' + f.done + '/' + f.total + ' 完成 · ' + f.failed + ' 个失败' : (f.summary ? esc(f.summary) + ' · ' + hm(f.finishedAt) : '')) + '</span></div>';
    h += '<div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px">' +
      '<button type="button" class="btn btn-s" aria-expanded="' + S.queueOpen + '" data-act="toggleQueue">' + (running ? '<span class="spin" style="color: #3b3f42"></span>' : '') + esc(running + queued ? '运行中 ' + running + ' · 排队 ' + queued : '队列空闲') + ico(IC.chevDown, 'ico-s', 'transform: ' + (S.queueOpen ? 'rotate(180deg)' : 'none')) + '</button>' +
      '<button type="button" class="btn btn-s" ' + attr({ disabled: f.active || !s.projects.length }) + ' data-act="fetchAll">' + ico(IC.refresh) + (f.active ? '获取中…' : '获取 MR') + '</button>' +
      '<button type="button" class="btn btn-s" data-act="nextPending">下一个待处理 MR' + ico(IC.arrow) + '</button></div>';
    if (S.queueOpen) {
      const items = [];
      for (const j of s.queue) {
        const run = j.status !== 'queued';
        const q = queuePos(j.pid, j.iid);
        items.push({ pid: j.pid, iid: j.iid, title: j.title, bg: '#eef0f2', fg: run ? '#3b3f42' : '#62686c', spin: run, label: run ? (j.status === 'stopping' ? '停止中' : '检视中') : '排队中', sub: run ? (j.step ? '步骤 ' + j.step + '/7 ' + STEPS[j.step - 1] : '准备中') : '第 ' + q.pos + '/' + q.n + ' 位' });
      }
      for (const m of s.mrs) {
        if (jobOf(m.pid, m.iid) || (!m.pending && !m.verify) || projFailed(m.pid)) continue;
        items.push({ pid: m.pid, iid: m.iid, title: m.title, bg: m.pending ? '#eaf3ff' : '#eef0f2', fg: m.pending ? '#0059b8' : '#3b3f42', spin: false, label: m.pending ? m.pending + ' 条待处理' : m.verify + ' 条需核对', sub: '检视完成' });
      }
      h += '<section aria-label="当前检视队列" style="position: absolute; right: 0; top: 64px; z-index: 6; width: min(560px, 100%); box-sizing: border-box; padding: 16px; background: #ffffff; border: 1px solid #e1e3e6; border-radius: 14px; box-shadow: 0 10px 32px rgba(18,18,18,0.16)">' +
        '<div style="display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; margin-bottom: 8px"><h3 style="margin: 0; font-size: 15px; font-weight: 600">当前检视队列</h3><span style="font-size: 12px; color: #62686c">执行中 ' + running + ' · 排队 ' + queued + ' · 待处理 ' + pendingTotal + '</span></div>' +
        (items.length ? '' : '<p style="margin: 8px 0; font-size: 13px; color: #62686c">队列为空</p>') + '<ul style="list-style: none; margin: 0; padding: 0">';
      for (const q of items) {
        const pr = proj(q.pid) || { short: '' };
        h += '<li data-key="q-' + q.pid + '-' + q.iid + '" style="border-top: 1px solid #e1e3e6"><button type="button" class="tbtn rowh" ' + data({ act: 'open', pid: q.pid, iid: q.iid }) + ' style="width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px 8px">' +
          '<span style="flex: 1; min-width: 0"><span style="display: block; font-size: 12px; color: #62686c">' + esc(pr.short) + ' <span class="mono" style="color: #0059b8">!' + esc(q.iid) + '</span></span><span style="display: block; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">' + esc(q.title) + '</span></span>' +
          '<span style="display: flex; flex-direction: column; align-items: flex-end; gap: 2px"><span class="pill" style="background: ' + q.bg + '; color: ' + q.fg + '">' + (q.spin ? '<span class="spin"></span>' : '') + esc(q.label) + '</span><span style="font-size: 12px; color: #62686c">' + esc(q.sub) + '</span></span></button></li>';
      }
      h += '</ul></section>';
    }
    h += '</header>';
    if (!s.projects.length) {
      h += '<div style="margin-top: 32px; display: flex; flex-direction: column; align-items: flex-start; gap: 18px; padding: 32px; border: 1px solid #e1e3e6; border-radius: 22px; background: #fafbfc"><h2 style="margin: 0; font-size: 26px; font-weight: 500">暂无关注项目</h2><p style="margin: 0; color: #62686c">在左侧输入 Project ID 添加，然后点击「获取 MR」列出项目中的开放 MR。</p></div>';
      return h;
    }
    for (const p of s.projects) {
      const st = p.fetch.status;
      const ms = s.mrs.filter((m) => m.pid === p.id).map((m, i) => [m, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
      const staleGroup = st === 'failed';
      const pill = { failed: ['#fff0f1', '#ac3039', '获取失败' + (p.fetch.error ? ' · ' + p.fetch.error : '')], fetching: ['#eef0f2', '#3b3f42', '获取中'], never: ['#eef0f2', '#62686c', '尚未获取'] }[st];
      let right = '';
      if (st === 'updated') right = '获取于 ' + ymdhm(p.fetch.lastSuccessAt);
      if (st === 'failed') right = p.fetch.lastSuccessAt ? '显示 ' + mdhm(p.fetch.lastSuccessAt) + ' 的数据' : '尚无成功获取的数据';
      if (st === 'fetching') right = p.fetch.lastSuccessAt ? '获取中…' : '首次获取';
      h += '<section id="grp-' + p.id + '" style="margin: 32px 0 8px; scroll-margin-top: 20px"><div style="display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 16px; padding-bottom: 14px; border-bottom: 1px solid #e1e3e6">' +
        '<div style="display: flex; align-items: center; gap: 9px; min-width: 0">' + ico(IC.folder, '', 'color: #62686c') + '<h2 style="margin: 0; font-size: 17px; font-weight: 600" title="' + esc(p.path) + '">' + esc(p.short) + '</h2>' +
        (pill ? '<span class="pill" style="background: ' + pill[0] + '; color: ' + pill[1] + '">' + (st === 'fetching' ? '<span class="spin"></span>' : '<span class="dot"></span>') + esc(pill[2]) + '</span>' : '') + '</div>' +
        '<span style="display: inline-flex; align-items: center; gap: 4px; color: #62686c; font-size: 12px">' + esc(right) + (staleGroup && !s.fetch.active ? ' · <button type="button" class="tbtn" ' + data({ act: 'retry', pid: p.id }) + ' style="color: #0059b8; font-weight: 600">重新获取该项目</button>' : '') + '</span></div>';
      if (st === 'never') h += '<div style="margin-top: 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 22px 20px; border: 1px dashed #c6c9cc; border-radius: 16px; color: #62686c; font-size: 13px"><span style="flex: 1">尚未获取 MR</span><button type="button" class="btn btn-s" ' + attr({ disabled: s.fetch.active }) + ' ' + data({ act: 'retry', pid: p.id }) + '>获取该项目</button></div>';
      if (st === 'updated' && !ms.length) h += '<div style="margin-top: 14px; padding: 22px 20px; border: 1px dashed #c6c9cc; border-radius: 16px; color: #62686c; font-size: 13px">暂无开放的 MR</div>';
      if (st === 'fetching' && !ms.length) {
        const sk = '<div style="display: grid; gap: 12px; padding: 22px; border: 1px solid #e1e3e6; border-radius: 16px"><span style="width: 64px; height: 9px; border-radius: 4px; background: #edf0f2; animation: rxbreathe 2s ease-in-out infinite"></span><span style="width: 200px; max-width: 100%; height: 12px; border-radius: 4px; background: #edf0f2; animation: rxbreathe 2s ease-in-out infinite"></span><span style="width: 120px; height: 9px; border-radius: 4px; background: #edf0f2; animation: rxbreathe 2s ease-in-out infinite"></span></div>';
        h += '<div aria-hidden="true" class="cards">' + sk + sk + '</div>';
      }
      if (ms.length) h += '<div class="cards">' + ms.map((m) => card(m, staleGroup, nextKey)).join('') + '</div>';
      h += '</section>';
    }
    return h;
  }

  // ---- drawer ----
  function failureBlock(fl, iid) {
    if (!fl) return '';
    const done = fl.completedSteps || 0;
    const progress = (done ? '已完成步骤 1' + (done > 1 ? '–' + done : '') + '；' : '') + '步骤 ' + fl.step + ' 中断' + (fl.step < 7 ? '；步骤 ' + (fl.step + 1) + (fl.step + 1 < 7 ? '–7' : '') + ' 未执行' : '') + '；未生成可发布的意见' + (fl.findingsSubmitted ? '（会话中已提交的 ' + fl.findingsSubmitted + ' 条意见未保存）' : '') + '。';
    let h = '<section aria-label="失败说明" style="border: 1px solid #edc4c7; background: #fff8f8; border-radius: 15px; padding: 18px 20px; font-size: 13px">' +
      '<div style="display: flex; gap: 8px; color: #ac3039">' + ico(IC.warn, '', 'margin-top: 3px') + '<strong style="font-weight: 600; font-size: 14px">检视失败 · ' + esc(fl.title) + '</strong></div>' +
      '<dl style="margin: 14px 0 0; display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px 12px">' +
      '<dt style="color: #62686c">影响</dt><dd style="margin: 0">!' + esc(iid) + ' 本次检视未完成，不会生成报告；已有的报告和处理记录不受影响。</dd>' +
      '<dt style="color: #62686c">原因</dt><dd style="margin: 0">' + esc(fl.reason) + '</dd>' +
      '<dt style="color: #62686c">进度</dt><dd style="margin: 0">' + esc(progress) + '</dd>' +
      '<dt style="color: #62686c">队列</dt><dd style="margin: 0"><b style="font-weight: 600">' + (fl.stopsQueue ? '已停止，其余排队中的检视已转为「已停止」' : '继续执行其余检视') + '</b></dd>' +
      (fl.next ? '<dt style="color: #62686c">下一步</dt><dd style="margin: 0">' + esc(fl.next) + '</dd>' : '') + '</dl>';
    if (fl.unread && fl.unread.length) h += '<details style="margin-top: 12px; font-size: 12px"><summary style="display: flex; align-items: center; gap: 6px; color: #3b3f42">未读的差异文件（' + fl.unread.length + '）' + ico(IC.chevRight, 'ico-s chev') + '</summary><ul class="mono" style="margin: 6px 0 0; padding-left: 18px">' + fl.unread.map((u) => '<li>' + esc(u) + '</li>').join('') + '</ul></details>';
    if (fl.detail || fl.code) h += '<details style="margin-top: 14px; border-top: 1px solid #edc4c7; padding-top: 10px; color: #62686c; font-size: 12px"><summary style="display: flex; align-items: center; gap: 6px">技术详情' + ico(IC.chevRight, 'ico-s chev') + '</summary><p class="mono" style="margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere">' + esc(fl.code + (fl.detail ? '\n' + fl.detail : '')) + '</p></details>';
    return h;
  }

  function findingBody(f, textColor) {
    let h = '<div class="md" style="padding: 18px 22px 20px; color: ' + textColor + '"><p>' + plain(f.summary) + '</p>';
    h += '<p><span class="lbl">问题位置</span><code>' + esc(f.loc) + '</code>' + (f.rule ? '<span style="margin-left: 8px; font-size: 12px; color: #59636e; background: #f0f2f4; padding: 2px 8px; border-radius: 6px">规则 · ' + esc(f.rule) + '</span>' : '') +
      (f.tags && f.tags.length ? f.tags.map((t) => '<span style="margin-left: 6px; font-size: 12px; color: #59636e">#' + esc(t) + '</span>').join('') : '') + '</p>';
    if (f.related_code) h += '<pre><code>' + hl(f.related_code.code) + '</code></pre>';
    h += '<h4>影响分析</h4><ul><li><span style="color: #59636e">直接后果：</span>' + plain(f.impact.consequence) + '</li><li><span style="color: #59636e">影响范围：</span>' + plain(f.impact.scope) + '</li><li><span style="color: #59636e">触发条件：</span>' + plain(f.impact.trigger) + '</li></ul>';
    h += '<h4>解决方案</h4>';
    f.solutions.forEach((s, i) => {
      h += '<p>' + (f.solutions.length > 1 ? (i + 1) + '. ' : '') + plain(s.description) + '</p>';
      if (s.code) h += '<pre><code>' + hl(s.code.code) + '</code></pre>';
    });
    if (f.prevention && f.prevention.length) h += '<h4>预防措施</h4><ul>' + f.prevention.map((p) => '<li>' + plain(p) + '</li>').join('') + '</ul>';
    return h + '</div>';
  }

  function stepsList(j) {
    let h = '<ol style="list-style: none; margin: 0; padding: 8px 18px 14px; border-top: 1px solid #dbe7f6">';
    STEPS.forEach((name, i) => {
      const n = i + 1; const done = n < j.step; const cur = n === j.step;
      const detail = cur ? '　' + stepDetail(j, true) : '';
      h += '<li style="display: flex; align-items: center; gap: 12px; padding: 8px 0; color: ' + (done || cur ? '#121212' : '#8c9195') + '">' +
        '<span style="display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: ' + (done ? '#18733f' : '#ffffff') + '; border: 1.5px solid ' + (done ? '#18733f' : cur ? '#3b3f42' : '#c6c9cc') + '; color: ' + (done ? '#ffffff' : '#3b3f42') + '; flex: 0 0 auto; box-sizing: border-box">' + (done ? ico(IC.check, 'ico-s') : cur ? '<span class="spin" style="width: 9px; height: 9px"></span>' : '') + '</span>' +
        '<span class="mono" style="width: 30px; font-size: 12px; color: #62686c">' + n + '/7</span>' +
        '<span style="flex: 1; min-width: 0; font-size: 14px; font-weight: ' + (cur ? 600 : 400) + '">' + esc(name) + '<span style="font-size: 12px; color: #62686c; font-weight: 400">' + esc(detail) + '</span></span>' +
        '<span class="mono" style="font-size: 12px; color: #62686c">' + (done ? stepTime(j.times[i]) : '') + '</span></li>';
    });
    return h + '</ol>';
  }

  function drawer() {
    if (!S.drawer) return '';
    const d = S.detail;
    const { pid, iid } = S.drawer;
    const m = mrOf(pid, iid);
    const job = jobOf(pid, iid);
    const title = (m && m.title) || (d && d.mr && d.mr.title) || '!' + iid;
    const pr = proj(pid);
    const closed = d ? !d.open : !m;
    let h = '<div class="rx-scrim' + (S.drawerClosing ? ' is-closing' : '') + (S.drawerNoAnim ? ' no-anim' : '') + '" data-key="scrim"><button type="button" aria-label="关闭详情" data-act="closeDrawer" style="position: absolute; inset: 0; border: 0; padding: 0; background: transparent; cursor: default"></button>' +
      '<section role="dialog" aria-label="MR 详情" class="rx-drawer" id="drawer" style="position: relative; flex: 0 1 780px; min-width: 0; width: 100%; background: #ffffff; border-left: 1px solid #e1e3e6; box-shadow: -12px 0 48px rgb(18 18 18 / 7%)">';
    h += '<header style="position: sticky; top: 0; z-index: 3; display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 22px clamp(18px, 4vw, 36px); background: #ffffff; border-bottom: 1px solid #e1e3e6"><div style="min-width: 0"><h2 style="margin: 0; font-size: 24px; line-height: 1.45; font-weight: 700; overflow-wrap: anywhere">' + esc(title) + '</h2>' +
      '<p style="margin: 8px 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: 13px; color: #62686c">' + esc((pr && pr.path) || (d && d.projectPath) || '') +
      '<button type="button" class="tbtn mono" ' + data({ act: 'openMrWeb', pid, iid }) + ' style="display: inline-flex; align-items: center; gap: 4px; font-weight: 500; color: #3b3f42; text-decoration: underline; text-decoration-color: #c6c9cc; text-underline-offset: 3px">!' + esc(iid) + ico(IC.ext, 'ico-s') + '</button>' +
      (m && m.sourceBranch ? '<span class="mono" style="font-size: 12px">' + esc(m.sourceBranch) + ' → ' + esc(m.targetBranch) + '</span>' : '') +
      (closed ? '<span class="pill" style="background: #eef0f2; color: #62686c">已不在开放列表</span>' : '') + '</p></div>' +
      '<button type="button" aria-label="关闭详情" class="btn btn-q" data-act="closeDrawer" style="width: 38px; min-height: 38px; padding: 0; background: #f5f7f8; flex: 0 0 auto">' + ico(IC.x) + '</button></header>';
    h += '<div style="padding: 22px clamp(18px, 4vw, 36px) 60px">';
    if (!d) return h + '<p style="color: #62686c">加载中…</p></div></section></div>';

    const reports = d.reports;
    const tabId = reports.some((r) => r.id === S.tab) ? S.tab : (reports[0] && reports[0].id);
    if (reports.length > 1) {
      h += '<div role="tablist" aria-label="历次报告" style="display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 3px; margin-bottom: 14px; border: 1px solid #e1e3e6; border-radius: 999px; background: #f5f7f8">';
      reports.forEach((r, i) => {
        const sel = r.id === tabId;
        const label = i === 0 ? '最新报告 · ' + hm(r.createdAt) : '历史 ' + (reports.length - i) + ' · 已归档 · ' + mdhm(r.createdAt);
        h += '<button type="button" role="tab" aria-selected="' + sel + '" ' + data({ act: 'tab', id: r.id }) + ' style="min-height: 32px; padding: 0 14px; border-radius: 999px; border: 1px solid ' + (sel ? '#e1e3e6' : 'transparent') + '; background: ' + (sel ? '#ffffff' : 'transparent') + '; font-size: 13px; font-weight: ' + (sel ? 600 : 400) + '; color: ' + (sel ? '#121212' : '#62686c') + '">' + esc(label) + '</button>';
      });
      h += '</div>';
    }
    const rep = reports.find((r) => r.id === tabId) || null;
    const busy = Boolean(job);
    const rerunDisabled = busy || closed;
    const k = { pid, iid };

    if (rep && !rep.latest) {
      h += '<div role="note" style="display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-radius: 13px; background: #f5f7f8; font-size: 13px; color: #62686c">' + ico(IC.clock) + '历史报告 · 只读 · ' + esc(ymdhm(rep.createdAt)) + '</div>';
      h += reportMeta(rep);
      if (rep.conclusion !== 'issues') h += conclusionBlock(rep, true, k);
      for (const f of rep.findings) {
        const sv = SEVC[f.severity]; const st = FST[f.state] || FST.dismissed;
        h += '<article data-key="af-' + rep.id + '-' + f.id + '" style="margin-top: 18px; border: 1px solid #e1e3e6; border-radius: 14px; background: #ffffff"><header style="display: flex; flex-wrap: nowrap; align-items: center; gap: 10px; min-height: 60px; box-sizing: border-box; padding: 10px 18px; border-radius: 13px 13px 0 0">' +
          '<span class="pill" style="background: ' + sv[1] + '; color: ' + sv[2] + '; font-size: 12px; padding: 2px 9px; font-weight: 600; border-radius: 6px; letter-spacing: 0.02em; border: 1px solid ' + sv[3] + '">' + sv[0] + '</span>' +
          '<h3 style="margin: 0; flex: 1 1 200px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; font-weight: 600; color: #62686c" title="' + esc(f.title) + '">' + esc(f.title) + '</h3>' +
          '<span class="pill" style="background: transparent; color: #8c9195; font-size: 13px; padding: 3px 4px"><span class="dot"></span>' + esc(st[0]) + '</span></header>' + findingBody(f, '#62686c') + '</article>';
      }
      h += excludedBlock(rep);
      return h + '</div></section></div>';
    }

    // Activity of a new review while a report exists.
    if (rep && job) {
      const q = queuePos(pid, iid);
      const queuedJ = job.status === 'queued';
      h += '<div role="status" style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 16px; margin-bottom: 14px; border: 1px solid #c9dcf3; border-radius: 13px; background: #f5f9ff; font-size: 13px">' +
        '<span class="pill" style="background: #eef0f2; color: ' + (queuedJ ? '#62686c' : '#3b3f42') + '">' + (queuedJ ? '' : '<span class="spin"></span>') + (queuedJ ? '新检视排队中' : job.status === 'stopping' ? '停止中' : '新检视进行中') + '</span>' +
        '<span style="flex: 1 1 260px; color: #3b3f42">' + esc(queuedJ ? '队列第 ' + q.pos + '/' + q.n + ' 位' : job.status === 'stopping' ? (job.stopNote || '正在停止') : (job.step ? '步骤 ' + job.step + '/7 ' + STEPS[job.step - 1] + ' · ' + stepDetail(job, true) : '准备中')) + '　当前显示的仍是最新报告</span>' +
        '<button type="button" class="btn btn-s" style="min-height: 34px" ' + attr({ disabled: job.status === 'stopping' }) + ' ' + data(Object.assign({ act: queuedJ ? 'cancel' : 'stop' }, k)) + '>' + (queuedJ ? '取消排队' : '停止') + '</button></div>';
    } else if (rep && d.last && d.last.status !== 'completed' && d.last.endedAt > rep.createdAt) {
      const fl = d.last.failure;
      h += '<div role="note" style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 16px; margin-bottom: 14px; border: 1px solid ' + (fl ? '#edc4c7' : '#e1e3e6') + '; border-radius: 13px; background: ' + (fl ? '#fff8f8' : '#f5f7f8') + '; font-size: 13px">' +
        '<span style="flex: 1 1 300px">' + (fl ? '<b style="font-weight: 600; color: #ac3039">最近一次检视失败</b>　' + esc(fl.title + ' · ' + fl.reason) : '<b style="font-weight: 600">最近一次检视已停止</b>　' + esc(d.last.stopReason || '')) + '<span style="color: #62686c">　下面仍是最新报告</span></span>' +
        (fl ? '<button type="button" class="btn btn-q" style="min-height: 34px" data-act="goLogs">查看会话日志</button>' : '') + '</div>';
    }

    if (!rep) {
      if (job && job.status === 'queued') {
        const q = queuePos(pid, iid);
        h += '<div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding: 22px 24px; border: 1px solid #e1e3e6; border-radius: 16px"><span class="pill" style="background: #eef0f2; color: #62686c"><span class="dot"></span>排队中</span><span style="flex: 1 1 260px">队列第 <b class="mono">' + q.pos + '/' + q.n + '</b> 位</span><button type="button" class="btn btn-s" ' + data(Object.assign({ act: 'cancel' }, k)) + '>' + ico(IC.x) + '取消排队</button></div>';
      } else if (job) {
        const stopping = job.status === 'stopping';
        h += '<section aria-label="检视进度" style="border: 1px solid #e1e3e6; border-radius: 15px; overflow: hidden"><div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 14px 18px; background: #f5f7f8">' +
          '<span class="pill" style="background: #eef0f2; color: ' + (stopping ? '#62686c' : '#3b3f42') + '"><span class="spin"></span>' + (stopping ? '停止中' : '检视中') + '</span>' +
          '<span style="flex: 1 1 260px; font-size: 14px">' + esc(stopping ? (job.stopNote || '正在停止') : '已运行 ' + dur(now() - (job.startedAt || now()))) + '</span>' +
          '<button type="button" class="btn btn-s" ' + attr({ disabled: stopping }) + ' ' + data(Object.assign({ act: 'stop' }, k)) + '>' + ico(IC.stop) + '停止</button></div>' + stepsList(job) + '</section>';
      } else if (d.last && d.last.status === 'failed') {
        h += failureBlock(d.last.failure, iid) + '<div style="margin-top: 16px; display: flex; flex-wrap: wrap; gap: 8px"><button type="button" class="btn btn-p" ' + attr({ disabled: rerunDisabled }) + ' ' + data(Object.assign({ act: 'start' }, k)) + '>' + ico(IC.refresh) + '重新检视</button><button type="button" class="btn btn-q" data-act="goLogs">查看会话日志</button></div></section>';
      } else if (d.last && d.last.status === 'stopped') {
        h += '<div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding: 22px 24px; border: 1px solid #e1e3e6; border-radius: 16px"><span class="pill" style="background: #eef0f2; color: #62686c"><span class="dot"></span>已停止</span><span style="flex: 1 1 260px">' + esc(d.last.stopReason || '已停止') + '</span><button type="button" class="btn btn-p" ' + attr({ disabled: rerunDisabled }) + ' ' + data(Object.assign({ act: 'start' }, k)) + '>' + ico(IC.refresh) + '重新检视</button></div>';
      } else {
        h += '<div style="display: flex; flex-direction: column; align-items: flex-start; gap: 16px; padding: 32px; border: 1px solid #e1e3e6; border-radius: 18px; background: #fafbfc"><span style="display: grid; place-items: center; width: 52px; height: 52px; border: 1px solid #e1e3e6; border-radius: 15px; background: #ffffff">' + ico(IC.doc, '', 'width: 24px; height: 24px') + '</span><h3 style="margin: 0; font-size: 22px; font-weight: 500">暂无检视记录</h3>' +
          '<button type="button" class="btn btn-p" ' + attr({ disabled: closed }) + ' ' + data(Object.assign({ act: 'start' }, k)) + '>' + ico(IC.play) + '开始检视</button></div>';
      }
      return h + '</div></section></div>';
    }

    if (d.stale) {
      h += '<div role="note" style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 26px; padding: 14px 18px; border: 1px solid #f0d9c2; border-radius: 12px; background: #fff7ee"><span style="flex: 1 1 360px; font-size: 14px"><b style="font-weight: 600; color: #9a4a08">报告基于旧版本</b><span style="color: #3b3f42">　MR 已于 ' + esc(mdhm(m ? m.updatedAt : '')) + ' 更新；仍可发送意见，建议核对代码后再发。</span></span>' +
        '<button type="button" class="btn btn-s" ' + attr({ disabled: rerunDisabled }) + ' ' + data(Object.assign({ act: 'start' }, k)) + '>重新检视</button></div>';
    }
    if (rep.conclusion !== 'issues') {
      h += conclusionBlock(rep, false, k, rerunDisabled) + reportMeta(rep) + excludedBlock(rep);
      return h + '</div></section></div>';
    }

    // Issues report (latest).
    const states = rep.findings.map((f) => f.state);
    const pendingList = rep.findings.filter((f) => f.state === 'pending');
    const verifyN = states.filter((s) => s === 'failed' || s === 'unknown').length;
    const lock = Boolean(S.srv.sending) || closed;
    h += '<div style="position: sticky; top: var(--dh, 108px); z-index: 2; box-shadow: 0 -12px 0 #ffffff; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-top: -12px; padding: 12px 0; background: #ffffff; border-bottom: 1px solid #e1e3e6">' +
      '<h3 style="margin: 0; font-size: 24px; font-weight: 600">检视意见</h3><span style="font-size: 13px; color: #62686c">' + (pendingList.length ? '<b style="color: #0059b8; font-weight: 600">' + pendingList.length + ' 条待处理</b>' : '已处理完') + (verifyN ? ' · <b style="color: #9a4a08; font-weight: 600">' + verifyN + ' 条需到 CodeHub 核对</b>' : '') + ' · 共 ' + rep.findings.length + ' 条</span>' +
      '<span style="margin-left: auto; display: flex; flex-wrap: wrap; gap: 4px">' +
      (pendingList.length ? '<button type="button" class="btn btn-q" style="min-height: 34px; color: #0059b8" data-act="goNext">下一条待处理 →</button><button type="button" class="btn btn-q" style="min-height: 34px; font-weight: 400" ' + attr({ disabled: closed }) + ' data-act="askBulk">其余全部不发送</button>' : '') +
      (!d.stale ? '<button type="button" class="btn btn-q" style="min-height: 34px; font-weight: 400" ' + attr({ disabled: rerunDisabled }) + ' ' + data(Object.assign({ act: 'start' }, k)) + '>重新检视</button>' : '') + '</span></div>';
    if (S.confirmBulk && pendingList.length) {
      h += '<div role="alertdialog" aria-label="确认其余全部不发送" style="margin-top: 14px; padding: 16px 18px; border: 1px solid #c6c9cc; border-radius: 12px; background: #f5f7f8; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px"><span style="flex: 1 1 300px; font-size: 14px"><b style="font-weight: 600">将 ' + pendingList.length + ' 条待处理意见标为「不发送」？</b><span style="color: #62686c">　之后可以逐条撤销。</span></span>' +
        '<button type="button" class="btn btn-s" data-act="cancelBulk">取消</button><button type="button" class="btn btn-s" style="border-color: #121212" data-act="doBulk">全部不发送</button></div>';
    }
    if (closed) h += '<div role="note" style="margin-top: 14px; padding: 12px 16px; border-radius: 13px; background: #f5f7f8; font-size: 13px; color: #62686c">该 MR 已不在最近一次获取的开放 MR 列表中，意见只读。</div>';
    // Group order is frozen while the drawer is open so cards do not jump on each click.
    const gk = (f) => { const st = (S.groupOrder && S.groupOrder[rep.id + f.id]) || f.state; return (st === 'pending' || st === 'sending') ? 0 : (st === 'unknown' || st === 'failed') ? 1 : 2; };
    const sorted = rep.findings.map((f, i) => [f, i]).sort((a, b) => gk(a[0]) - gk(b[0]) || a[1] - b[1]).map((x) => x[0]);
    const n = [0, 0, 0]; sorted.forEach((f) => { n[gk(f)]++; });
    const names = ['待处理', '需核对', '已处理'];
    sorted.forEach((f, i) => {
      const g = gk(f);
      if (g !== 0 && (i === 0 || gk(sorted[i - 1]) !== g)) {
        h += '<div data-key="g-' + g + '" style="display: flex; align-items: center; gap: 10px; margin: ' + (i === 0 ? '28px' : '52px') + ' 0 -2px"><span style="width: 8px; height: 8px; border-radius: 50%; background: ' + ['#0059b8', '#b7791f', '#c6c9cc'][g] + '"></span><span style="font-size: 21px; font-weight: 600">' + names[g] + '<span style="color: #8c9195; font-weight: 400"> · ' + n[g] + '</span></span><span style="flex: 1; height: 1px; background: #e1e3e6"></span></div>';
      }
      const st = f.state; const sv = SEVC[f.severity]; const lab = FST[st] || FST.pending;
      const active = ['pending', 'sending', 'unknown', 'failed'].includes(st);
      const textColor = active ? '#121212' : '#62686c';
      const fk = Object.assign({ rid: rep.id, fid: f.id }, k);
      let note = '';
      if (st === 'unknown') note = (f.reason || '发送结果未知') + (f.stateAt ? '（' + hm(f.stateAt) + '）' : '') + '，请到 CodeHub 核对';
      if (st === 'failed') note = (f.reason || '发布失败') + (f.stateAt ? '（' + hm(f.stateAt) + '）' : '');
      h += '<article id="f-' + f.id + '" tabindex="-1" style="margin-top: 18px; border: 1px solid ' + (st === 'unknown' || st === 'failed' ? '#ecd9bf' : '#e1e3e6') + '; border-radius: 14px; background: #ffffff; scroll-margin-top: calc(var(--dh, 108px) + 62px)">' +
        '<header style="position: sticky; top: calc(var(--dh, 108px) + 58px); z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; min-height: 60px; box-sizing: border-box; padding: 10px 18px; background: ' + (g === 2 ? '#ffffff' : g === 1 ? '#fdf6ec' : '#f5f7fa') + '; border-bottom: 1px solid ' + (active ? '#e1e3e6' : '#ffffff') + '; border-radius: 13px 13px 0 0">' +
        '<span class="pill" style="flex: 0 0 auto; background: ' + sv[1] + '; color: ' + sv[2] + '; font-size: 12px; padding: 2px 9px; font-weight: 600; border-radius: 6px; letter-spacing: 0.02em; border: 1px solid ' + sv[3] + '">' + sv[0] + '</span>' +
        '<h3 style="margin: 0; flex: 1 1 200px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; font-weight: 600; color: ' + textColor + '" title="' + esc(f.title) + '">' + esc(f.title) + '</h3>' +
        (st !== 'pending' ? '<span class="pill" style="flex: 0 0 auto; background: transparent; color: ' + (active ? lab[1] : '#8c9195') + '; font-size: 13px; padding: 3px 4px">' + (st === 'sending' ? '<span class="spin"></span>' : '<span class="dot"></span>') + esc(lab[0]) + '</span>' : '') +
        '<span style="margin-left: auto; flex: 0 0 auto; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px">';
      if (st === 'pending') h += '<button type="button" class="btn btn-s" ' + attr({ disabled: lock }) + ' ' + data(Object.assign({ act: 'dismiss' }, fk)) + '>不发送</button><button type="button" class="btn btn-p" ' + attr({ disabled: lock }) + ' ' + data(Object.assign({ act: 'send' }, fk)) + '>' + ico(IC.send) + '发送到 CodeHub</button>';
      if (st === 'sending') h += '<button type="button" class="btn btn-s" disabled><span class="spin"></span>发送中…</button>';
      if (st === 'dismissed' && !closed) h += '<button type="button" class="btn btn-q" ' + data(Object.assign({ act: 'undo' }, fk)) + '>撤销</button>';
      if (st === 'unknown' && !closed) h += '<button type="button" class="btn btn-s" ' + data(Object.assign({ act: 'markUnsent' }, fk)) + '>确认未发布</button><button type="button" class="btn btn-s" ' + data(Object.assign({ act: 'markSent' }, fk)) + '>已在 CodeHub 看到</button>';
      if (st === 'failed') h += '<button type="button" class="btn btn-s" ' + attr({ disabled: lock }) + ' ' + data(Object.assign({ act: 'send' }, fk)) + '>重新发送</button>';
      if (st === 'published' || st === 'manual') h += '<button type="button" class="btn btn-q" ' + data(Object.assign({ act: 'draft' }, fk)) + '>沉淀为规则草稿</button>';
      h += '</span>';
      if (note) h += '<p style="flex: 1 0 100%; margin: 0; font-size: 13px; color: ' + (st === 'failed' ? '#ac3039' : '#7a4a10') + '">' + esc(note) + '</p>';
      h += '</header>' + findingBody(f, textColor) + '</article>';
    });
    h += reportMeta(rep) + excludedBlock(rep);
    return h + '</div></section></div>';
  }

  function conclusionBlock(rep, readonly, k, rerunDisabled) {
    const pass = rep.conclusion === 'pass';
    return '<div style="display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; margin-top: ' + (readonly ? '18px' : '0') + '; padding: 22px 24px; border: 1px solid ' + (pass ? '#c7e5d2' : '#c6c9cc') + '; border-radius: 16px">' +
      '<span style="display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: ' + (pass ? '#e3f9ec' : '#eef0f2') + '; color: ' + (pass ? '#18733f' : '#62686c') + '; flex: 0 0 auto">' + ico(pass ? IC.check : IC.minus) + '</span>' +
      '<div style="flex: 1 1 260px"><h3 style="margin: 0; font-size: 16px; font-weight: 600">' + (pass ? '未发现问题' : '无可检视的变更') + '</h3><p style="margin: 4px 0 0; font-size: 13px; color: #62686c">' + (pass ? '全部 ' + rep.changedFiles + ' 个变更文件已检视，没有意见。' : '排除锁文件、图片等文件后没有可交给 AI 的内容，未调用 OpenCode。') + '</p>' +
      '<p style="margin: 8px 0 0; font-size: 12px; color: #62686c"><span class="mono">' + esc((rep.sourceSha || '').slice(0, 7)) + '</span> · 耗时 <span class="mono">' + dur(rep.durationMs) + '</span></p></div>' +
      (readonly ? '' : '<button type="button" class="btn btn-q" ' + attr({ disabled: rerunDisabled }) + ' ' + data(Object.assign({ act: 'start' }, k)) + '>' + ico(IC.refresh) + '重新检视</button>') + '</div>';
  }

  function reportMeta(rep) {
    const rows = [
      ['报告时间', ymdhm(rep.createdAt)],
      ['代码版本', (rep.sourceSha || '').slice(0, 10) + ' · MR 更新于 ' + mdhm(rep.mrUpdatedAt)],
      ['模型', rep.model || '未调用 OpenCode'],
      ['耗时', dur(rep.durationMs)],
      ['使用的规则', rep.rules.length ? rep.rules.join('、') : '无'],
    ];
    if (rep.skippedRules.length) rows.push(['跳过的规则', rep.skippedRules.map((r) => r.name + '（格式错误：' + r.reason + '）').join('；')]);
    return '<details data-key="meta-' + rep.id + '" style="margin-top: 28px; font-size: 13px; color: #62686c"><summary style="display: flex; align-items: center; gap: 6px; font-weight: 600; color: #3b3f42">报告信息' + ico(IC.chevRight, 'ico-s chev') + '</summary>' +
      '<dl style="margin: 10px 0 0; display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 6px 12px">' + rows.map((r) => '<dt>' + esc(r[0]) + '</dt><dd style="margin: 0; color: #121212; overflow-wrap: anywhere">' + esc(r[1]) + '</dd>').join('') + '</dl></details>';
  }

  function excludedBlock(rep) {
    if (!rep.excluded.length) return '';
    return '<section style="margin-top: 24px"><div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px"><h4 style="margin: 0; font-size: 14px; font-weight: 600; color: #3b3f42">排除的文件</h4><span class="pill" style="background: #eef0f2; color: #62686c; padding: 0 8px">' + rep.excluded.length + '</span></div>' +
      '<ul style="list-style: none; margin: 0; padding: 0; border: 1px solid #e1e3e6; border-radius: 10px; overflow: hidden">' +
      rep.excluded.map((ex, i) => '<li style="display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-top: ' + (i ? '1px solid #eceef0' : '0') + '; font-size: 13px">' + ico(IC.file, '', 'color: #8c9195') + '<span class="mono" style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" title="' + esc(ex.path) + '">' + esc(ex.path) + '</span><span style="color: #62686c; font-size: 12px">' + esc(ex.reason) + '</span></li>').join('') + '</ul></section>';
  }

  // ---- remove dialog ----
  function dialog() {
    if (!S.dialog) return '';
    const p = proj(S.dialog);
    if (!p) return '';
    const tasks = S.srv.queue.filter((j) => j.pid === p.id);
    const sendingHere = S.srv.sending && S.srv.sending.pid === p.id;
    let h = '<div style="position: fixed; inset: 0; z-index: 8; display: flex; justify-content: center; align-items: flex-start; padding: 120px 20px; background: rgba(18,18,18,0.2)"><section role="dialog" aria-modal="true" aria-label="移除项目" style="width: min(460px, 100%); box-sizing: border-box; background: #ffffff; border-radius: 18px; padding: 22px 24px; box-shadow: 0 16px 48px rgba(18,18,18,0.22)">' +
      '<h3 style="margin: 0; font-size: 17px; font-weight: 600">移除 ' + esc(p.short) + '？</h3><p style="margin: 6px 0 12px; font-size: 13px; color: #62686c">历史报告和处理记录会保留，重新添加后可再次看到；代码缓存会删除。</p>';
    if (tasks.length) {
      h += '<div style="font-size: 13px; font-weight: 500; margin-bottom: 6px">受影响的检视</div><ul style="margin: 0 0 18px; padding: 0; list-style: none; font-size: 13px; border: 1px solid #e1e3e6; border-radius: 12px">' +
        tasks.map((t) => '<li style="display: flex; justify-content: space-between; gap: 10px; padding: 9px 12px; border-bottom: 1px solid #eceef0"><span><span class="mono" style="color: #0059b8">!' + esc(t.iid) + '</span> ' + esc(t.title) + '</span><span style="color: #62686c; white-space: nowrap">' + (t.status === 'queued' ? '排队中 → 移出队列' : '检视中 → 停止') + '</span></li>').join('') + '</ul>';
    } else h += '<p style="margin: 0 0 18px; font-size: 13px; color: #62686c">该项目没有排队或进行中的检视。</p>';
    if (sendingHere) h += '<p style="margin: -8px 0 16px; font-size: 13px; color: #ac3039">该项目有评论正在发送，发送结束后才能移除。</p>';
    h += '<div style="display: flex; justify-content: flex-end; gap: 8px"><button type="button" class="btn btn-s" data-act="cancelDialog">取消</button><button type="button" class="btn btn-d" ' + attr({ disabled: sendingHere || p.removing }) + ' data-act="confirmRemove">' + (p.removing ? '<span class="spin"></span>正在移除…' : tasks.length ? '停止任务并移除' : '移除') + '</button></div></section></div>';
    return h;
  }

  // ---- rules ----
  function viewRules() {
    let h = '<header style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px 24px"><div><h1 style="margin: 0; font-size: 32px; line-height: 1.4; font-weight: 600">规则配置</h1><p style="margin: 2px 0 0; font-size: 13px; color: #62686c">检视时使用「全局已启用规则 + 该项目已启用规则」中适用文件与本次变更匹配的规则。规则文件也可以直接用编辑器修改，刷新后生效。</p></div>' +
      '<div style="display: flex; flex-wrap: wrap; gap: 8px"><button type="button" class="btn btn-q" data-act="openRulesDir">打开规则目录</button><button type="button" class="btn btn-q" data-act="reloadRules">' + ico(IC.refresh) + '刷新</button><button type="button" class="btn btn-s" data-act="newRule">' + ico(IC.plus) + '新建规则</button></div></header>';
    if (!S.rules) return h + '<p style="color: #62686c; margin-top: 24px">加载中…</p>';
    const scopes = [['global', '全局']].concat(S.srv.projects.map((p) => [p.id, p.short]));
    const scopeLabel = (v) => { const sc = scopes.find((x) => x[0] === v); return sc ? sc[1] : '项目 ' + v; };
    const picker = (key, cur, opts, act, locked) => {
      const q = S.scopeQ.trim().toLowerCase();
      const shown = opts.filter((o) => !q || o.label.toLowerCase().includes(q));
      const open = S.scopeMenu === key;
      let x = '<div style="position: relative"><button type="button" ' + (key === 'filter' ? 'id="rule-scope-filter" ' : 'id="rule-scope" ') + 'class="field" aria-haspopup="listbox" aria-expanded="' + open + '" ' + attr({ disabled: locked }) + ' ' + data({ act: 'scopeMenu', key }) + ' style="display: flex; align-items: center; justify-content: space-between; gap: 10px; text-align: left; font-size: 14px; cursor: pointer"><span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">' + esc((opts.find((o) => o.v === cur) || { label: scopeLabel(cur) }).label) + '</span>' + ico(IC.chevDown, 'ico-s', 'color: #62686c; flex: 0 0 auto') + '</button>';
      if (open) {
        x += '<div style="position: absolute; top: calc(100% + 6px); left: 0; z-index: 8; width: 100%; min-width: 280px; box-sizing: border-box; padding: 8px; background: #ffffff; border: 1px solid #e1e3e6; border-radius: 12px; box-shadow: 0 10px 32px rgba(18,18,18,0.14)"><input class="field" placeholder="搜索项目" aria-label="搜索项目" data-input="scopeQ" ' + attr({ value: S.scopeQ }) + ' style="min-height: 34px"><ul role="listbox" style="list-style: none; margin: 6px 0 0; padding: 0; max-height: 264px; overflow-y: auto">' +
          shown.map((o) => '<li><button type="button" role="option" aria-selected="' + (o.v === cur) + '" class="tbtn rowh" ' + data({ act, v: o.v }) + ' style="width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; font-size: 14px; background: ' + (o.v === cur ? '#f0f2f4' : 'transparent') + '; font-weight: ' + (o.v === cur ? 600 : 400) + '"><span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">' + esc(o.label) + '</span><span style="font-size: 12px; color: #8c9195">' + esc(o.hint || '') + '</span></button></li>').join('') +
          (shown.length ? '' : '<li style="padding: 10px; font-size: 13px; color: #8c9195">没有匹配的项目</li>') + '</ul></div>';
      }
      return x + '</div>';
    };
    h += '<div style="margin: 24px 0 16px; display: flex; align-items: center; gap: 10px"><label for="rule-scope-filter" style="font-size: 13px; color: #62686c">范围</label><div style="width: 300px; max-width: 100%">' +
      picker('filter', S.ruleScope, scopes.map((sc) => ({ v: sc[0], label: sc[1], hint: S.rules.filter((r) => r.scope === sc[0]).length + ' 条规则' })), 'pickScope') + '</div></div>';
    const drafts = S.rules.filter((r) => r.draft && !r.error);
    if (drafts.length) {
      h += '<div role="note" style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; padding: 12px 16px; margin-bottom: 18px; border: 1px solid #c9dcf3; background: #f5f9ff; border-radius: 13px; font-size: 13px"><span style="flex: 1 1 320px"><b style="font-weight: 600">' + drafts.length + ' 份规则草稿待确认</b><span style="color: #62686c">　' + esc(drafts[0].source || drafts[0].name) + '</span></span><button type="button" class="btn btn-s" style="min-height: 34px" ' + data({ act: 'selectRule', id: drafts[0].id, scope: drafts[0].scope }) + '>编辑草稿</button></div>';
    }
    const rows = S.rules.filter((r) => r.scope === S.ruleScope);
    h += '<div style="display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start"><div style="flex: 999 1 560px; min-width: 0; overflow-x: auto; border: 1px solid #e1e3e6; border-radius: 15px"><div role="table" aria-label="规则列表" style="min-width: 620px; font-size: 13px">' +
      '<div role="row" style="display: grid; grid-template-columns: 64px minmax(0, 1.3fr) minmax(0, 1fr) 190px 130px; gap: 0 12px; padding: 11px 14px; background: #f5f7f8; color: #62686c"><span role="columnheader">启用</span><span role="columnheader">规则</span><span role="columnheader">适用文件</span><span role="columnheader" style="text-align: right">近 30 天 命中 / 发送 / 不发送</span><span role="columnheader">采纳率</span></div>';
    for (const r of rows) {
      const st = r.stats; const tot = st.sent + st.dismissed; const rate = tot ? Math.round(st.sent * 100 / tot) : null;
      const sel = r.id === S.ruleSel;
      h += '<div role="row" data-key="r-' + esc(r.id) + '" style="display: grid; grid-template-columns: 64px minmax(0, 1.3fr) minmax(0, 1fr) 190px 130px; gap: 0 12px; align-items: center; padding: 10px 14px; border-top: 1px solid #e1e3e6; background: ' + (sel ? '#f5f9ff' : '#ffffff') + '; color: ' + (r.enabled ? '#121212' : '#62686c') + '">' +
        '<span role="cell"><button type="button" role="switch" aria-checked="' + r.enabled + '" aria-label="启用 ' + esc(r.name) + '" ' + attr({ disabled: Boolean(r.error) }) + ' ' + data({ act: 'toggleRule', id: r.id }) + ' style="position: relative; width: 36px; height: 22px; border-radius: 999px; border: 0; padding: 0; background: ' + (r.enabled ? '#121212' : '#c6c9cc') + '"><span style="position: absolute; top: 3px; left: ' + (r.enabled ? '17px' : '3px') + '; width: 16px; height: 16px; border-radius: 50%; background: #ffffff; box-shadow: 0 1px 2px rgba(0,0,0,0.2)"></span></button></span>' +
        '<span role="cell" style="min-width: 0"><button type="button" class="tbtn" ' + data({ act: 'selectRule', id: r.id }) + ' style="font-weight: 600">' + esc(r.name) + '</button>' +
        (r.draft ? ' <span class="pill" style="background: #eaf3ff; color: #0059b8; padding: 0 7px; font-size: 11px">草稿</span>' : '') + (r.builtin ? ' <span class="pill" style="background: #eef0f2; color: #62686c; padding: 0 7px; font-size: 11px">内置</span>' : '') +
        (r.error ? '<span style="display: block; font-size: 12px; color: #ac3039">格式错误：' + esc(r.error) + '</span>' : '') + '</span>' +
        '<span role="cell" class="mono" style="font-size: 12px; color: #62686c; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" title="' + esc(r.files || '全部') + '">' + esc(r.files || '全部') + '</span>' +
        '<span role="cell" class="mono" style="text-align: right">' + (st.hits || r.enabled ? st.hits + ' / ' + st.sent + ' / ' + st.dismissed : '—') + '</span>' +
        '<span role="cell" style="display: flex; align-items: center; gap: 8px"><span style="flex: 0 0 70px; height: 5px; border-radius: 3px; background: #e1e3e6; overflow: hidden"><span style="display: block; width: ' + (rate || 0) + '%; height: 5px; background: ' + (rate === null ? '#e1e3e6' : rate < 30 ? '#9a4a08' : rate < 60 ? '#8c9195' : '#18733f') + '"></span></span><span class="mono" style="color: ' + (rate !== null && rate < 30 ? '#9a4a08' : '#121212') + '">' + (rate === null ? '—' : rate + '%') + '</span></span></div>';
    }
    h += '</div>' + (rows.length ? '' : '<p style="margin: 0; padding: 20px; color: #62686c; font-size: 13px; border-top: 1px solid #e1e3e6">该范围下还没有规则。</p>') + '</div>';
    const sel = S.rules.find((r) => r.id === S.ruleSel && r.scope === S.ruleScope);
    if (sel) {
      const ed = S.edit && S.edit.id === sel.id ? S.edit : { id: sel.id, name: sel.name, files: sel.files || '', body: sel.body };
      const pill = sel.error ? ['格式错误', '#fff0f1', '#ac3039'] : sel.draft ? ['草稿 · 未启用', '#eaf3ff', '#0059b8'] : sel.enabled ? ['已启用', '#e3f9ec', '#18733f'] : ['已停用', '#eef0f2', '#62686c'];
      h += '<section aria-label="编辑规则" style="flex: 1 1 340px; min-width: 0; border: 1px solid #e1e3e6; border-radius: 16px; overflow: hidden"><header style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 14px 18px; background: #f5f7fa; border-bottom: 1px solid #e1e3e6">' +
        '<h2 style="margin: 0; font-size: 16px; font-weight: 600">' + esc(ed.name || '未命名规则') + '</h2><span class="pill" style="background: ' + pill[1] + '; color: ' + pill[2] + '"><span class="dot"></span>' + pill[0] + '</span>' +
        '<span style="margin-left: auto; display: flex; gap: 2px"><button type="button" class="btn btn-q" style="min-height: 34px" ' + attr({ disabled: Boolean(sel.error) }) + ' data-act="copyRule">复制</button><button type="button" class="btn btn-q" style="min-height: 34px" ' + attr({ disabled: sel.builtin, title: sel.builtin ? '内置规则不能删除，可以停用' : false }) + ' data-act="deleteRule">删除</button></span></header>';
      h += '<div style="padding: 16px 18px; display: flex; flex-direction: column; gap: 14px">';
      if (sel.error) h += '<p style="margin: 0; font-size: 13px; color: #ac3039">这条规则格式错误（' + esc(sel.error) + '），检视时会跳过并在报告中注明。请直接编辑规则文件修正。</p>';
      else {
        h += '<div><label for="rule-scope" style="display: block; font-size: 12px; color: #62686c; margin-bottom: 4px">关联项目</label>' + picker('editor', sel.scope, scopes.map((sc) => ({ v: sc[0], label: sc[0] === 'global' ? '全局 · 所有项目' : sc[1] })), 'pickRuleScope', sel.builtin) + (sel.builtin ? '<span style="display: block; margin-top: 6px; font-size: 12px; color: #8c9195">内置规则固定为全局</span>' : '') + '</div>' +
          '<div><label for="rule-name" style="display: block; font-size: 12px; color: #62686c; margin-bottom: 4px">名称</label><input id="rule-name" class="field" data-input="ruleName" ' + attr({ value: ed.name }) + '></div>' +
          '<div><label for="rule-files" style="display: block; font-size: 12px; color: #62686c; margin-bottom: 4px">适用文件（逗号分隔，留空表示全部）</label><input id="rule-files" class="field mono" placeholder="*.java, src/db/**" data-input="ruleFiles" ' + attr({ value: ed.files }) + '></div>' +
          '<div><label for="rule-body" style="display: block; font-size: 12px; color: #62686c; margin-bottom: 4px">内容 · Markdown（检查要点、正例与反例）</label><textarea id="rule-body" class="field mono" rows="14" data-input="ruleBody" style="font-size: 12px; line-height: 1.8; resize: vertical">' + esc(ed.body) + '</textarea></div>';
      }
      h += '<div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap"><span style="font-size: 12px; color: #62686c"><span class="mono">rules/' + esc(sel.file) + '</span></span>' +
        (sel.error ? '' : '<span style="display: flex; gap: 8px"><button type="button" class="btn btn-q" data-act="revertRule">还原</button><button type="button" class="btn btn-p" data-act="saveRule">' + (sel.draft ? '确认并启用' : '保存') + '</button></span>') + '</div></div></section>';
    }
    return h + '</div>';
  }

  // ---- logs ----
  function viewLogs() {
    const lv = { INFO: ['#eef0f2', '#59636e', '#ffffff', 'transparent'], WARN: ['#fff3e8', '#9a4a08', '#fffcf8', '#e0a96b'], ERROR: ['#fbdde0', '#ac3039', '#fff0f1', '#ac3039'] };
    const list = S.logs.filter((l) => !S.logErrorsOnly || l.lvl !== 'INFO');
    let h = '<header style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px 24px"><div><h1 style="margin: 0; font-size: 32px; line-height: 1.4; font-weight: 600">会话日志</h1><p style="margin: 2px 0 0; font-size: 13px; color: #62686c">本次启动以来的诊断日志，已去除凭据。完整日志按天保存，保留 30 天。</p></div>' +
      '<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap"><span class="mono" style="font-size: 12px; color: #62686c; overflow-wrap: anywhere">' + esc(S.logPath || S.srv.logPath) + '</span><button type="button" class="btn btn-s" data-act="copyLogPath">复制路径</button>' +
      '<button type="button" class="btn ' + (S.logErrorsOnly ? 'btn-p' : 'btn-s') + '" aria-pressed="' + S.logErrorsOnly + '" data-act="logErrors">只看警告和错误</button></div></header>';
    h += '<div style="margin-top: 24px; border: 1px solid #e1e3e6; border-radius: 15px; overflow: hidden">';
    if (!list.length) h += '<p style="margin: 0; padding: 20px; color: #62686c; font-size: 13px">暂无日志</p>';
    for (const l of list.slice(0, 400)) {
      const c = lv[l.lvl] || lv.INFO;
      h += '<div class="mono" style="display: grid; grid-template-columns: 76px 58px minmax(0, 1fr); gap: 12px; align-items: start; padding: 9px 16px; border-bottom: 1px solid #eceef0; font-size: 12px; line-height: 1.75; background: ' + c[2] + '; box-shadow: inset 3px 0 0 ' + c[3] + '"><span style="color: #62686c">' + esc(l.t) + '</span><span style="justify-self: start; padding: 0 6px; border-radius: 4px; font-weight: 600; background: ' + c[0] + '; color: ' + c[1] + '">' + esc(l.lvl) + '</span><span style="white-space: pre-wrap; overflow-wrap: anywhere">' + esc(l.msg.length > 4000 ? l.msg.slice(0, 4000) + ' …（完整内容见日志文件）' : l.msg) + '</span></div>';
    }
    return h + '</div>';
  }

  // ---------- actions ----------
  async function loadDetail() {
    if (!S.drawer) return;
    const { pid, iid } = S.drawer;
    try {
      const d = await api('GET', '/api/mr/' + pid + '/' + iid);
      if (!S.drawer || S.drawer.pid !== pid || S.drawer.iid !== iid) return;
      const firstLoad = !S.detail || S.detail.reports.length !== d.reports.length;
      S.detail = d; S.detailRev = d.rev;
      if (firstLoad || !S.groupOrder) {
        S.groupOrder = {};
        for (const r of d.reports) for (const f of r.findings) S.groupOrder[r.id + f.id] = f.state;
        if (firstLoad) S.tab = d.reports[0] ? d.reports[0].id : null;
      }
      render();
    } catch (e) { toast(e.message); }
  }

  function openDrawer(pid, iid) {
    S.drawer = { pid, iid }; S.detail = null; S.groupOrder = null; S.tab = null; S.confirmBulk = false; S.queueOpen = false; S.menu = null; S.drawerClosing = false; S.drawerNoAnim = false;
    render();
    setTimeout(() => { S.drawerNoAnim = true; }, 300);
    loadDetail();
  }

  function closeDrawer() {
    if (!S.drawer || S.drawerClosing) return;
    S.drawerClosing = true; S.drawerNoAnim = false; render();
    setTimeout(() => { S.drawer = null; S.detail = null; S.drawerClosing = false; S.confirmBulk = false; render(); }, 180);
  }

  async function loadRules(keepSel) {
    try {
      const r = await api('GET', '/api/rules');
      S.rules = r.rules;
      if (!keepSel || !S.rules.some((x) => x.id === S.ruleSel)) {
        const first = S.rules.find((x) => x.scope === S.ruleScope);
        S.ruleSel = first ? first.id : null;
      }
      render();
    } catch (e) { toast(e.message); }
  }

  async function loadLogs() {
    try { const r = await api('GET', '/api/logs'); S.logs = r.entries; S.logPath = r.path; render(); } catch (e) { toast(e.message); }
  }

  function go(view) {
    S.view = view; S.queueOpen = false; S.menu = null;
    if (S.drawer) { S.drawer = null; S.detail = null; }
    if (view === 'rules') loadRules(true);
    if (view === 'logs') loadLogs();
    render();
    window.scrollTo(0, 0);
  }

  async function addProject() {
    if (S.pidBusy) return;
    const v = S.pid.trim();
    if (!/^[1-9]\d*$/.test(v)) { S.pidMsg = { text: 'Project ID 应为正整数', tone: 'bad' }; render(); return; }
    const ex = S.srv.projects.find((p) => p.id === v);
    if (ex) { S.pidMsg = { text: '该项目已在关注列表中：' + ex.path + '（' + v + '）', tone: 'info' }; flash(v); return; }
    S.pidBusy = true; S.pidMsg = { text: '校验中…', tone: 'muted' }; render();
    try {
      const r = await api('POST', '/api/projects', { id: v });
      S.pidMsg = { text: r.text, tone: r.tone };
      if (r.ok) S.pid = '';
      if (r.flash) flash(r.flash);
    } catch (e) { S.pidMsg = { text: e.message, tone: 'bad' }; }
    S.pidBusy = false; render();
  }

  function flash(pid) {
    S.flash = pid; render();
    const el = document.querySelector('[data-key="pj-' + pid + '"]');
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setTimeout(() => { if (S.flash === pid) { S.flash = null; render(); } }, 2400);
  }

  const handlers = {
    go: (d) => go(d.view),
    addProject,
    goProject: (d) => { if (S.view !== 'mr') go('mr'); S.menu = null; render(); setTimeout(() => { const el = document.getElementById('grp-' + d.pid); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 30); },
    menu: (d) => { S.menu = S.menu === d.pid ? null : d.pid; S.queueOpen = false; render(); },
    openProject: (d) => { S.menu = null; render(); act(() => api('POST', '/api/projects/' + d.pid + '/open')); },
    clearCache: (d) => { S.menu = null; render(); act(() => api('POST', '/api/projects/' + d.pid + '/clear-cache')); },
    askRemove: (d) => { S.menu = null; S.dialog = d.pid; render(); },
    cancelDialog: () => { S.dialog = null; render(); },
    confirmRemove: async () => { const pid = S.dialog; const r = await act(() => api('POST', '/api/projects/' + pid + '/remove')); if (r) { S.dialog = null; if (S.drawer && S.drawer.pid === pid) { S.drawer = null; S.detail = null; } render(); } },
    toggleQueue: () => { S.queueOpen = !S.queueOpen; S.menu = null; render(); },
    fetchAll: () => act(() => api('POST', '/api/fetch', {}), () => null),
    retry: (d) => act(() => api('POST', '/api/fetch', { pid: d.pid }), () => null),
    nextPending: () => { const m = nextPendingMr(); if (m) openDrawer(m.pid, m.iid); else toast('没有待处理的 MR'); },
    open: (d) => openDrawer(d.pid, d.iid),
    openMrWeb: (d) => act(() => api('POST', '/api/mr/' + d.pid + '/' + d.iid + '/open')),
    start: (d) => act(() => api('POST', '/api/reviews', { pid: d.pid, iid: d.iid }), (r) => '!' + d.iid + ' 已加入检视队列 · 第 ' + r.position + ' 位'),
    stop: (d) => act(() => api('POST', '/api/reviews/stop', { pid: d.pid, iid: d.iid }), () => null),
    cancel: (d) => act(() => api('POST', '/api/reviews/cancel', { pid: d.pid, iid: d.iid }), '已取消 !' + d.iid + ' 的排队'),
    closeDrawer,
    tab: (d) => { S.tab = d.id; render(); const el = document.getElementById('drawer'); if (el) el.scrollTop = 0; },
    goLogs: () => go('logs'),
    goNext: () => {
      const rep = S.detail && S.detail.reports[0]; if (!rep) return;
      const pend = rep.findings.filter((f) => f.state === 'pending');
      if (!pend.length) return;
      const el0 = document.getElementById('drawer');
      const cards = pend.map((f) => document.getElementById('f-' + f.id)).filter(Boolean);
      const top = el0 ? el0.getBoundingClientRect().top + 172 : 0;
      const target = cards.find((c) => c.getBoundingClientRect().top > top + 8) || cards[0];
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); target.focus({ preventScroll: true }); }
    },
    askBulk: () => { S.confirmBulk = true; render(); },
    cancelBulk: () => { S.confirmBulk = false; render(); },
    doBulk: async () => { const rep = S.detail.reports[0]; S.confirmBulk = false; await act(() => api('POST', '/api/findings/bulk-dismiss', { pid: S.drawer.pid, iid: S.drawer.iid, reportId: rep.id }), (r) => '已将 ' + r.count + ' 条意见标为不发送，可逐条撤销'); },
    send: (d) => act(() => api('POST', '/api/findings/send', { pid: d.pid, iid: d.iid, reportId: d.rid, fid: d.fid }), () => null),
    dismiss: (d) => act(() => api('POST', '/api/findings/dismiss', { pid: d.pid, iid: d.iid, reportId: d.rid, fid: d.fid }), () => null),
    undo: (d) => act(() => api('POST', '/api/findings/undo', { pid: d.pid, iid: d.iid, reportId: d.rid, fid: d.fid }), '已撤销，重新计入待处理'),
    markSent: (d) => act(() => api('POST', '/api/findings/mark', { pid: d.pid, iid: d.iid, reportId: d.rid, fid: d.fid, result: 'published' }), '已标记为已发布（人工确认）'),
    markUnsent: (d) => act(() => api('POST', '/api/findings/mark', { pid: d.pid, iid: d.iid, reportId: d.rid, fid: d.fid, result: 'unpublished' }), '已标记为未发布，可以重新发送'),
    draft: async (d) => {
      const r = await act(() => api('POST', '/api/findings/draft', { pid: d.pid, iid: d.iid, reportId: d.rid, fid: d.fid }), '已生成规则草稿，确认后再启用');
      if (r) { S.ruleScope = 'global'; S.ruleSel = r.id; S.edit = null; go('rules'); }
    },
    // rules
    openRulesDir: () => act(() => api('POST', '/api/rules/open-dir')),
    reloadRules: () => loadRules(true),
    newRule: async () => { const r = await act(() => api('POST', '/api/rules', { scope: S.ruleScope }), '已新建规则（未启用）'); if (r) { S.ruleSel = r.id; S.edit = null; loadRules(true); } },
    scopeMenu: (d) => { S.scopeMenu = S.scopeMenu === d.key ? null : d.key; S.scopeQ = ''; render(); },
    pickScope: (d) => { S.ruleScope = d.v; S.scopeMenu = null; S.scopeQ = ''; const first = S.rules.find((x) => x.scope === d.v); S.ruleSel = first ? first.id : null; S.edit = null; render(); },
    pickRuleScope: async (d) => {
      S.scopeMenu = null; S.scopeQ = '';
      const r = await act(() => api('POST', '/api/rules/scope', { id: S.ruleSel, scope: d.v }), '已更改关联项目');
      if (r) { S.ruleSel = r.id; S.ruleScope = d.v; S.edit = null; loadRules(true); } else render();
    },
    selectRule: (d) => { if (d.scope) S.ruleScope = d.scope; S.ruleSel = d.id; S.edit = null; render(); },
    toggleRule: async (d) => { const r = await act(() => api('POST', '/api/rules/toggle', { id: d.id }), (x) => (x.enabled ? '已启用规则' : '已停用规则')); if (r) loadRules(true); },
    copyRule: async () => { const r = await act(() => api('POST', '/api/rules/copy', { id: S.ruleSel }), '已复制（副本未启用）'); if (r) { S.ruleSel = r.id; S.edit = null; loadRules(true); } },
    deleteRule: async () => {
      const sel = S.rules.find((r) => r.id === S.ruleSel);
      if (!sel || !window.confirm('删除规则「' + sel.name + '」？规则文件会被删除，已保存的报告不受影响。')) return;
      const r = await act(() => api('POST', '/api/rules/delete', { id: S.ruleSel }), '已删除规则「' + sel.name + '」');
      if (r) { S.ruleSel = null; S.edit = null; loadRules(false); }
    },
    revertRule: () => { S.edit = null; render(); },
    saveRule: async () => {
      const sel = S.rules.find((r) => r.id === S.ruleSel); if (!sel) return;
      const ed = S.edit && S.edit.id === sel.id ? S.edit : { name: sel.name, files: sel.files, body: sel.body };
      const r = await act(() => api('POST', '/api/rules/save', { id: sel.id, name: ed.name, files: ed.files, body: ed.body, confirmDraft: sel.draft }), sel.draft ? '规则已确认并启用' : '已保存到 rules/' + sel.file);
      if (r) { S.ruleSel = r.id; S.edit = null; loadRules(true); }
    },
    // logs
    copyLogPath: async () => { try { await navigator.clipboard.writeText(S.logPath || S.srv.logPath); toast('已复制日志路径'); } catch { toast('复制失败，请手动选择路径'); } },
    logErrors: () => { S.logErrorsOnly = !S.logErrorsOnly; render(); }
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) {
      if (S.menu && !e.target.closest('[role="menu"]')) { S.menu = null; render(); }
      if (S.scopeMenu && !e.target.closest('[role="listbox"]') && !e.target.closest('input')) { S.scopeMenu = null; render(); }
      return;
    }
    if (el.disabled) return;
    const fn = handlers[el.getAttribute('data-act')];
    if (!fn) return;
    e.preventDefault();
    if (S.menu && el.getAttribute('data-act') !== 'menu' && !el.closest('[role="menu"]')) S.menu = null;
    fn(Object.assign({}, el.dataset));
  });

  document.addEventListener('input', (e) => {
    const k = e.target.getAttribute && e.target.getAttribute('data-input');
    if (!k) return;
    const v = e.target.value;
    if (k === 'pid') { S.pid = v; if (S.pidMsg && S.pidMsg.tone !== 'muted') S.pidMsg = null; render(); return; }
    if (k === 'scopeQ') { S.scopeQ = v; render(); return; }
    const sel = S.rules && S.rules.find((r) => r.id === S.ruleSel);
    if (!sel) return;
    if (!S.edit || S.edit.id !== sel.id) S.edit = { id: sel.id, name: sel.name, files: sel.files || '', body: sel.body };
    if (k === 'ruleName') S.edit.name = v;
    if (k === 'ruleFiles') S.edit.files = v;
    if (k === 'ruleBody') S.edit.body = v;
    if (k === 'ruleName') render();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'pid-input') { e.preventDefault(); addProject(); }
    if (e.key === 'Escape') {
      if (S.dialog) { S.dialog = null; render(); } else if (S.scopeMenu) { S.scopeMenu = null; render(); } else if (S.menu) { S.menu = null; render(); } else if (S.queueOpen) { S.queueOpen = false; render(); } else if (S.drawer) closeDrawer();
    }
  });

  // ---------- live updates ----------
  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('state', (ev) => {
      const s = JSON.parse(ev.data);
      S.srv = s; S.connected = true; S.clockSkew = s.now - Date.now();
      if (S.drawer) {
        const m = s.mrs.find((x) => x.pid === S.drawer.pid && x.iid === S.drawer.iid);
        const rev = m ? m.rev : -2;
        const metaChanged = S.detail && m && (m.stale !== S.detail.stale || m.updatedAt !== (S.detail.mr && S.detail.mr.updatedAt));
        if (!S.detail || rev !== S.detailRev || (S.detail.open !== Boolean(m)) || metaChanged) loadDetail();
      }
      if (S.view === 'rules' && S.rules && s.drafts.length !== (S.rules.filter((r) => r.draft && !r.error).length)) loadRules(true);
      render();
    });
    es.addEventListener('toast', (ev) => toast(JSON.parse(ev.data).text));
    es.addEventListener('log', (ev) => { const l = JSON.parse(ev.data); S.logs.unshift(l); if (S.logs.length > 500) S.logs.pop(); if (S.view === 'logs') render(); });
    es.onopen = () => { S.connected = true; if (S.view === 'logs') loadLogs(); render(); };
    es.onerror = () => { S.connected = false; render(); };
  }

  // Elapsed timers tick while a review runs.
  setInterval(() => { if (S.srv && S.srv.queue.some((j) => j.status !== 'queued')) render(); }, 1000);

  render();
  connect();
  api('GET', '/api/logs').then((r) => { S.logs = r.entries; S.logPath = r.path; }).catch(() => {});
})();
