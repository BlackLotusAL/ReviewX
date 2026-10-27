'use strict';
// Step 6: one read-only OpenCode session (R10, R11).
//  - config injected via OPENCODE_CONFIG_CONTENT; the user's own config is untouched
//  - all tools denied except read/glob/grep and the two ReviewX submission tools
//  - every tool call in the event stream is checked; anything else kills the run
//  - wrap-up once: at the wrap-up time, on truncated output, or when the AI
//    stops without finish_review; the hard timeout ends the step
const fs = require('fs');
const path = require('path');
const { resolveCommand, run, killTree } = require('./proc');
const { sleep } = require('./util');
const { ReviewFailure, Stopped } = require('./failure');

const READ_TOOLS = ['read', 'glob', 'grep'];

// Environment for OpenCode: no repository credentials, Git config or related variables (R06).
function cleanEnv() {
  const env = {};
  const drop = /^(GIT_|GH_|GITHUB_|GITLAB_|CODEHUB|DEVUC|GCM_|SSH_AUTH_SOCK|SSH_AGENT_PID|NPM_TOKEN|NODE_AUTH_TOKEN|REVIEWX_)/i;
  for (const [k, v] of Object.entries(process.env)) {
    if (drop.test(k)) continue;
    if (/(^|_)(TOKEN|PASSWORD|PASSWD|CREDENTIALS?)$/i.test(k) && !/API_KEY/i.test(k)) continue;
    env[k] = v;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  return env;
}

function readPermission(excludes) {
  const rule = { '*': 'allow' };
  for (const p of excludes) {
    const pats = p.startsWith('.') ? ['*' + p] : [p, '*/' + p, '*\\' + p];
    for (const x of pats) rule[x] = 'deny';
  }
  return rule;
}

function buildConfig({ mcpUrl, excludes, wrapUp }) {
  const permission = { '*': 'deny', external_directory: 'deny', 'reviewx_*': 'allow' };
  const tools = { '*': false, 'reviewx_*': true };
  if (wrapUp) {
    for (const t of READ_TOOLS) { permission[t] = 'deny'; tools[t] = false; }
  } else {
    permission.read = readPermission(excludes);
    permission.glob = 'allow';
    permission.grep = 'allow';
    for (const t of READ_TOOLS) tools[t] = true;
  }
  return {
    $schema: 'https://opencode.ai/config.json',
    permission,
    tools,
    mcp: { reviewx: { type: 'remote', url: mcpUrl, enabled: true, oauth: false } },
    share: 'disabled',
    autoupdate: false,
    snapshot: false
  };
}

function isSubmitTool(name) { return /^reviewx[_-]/.test(name || '') && /(report_finding|finish_review)$/.test(name); }

class OpenCode {
  constructor(cfg, logger) {
    this.spec = cfg.opencodeCommand;
    this.logger = logger;
  }

  cmd() {
    const r = resolveCommand(this.spec);
    if (!r) throw new ReviewFailure({ step: 6, kind: 'env', code: 'OPENCODE_MISSING', title: '步骤 6/7 未找到 OpenCode', reason: '没有找到 OpenCode 命令', next: '安装 OpenCode，确认终端里能运行 opencode，然后重新检视。' });
    return r;
  }

  async modelOf(sessionId, cwd) {
    try {
      const r = await run(this.cmd(), ['export', sessionId], { cwd, env: cleanEnv(), timeoutMs: 60000 });
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      const m = j.info && j.info.model;
      if (m && m.id) return (m.providerID ? m.providerID + '/' : '') + m.id;
      const msg = (j.messages || []).map((x) => x.info).find((x) => x && x.modelID);
      if (msg) return (msg.providerID ? msg.providerID + '/' : '') + msg.modelID;
    } catch (e) {
      this.logger.warn('opencode.model unavailable reason=' + e.message);
    }
    return null;
  }

  /**
   * opts: copyDir, taskFile, mcpUrl, excludes, wrapUpMs, timeoutMs, signal,
   *       tracker { diffFiles:Set<rel>, read:Set<rel>, finished:bool, count:int, wrapUp:bool },
   *       onProgress(), rawLog(line)
   */
  async review(opts) {
    const t0 = Date.now();
    const deadline = t0 + opts.timeoutMs;
    const wrapAt = t0 + opts.wrapUpMs;
    const tr = opts.tracker;
    let sessionId = null;
    let violation = null;
    let truncated = false;
    let contextOverflow = null;
    let lastError = null;
    let child = null;
    let phaseCtl = null;

    const onEvent = (line) => {
      opts.rawLog(line);
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.sessionID && !sessionId) sessionId = ev.sessionID;
      const part = ev.part || {};
      if (ev.type === 'tool_use' || part.type === 'tool') {
        const name = part.tool || '';
        const allowed = READ_TOOLS.includes(name) || isSubmitTool(name);
        if (!allowed && name !== 'invalid') {
          violation = name;
          if (child) killTree(child);
          return;
        }
        if (name === 'invalid') this.logger.warn('opencode.tool invalid call ignored');
        if (name === 'read' && part.state && part.state.status === 'completed') {
          const fp = (part.state.input && (part.state.input.filePath || part.state.input.path)) || '';
          const rel = path.relative(opts.copyDir, path.resolve(opts.copyDir, fp)).split(path.sep).join('/');
          const key = process.platform === 'win32' ? rel.toLowerCase() : rel;
          for (const d of tr.diffFiles) if ((process.platform === 'win32' ? d.toLowerCase() : d) === key) tr.read.add(d);
          opts.onProgress();
        }
      }
      if (ev.type === 'step_finish' && part.reason === 'length') {
        truncated = true;
        if (!tr.wrapUp && child) { killTree(child); }
      }
      if (ev.type === 'error' || ev.error) {
        const msg = JSON.stringify(ev.error || ev).slice(0, 2000);
        lastError = msg;
        if (/context[_ \w-]*(length|window|limit|overflow)|maximum context|too many tokens|prompt is too long|ContextOverflow/i.test(msg)) contextOverflow = msg;
      }
    };

    const runOnce = async (args, wrapUp) => {
      const env = cleanEnv();
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(buildConfig({ mcpUrl: opts.mcpUrl, excludes: opts.excludes, wrapUp }));
      phaseCtl = new AbortController();
      const stopFromParent = () => phaseCtl.abort();
      opts.signal.addEventListener('abort', stopFromParent, { once: true });
      const now = Date.now();
      const until = wrapUp ? deadline : Math.min(wrapAt, deadline);
      const timer = setTimeout(() => phaseCtl.abort(), Math.max(0, until - now));
      try {
        return await run(this.cmd(), args, { cwd: opts.copyDir, env, signal: phaseCtl.signal, onLine: onEvent, onSpawn: (c) => { child = c; } });
      } catch (e) {
        if (e instanceof ReviewFailure) throw e; // e.g. OpenCode not installed (environment-level)
        throw new ReviewFailure({ step: 6, kind: 'ai', code: 'OPENCODE_ERROR', title: '步骤 6/7 OpenCode 报错', reason: '无法启动 OpenCode：' + e.message, next: '确认终端里能运行 opencode 后重新检视。' });
      } finally {
        clearTimeout(timer);
        opts.signal.removeEventListener('abort', stopFromParent);
        child = null;
      }
    };

    const checkCommon = (res) => {
      if (opts.signal.aborted) throw new Stopped();
      if (violation) {
        throw new ReviewFailure({ step: 6, kind: 'ai', code: 'TOOL_VIOLATION', title: '步骤 6/7 越权调用', reason: 'OpenCode 调用了白名单以外的工具「' + violation + '」，已立即终止整个会话', next: '检查 OpenCode 的插件和自定义工具设置后重新检视；未生成意见。', detail: 'tool=' + violation });
      }
      if (contextOverflow) {
        throw new ReviewFailure({ step: 6, kind: 'context', code: 'CONTEXT_OVERFLOW', title: '步骤 6/7 上下文超限', reason: 'OpenCode 自动压缩后仍超出模型上下文上限', next: '该 MR 规模超出模型能力，建议改为人工检视；队列中的其余检视继续执行。', detail: contextOverflow.slice(0, 500) });
      }
      if (Date.now() >= deadline) {
        throw new ReviewFailure({ step: 6, kind: 'ai', code: 'OPENCODE_TIMEOUT', title: '步骤 6/7 超时', reason: '步骤 6 总时长超过「OpenCode 超时」（' + Math.round(opts.timeoutMs / 60000) + ' 分钟）', next: '调大配置项「OpenCode 超时」（opencodeTimeoutMinutes）后重启 ReviewX，再重新检视。', detail: 'elapsed=' + Math.round((Date.now() - t0) / 1000) + 's' });
      }
      return res;
    };

    // Phase 1: the main session, with up to 2 restarts if the process exits before the session starts.
    const taskArgs = ['run', '--pure', '--format', 'json', '--title', 'ReviewX 检视', '-f', opts.taskFile, '--', '请按附件中的任务说明完成本次代码检视。'];
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = checkCommon(await runOnce(taskArgs, false));
      if (sessionId) break;
      if (attempt < 2) {
        this.logger.warn('opencode.start exited before session start code=' + res.code + ' retry=' + (attempt + 1));
        await sleep(3000, opts.signal);
        if (opts.signal.aborted) throw new Stopped();
      }
    }
    if (!sessionId) {
      throw new ReviewFailure({ step: 6, kind: 'ai', code: 'OPENCODE_ERROR', title: '步骤 6/7 OpenCode 报错', reason: 'OpenCode 进程在会话开始前退出（已重试 2 次）', next: '在终端运行 opencode 确认模型与登录状态正常后重新检视。', detail: (res.stderr || '').slice(-1500) });
    }
    if (tr.finished) return { sessionId };
    if (res.code !== 0 && !res.aborted && !truncated && lastError && Date.now() < wrapAt) {
      throw new ReviewFailure({ step: 6, kind: 'ai', code: 'OPENCODE_ERROR', title: '步骤 6/7 OpenCode 报错', reason: 'OpenCode 运行出错', next: '查看会话日志中的原始输出，排除问题后重新检视。', detail: (lastError || res.stderr || '').slice(-1500) });
    }

    // Phase 2: wrap-up in the same session, submission tools only.
    tr.wrapUp = true;
    opts.onProgress();
    const why = truncated ? '上一次输出因长度上限被截断' : (Date.now() >= wrapAt ? '已到达收尾时间' : '你结束了回复但没有调用 finish_review');
    const unread = [...tr.diffFiles].filter((d) => !tr.read.has(d));
    const wrapMsg = '【收尾】' + why + '。现在只能使用提交工具：请立即用 reviewx_report_finding 提交尚未提交、且已经核实的意见（不要重复提交已提交的意见），然后调用 reviewx_finish_review 结束检视。' + (unread.length ? '注意：仍有 ' + unread.length + ' 个差异文件未读，查阅工具已关闭。' : '');
    truncated = false;
    res = checkCommon(await runOnce(['run', '--pure', '--format', 'json', '-s', sessionId, '--', wrapMsg], true));
    if (tr.finished) return { sessionId };
    const stillUnread = [...tr.diffFiles].filter((d) => !tr.read.has(d)).map((d) => d.replace(/^\.reviewx-diff\//, '').replace(/(\.\d+)?\.diff$/, ''));
    throw new ReviewFailure({
      step: 6, kind: 'ai', code: 'REVIEW_INCOMPLETE', title: '步骤 6/7 检视未完成',
      reason: truncated ? '模型推理超出输出上限：收尾时输出再次被截断，未调用 finish_review' : (stillUnread.length ? '收尾后仍有 ' + stillUnread.length + ' 个差异文件未读' : 'AI 收尾后仍未调用 finish_review'),
      next: '调大配置项「收尾时间」（wrapUpMinutes）和「OpenCode 超时」（opencodeTimeoutMinutes）后重启 ReviewX，再重新检视。已提交的意见不会保存为报告。',
      unread: stillUnread.length ? [...new Set(stillUnread)] : null,
      detail: (lastError || '').slice(-1000)
    });
  }
}

module.exports = { OpenCode, buildConfig, cleanEnv };
