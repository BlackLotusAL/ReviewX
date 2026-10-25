'use strict';
// Thin wrapper over the CodeHub CLI. All calls go through one global semaphore
// ("并发数", R04) and pass arguments as an array (R13 Windows 适配).
const { resolveCommand, run } = require('./proc');
const { Semaphore } = require('./util');

const REASONS = {
  NETWORK_ERROR: '网络不可用',
  AUTH_ERROR: 'CodeHub CLI 未登录或认证失败（请重新登录）',
  CONFIG_ERROR: 'CodeHub CLI 配置错误（请运行 codehub config init 并检查配置）',
  INVALID_ARGUMENT: 'CodeHub CLI 参数无效',
  WRITE_RESULT_UNKNOWN: '结果未知，请到 CodeHub 核对',
  CANCELLED: '已取消',
  NOT_FOUND: '项目不存在或无访问权限',
  CLI_MISSING: '未找到 CodeHub CLI（请确认已安装并可在终端运行 codehub）',
  BAD_OUTPUT: 'CodeHub CLI 返回了无法解析的结果'
};

class CodeHubError extends Error {
  constructor(code, message, httpStatus) {
    super(message || REASONS[code] || code);
    this.code = code;
    this.httpStatus = httpStatus;
  }
  // Short Chinese reason for the UI.
  get reason() {
    if (this.code === 'HTTP_ERROR' && (this.httpStatus === 404 || this.httpStatus === 403)) return REASONS.NOT_FOUND;
    if (this.code === 'HTTP_ERROR') return 'CodeHub 请求失败' + (this.httpStatus ? '（HTTP ' + this.httpStatus + '）' : '');
    return REASONS[this.code] || this.message;
  }
  // Environment-level errors stop the review queue (R17).
  get isEnv() { return ['NETWORK_ERROR', 'AUTH_ERROR', 'CONFIG_ERROR', 'CLI_MISSING'].includes(this.code); }
}

class CodeHub {
  constructor(cfg, logger) {
    this.spec = cfg.codehubCommand;
    this.logger = logger;
    this.sem = new Semaphore(cfg.concurrency);
  }

  resolved() {
    const r = resolveCommand(this.spec);
    if (!r) throw new CodeHubError('CLI_MISSING');
    return r;
  }

  async call(args, opts = {}) {
    const cmd = this.resolved();
    return this.sem.use(async () => {
      let res;
      try {
        res = await run(cmd, args.concat(['--output', 'json']), { signal: opts.signal, timeoutMs: opts.timeoutMs || 120000 });
      } catch (e) {
        throw new CodeHubError('CLI_MISSING', e.message);
      }
      if (res.aborted) throw new CodeHubError('CANCELLED');
      if (res.code === 0) {
        try {
          return JSON.parse(res.stdout);
        } catch {
          throw new CodeHubError('BAD_OUTPUT');
        }
      }
      let err = null;
      try { err = JSON.parse(res.stderr.trim().split('\n').pop()); } catch { /* not JSON */ }
      if (!err) { try { err = JSON.parse(res.stderr); } catch { /* not JSON */ } }
      if (err && err.code) throw new CodeHubError(err.code, err.message, err.http_status);
      if (res.timedOut) throw new CodeHubError(args[0] === 'mr' && args[1] === 'comment' ? 'WRITE_RESULT_UNKNOWN' : 'NETWORK_ERROR', 'CLI 调用超时');
      throw new CodeHubError(res.code === 8 ? 'NETWORK_ERROR' : res.code === 3 ? 'AUTH_ERROR' : 'HTTP_ERROR', 'CLI 退出码 ' + res.code);
    });
  }

  repoView(pid, o) { return this.call(['repo', 'view', String(pid)], o); }
  mrList(pid, o) { return this.call(['mr', 'list', '--project-id', String(pid), '--state', 'open'], o); }
  mrView(pid, iid, o) { return this.call(['mr', 'view', String(iid), '--project-id', String(pid)], o); }
  mrCommits(pid, iid, o) { return this.call(['mr', 'commits', String(iid), '--project-id', String(pid)], o); }
  commentCreate(pid, iid, body, severity) {
    // Comments must never be retried automatically (R03).
    return this.call(['mr', 'comment', 'create', String(iid), '--project-id', String(pid), '--body', body, '--severity', severity], { timeoutMs: 180000 });
  }
}

module.exports = { CodeHub, CodeHubError, REASONS };
