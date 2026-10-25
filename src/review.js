'use strict';
// Review queue and the 7-step review (R01, R07, R10–R12, R17, R19, R25).
// One global FIFO queue; only one review runs at a time.
const fs = require('fs');
const path = require('path');
const { ensureDir, rmrf, newId } = require('./util');
const { CodeHubError } = require('./codehub');
const { GitError, matchExcluded, KIND_LABEL } = require('./git');
const { ReviewFailure, Stopped } = require('./failure');
const { validateFinding, sortFindings, SEV_RANK } = require('./finding');
const { redact } = require('./logger');

const STEPS = ['读取 MR 信息', '拉取源分支', '拉取目标分支', '校验 MR 未变化', '生成变更快照', 'OpenCode 检视', '保存报告与意见'];
const DIFF_PART_LINES = 1500;

function pickCloneUrl(urls, protocol) {
  if (!urls) return null;
  if (typeof urls === 'string') return urls;
  const list = Array.isArray(urls) ? urls.map((u) => (typeof u === 'string' ? u : u && (u.url || u.href))).filter(Boolean)
    : Object.values(urls).filter((u) => typeof u === 'string');
  const isSsh = (u) => /^(ssh:\/\/|git@|[\w.-]+@[\w.-]+:)/.test(u);
  const want = list.find((u) => (protocol === 'ssh' ? isSsh(u) : /^https?:/.test(u)));
  return want || list[0] || null;
}

function splitDiff(text) {
  const lines = text.split('\n');
  if (lines.length <= DIFF_PART_LINES) return [text];
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  const header = firstHunk > 0 ? lines.slice(0, firstHunk) : [];
  const parts = []; let cur = [];
  for (let i = Math.max(firstHunk, 0); i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('@@') && cur.length >= DIFF_PART_LINES * 0.6) { parts.push(cur); cur = []; }
    cur.push(l);
    if (cur.length >= DIFF_PART_LINES * 1.4) { parts.push(cur); cur = []; }
  }
  if (cur.length) parts.push(cur);
  return parts.map((p, i) => header.concat(['# ReviewX：差异第 ' + (i + 1) + '/' + parts.length + ' 部分'], p).join('\n'));
}

function failFromCodeHub(e, step) {
  if (e instanceof Stopped || e.code === 'CANCELLED') return new Stopped();
  return new ReviewFailure({
    step, kind: e.isEnv ? 'env' : 'step', code: e.code,
    title: '步骤 ' + step + '/7 ' + STEPS[step - 1] + '失败',
    reason: e.reason,
    next: e.code === 'AUTH_ERROR' ? '在终端运行 codehub auth login 重新登录后重新检视。' : e.code === 'NETWORK_ERROR' ? '恢复网络后重新检视。' : e.code === 'CLI_MISSING' ? '安装 CodeHub CLI 并确认终端里能运行 codehub。' : '到 CodeHub 确认 MR 仍可访问后重新检视。',
    detail: e.code + (e.httpStatus ? ' http=' + e.httpStatus : '') + ' ' + e.message
  });
}

function failFromGit(e, step) {
  if (e.kind === 'cancelled') return new Stopped();
  const base = { step, code: 'GIT_' + e.kind.toUpperCase(), detail: redact(e.detail || e.message), title: '步骤 ' + step + '/7 ' + STEPS[step - 1] + '失败' };
  if (e.kind === 'auth') return new ReviewFailure(Object.assign(base, { kind: 'env', reason: 'Git 认证失败', next: '在终端用 git 拉取一次该仓库，确认本机凭据管理器或 SSH 密钥可用后重新检视。' }));
  if (e.kind === 'network') return new ReviewFailure(Object.assign(base, { kind: 'env', reason: '网络不可用，无法连接代码仓库', next: '恢复网络后重新检视。' }));
  if (e.kind === 'cli') return new ReviewFailure(Object.assign(base, { kind: 'env', reason: e.message, next: '安装 Git 后重新检视。' }));
  if (e.kind === 'corrupt') return new ReviewFailure(Object.assign(base, { kind: 'step', code: 'CACHE_CORRUPT', reason: '代码缓存已损坏', next: '在左侧项目的「···」菜单点「清除代码缓存」，然后重新检视；下次检视会重建缓存。' }));
  if (e.kind === 'missing-branch') return new ReviewFailure(Object.assign(base, { kind: 'step', reason: '远端找不到该分支，可能已被删除', next: '到 CodeHub 确认 MR 的分支仍存在后重新检视。' }));
  return new ReviewFailure(Object.assign(base, { kind: 'step', reason: 'Git 命令执行失败', next: '查看会话日志中的技术详情；若怀疑缓存损坏，可清除代码缓存后重新检视。' }));
}

class ReviewEngine {
  constructor(app) {
    this.app = app;
    this.jobs = []; // queued and active, FIFO
    this.pumping = false;
  }

  get store() { return this.app.store; }
  get log() { return this.app.logger; }

  key(pid, iid) { return pid + '/' + iid; }
  find(pid, iid) { return this.jobs.find((j) => j.pid === String(pid) && j.iid === String(iid)); }

  // R13 重启恢复: anything queued/running when ReviewX closed becomes stopped.
  recover() {
    let n = 0;
    for (const pid of this.store.listProjectsWithData()) {
      for (const iid of this.store.listMrKeys(pid)) {
        for (const a of this.store.attempts(pid, iid)) {
          if (a.status === 'queued' || a.status === 'running') {
            this.store.appendAttempt(pid, iid, { t: 'ended', id: a.id, at: Date.now(), status: 'stopped', stopReason: 'ReviewX 关闭时中断' });
            n++;
          }
        }
      }
    }
    if (n) this.log.info('review.recover interrupted=' + n);
  }

  enqueue(pid, iid) {
    pid = String(pid); iid = String(iid);
    if (this.find(pid, iid)) throw new Error('该 MR 已有检视在排队或进行中');
    const mr = this.app.openMr(pid, iid);
    if (!mr) throw new Error('该 MR 不在最近一次获取的开放 MR 列表中');
    const job = { id: newId('rv'), pid, iid, title: mr.title, status: 'queued', queuedAt: Date.now(), step: 0, times: [], findings: [], abort: new AbortController() };
    this.store.appendAttempt(pid, iid, { t: 'queued', id: job.id, at: job.queuedAt });
    this.jobs.push(job);
    const pos = this.jobs.filter((j) => j.status === 'queued').length;
    this.log.info('review.enqueue !' + iid + ' project=' + pid + ' position=' + pos);
    this.app.changed(pid, iid);
    setImmediate(() => this.pump());
    return { position: pos, total: pos };
  }

  cancel(pid, iid, reason) {
    const j = this.find(pid, iid);
    if (!j || j.status !== 'queued') throw new Error('该 MR 没有排队中的检视');
    this.jobs = this.jobs.filter((x) => x !== j);
    this.store.appendAttempt(j.pid, j.iid, { t: 'ended', id: j.id, at: Date.now(), status: 'stopped', stopReason: reason || '已取消 · 尚未开始' });
    this.log.info('review.cancel !' + j.iid + ' project=' + j.pid);
    this.app.changed(j.pid, j.iid);
  }

  stop(pid, iid, reason) {
    const j = this.find(pid, iid);
    if (!j) throw new Error('该 MR 没有进行中的检视');
    if (j.status === 'queued') return this.cancel(pid, iid, reason);
    if (j.status === 'stopping') return j.done;
    j.status = 'stopping';
    j.stopReason = reason || '已主动停止';
    j.stopNote = '正在停止 · 终止子进程';
    this.log.info('review.stop !' + j.iid + ' requested');
    j.abort.abort();
    this.app.changed(j.pid, j.iid);
    return j.done;
  }

  // R22: stop/dequeue all reviews of a project, resolve when finished.
  async stopProject(pid) {
    pid = String(pid);
    for (const j of this.jobs.slice()) {
      if (j.pid !== pid) continue;
      if (j.status === 'queued') this.cancel(j.pid, j.iid, '项目已移除');
    }
    const active = this.jobs.find((j) => j.pid === pid);
    if (active) await this.stop(active.pid, active.iid, '项目已移除');
  }

  async stopAll() {
    for (const j of this.jobs.slice()) if (j.status === 'queued') this.cancel(j.pid, j.iid, 'ReviewX 关闭时中断');
    const a = this.jobs[0];
    if (a) await this.stop(a.pid, a.iid, 'ReviewX 关闭时中断');
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.jobs.length && this.jobs[0].status === 'queued') {
        const job = this.jobs[0];
        let resolveDone;
        job.done = new Promise((r) => { resolveDone = r; });
        try {
          await this.execute(job);
        } finally {
          this.jobs = this.jobs.filter((x) => x !== job);
          resolveDone();
          this.app.changed(job.pid, job.iid);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  setStep(job, n) {
    const now = Date.now();
    if (job.step) job.times[job.step - 1] = now - job.stepStartedAt;
    job.step = n;
    job.stepStartedAt = now;
    job.obj = 0; job.objN = 0;
    this.app.changed(job.pid, job.iid);
  }

  async execute(job) {
    const { pid, iid } = job;
    const signal = job.abort.signal;
    const cfg = this.app.cfg;
    job.status = 'running';
    job.startedAt = Date.now();
    this.store.appendAttempt(pid, iid, { t: 'started', id: job.id, at: job.startedAt });
    this.log.info('review.start !' + iid + ' project=' + pid);
    const work = path.join(this.store.tmpDir(), job.id);
    const copy = path.join(work, 'repo');
    const raw = [];
    let rawBytes = 0;
    const rawLog = (line) => { if (rawBytes < 2 * 1024 * 1024) { raw.push(line); rawBytes += line.length; } };
    const check = () => { if (signal.aborted) throw new Stopped(); };
    try {
      const project = this.app.project(pid);
      if (!project) throw new ReviewFailure({ step: 1, kind: 'step', code: 'PROJECT_REMOVED', title: '步骤 1/7 读取 MR 信息失败', reason: '项目不在关注列表中' });

      // 1. MR info
      this.setStep(job, 1);
      let mr;
      try { mr = await this.app.codehub.mrView(pid, iid, { signal }); } catch (e) { throw failFromCodeHub(e, 1); }
      check();
      job.title = mr.title || job.title;
      let cloneUrl = pickCloneUrl(project.cloneUrls, cfg.gitProtocol);
      if (!cloneUrl) {
        try {
          const repo = await this.app.codehub.repoView(pid, { signal });
          this.app.updateProjectInfo(pid, repo);
          cloneUrl = pickCloneUrl(repo.clone_urls, cfg.gitProtocol);
        } catch (e) { throw failFromCodeHub(e, 1); }
      }
      if (!cloneUrl) throw new ReviewFailure({ step: 1, kind: 'step', code: 'NO_CLONE_URL', title: '步骤 1/7 读取 MR 信息失败', reason: 'CodeHub 没有返回仓库的克隆地址' });
      if (!mr.source_branch || !mr.target_branch) throw new ReviewFailure({ step: 1, kind: 'step', code: 'BAD_MR', title: '步骤 1/7 读取 MR 信息失败', reason: 'MR 信息缺少源分支或目标分支' });

      // 2–3. fetch branches into the code cache
      const cacheDir = this.store.cacheDir(pid);
      this.setStep(job, 2);
      let srcSha; let tgtSha;
      try {
        await this.app.git.ensureCache(cacheDir, cloneUrl, signal);
        srcSha = await this.app.git.fetchBranch(cacheDir, mr.source_branch, 'refs/reviewx/' + iid + '/source', signal);
      } catch (e) { if (e instanceof GitError) throw failFromGit(e, 2); throw e; }
      check();
      this.setStep(job, 3);
      try {
        tgtSha = await this.app.git.fetchBranch(cacheDir, mr.target_branch, 'refs/reviewx/' + iid + '/target', signal);
      } catch (e) { if (e instanceof GitError) throw failFromGit(e, 3); throw e; }
      check();

      // 4. MR unchanged while fetching?
      this.setStep(job, 4);
      let mr2;
      try { mr2 = await this.app.codehub.mrView(pid, iid, { signal }); } catch (e) { throw failFromCodeHub(e, 4); }
      check();
      if (mr2.updated_at !== mr.updated_at || mr2.source_branch !== mr.source_branch || mr2.target_branch !== mr.target_branch) {
        throw new ReviewFailure({ step: 4, kind: 'step', code: 'MR_CHANGED', title: '步骤 4/7 MR 在拉取期间已变化', reason: 'MR 更新时间从 ' + mr.updated_at + ' 变为 ' + mr2.updated_at + '，拉取到的代码可能不一致', next: '直接重新检视即可。' });
      }

      // 5. change snapshot
      this.setStep(job, 5);
      let base; let changed;
      try {
        base = await this.app.git.mergeBase(cacheDir, tgtSha, srcSha, signal);
        changed = await this.app.git.changedFiles(cacheDir, base, srcSha, signal);
      } catch (e) { if (e instanceof GitError) throw failFromGit(e, 5); throw e; }
      const excluded = []; const included = [];
      for (const f of changed) {
        const pat = matchExcluded(f.path, cfg.excludeFileTypes);
        if (pat) excluded.push({ path: f.path, reason: KIND_LABEL(pat) });
        else if (f.binary) excluded.push({ path: f.path, reason: '二进制' });
        else included.push(f);
      }
      let commits = [];
      try { commits = await this.app.git.commitMessages(cacheDir, base, srcSha, signal); } catch (e) { if (e instanceof GitError) throw failFromGit(e, 5); throw e; }
      const ruleSel = this.app.rules.forReview(pid, included.map((f) => f.path));
      job.objN = included.length;
      let diffFiles = [];
      if (included.length) {
        try { await this.app.git.exportTree(cacheDir, srcSha, copy, signal); } catch (e) { if (e instanceof GitError) throw failFromGit(e, 5); throw e; }
        const diffRoot = path.join(copy, '.reviewx-diff');
        for (const f of included) {
          check();
          let text;
          try { text = await this.app.git.fileDiff(cacheDir, base, srcSha, f.path, signal); } catch (e) { if (e instanceof GitError) throw failFromGit(e, 5); throw e; }
          const parts = splitDiff(text);
          f.diffFiles = [];
          parts.forEach((p, i) => {
            const rel = '.reviewx-diff/' + f.path + (parts.length > 1 ? '.' + (i + 1) : '') + '.diff';
            const abs = path.join(copy, ...rel.split('/'));
            ensureDir(path.dirname(abs));
            fs.writeFileSync(abs, p);
            f.diffFiles.push(rel);
            diffFiles.push(rel);
          });
          job.obj++;
          if (job.obj % 5 === 0 || job.obj === job.objN) this.app.changed(pid, iid);
        }
        // Keep glob/grep away from excluded files too.
        const ignoreFile = path.join(copy, '.ignore');
        const prev = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') + '\n' : '';
        fs.writeFileSync(ignoreFile, prev + cfg.excludeFileTypes.map((p) => (p.startsWith('.') ? '*' + p : p)).join('\n') + '\n');
      }
      check();

      // 6. OpenCode
      let model = null; let conclusion;
      const tracker = { diffFiles: new Set(diffFiles), read: new Set(), finished: false, wrapUp: false };
      job.diffN = diffFiles.length;
      if (!included.length) {
        conclusion = 'empty';
        this.setStep(job, 7);
      } else {
        this.setStep(job, 6);
        job.phase = 'review';
        await this.app.opencode.checkVersion();
        check();
        const ruleNames = ruleSel.used.map((r) => r.name);
        const token = this.app.mcp.open({
          ruleNames,
          report: async (input) => {
            if (tracker.finished) return { ok: false, text: '本次检视已经结束（finish_review 之后不再接受提交）。' };
            const v = validateFinding(input, ruleNames);
            if (!v.ok) return { ok: false, text: '校验未通过，请修正后重新提交：\n- ' + v.errors.join('\n- ') };
            job.findings.push(v.finding);
            this.app.changed(pid, iid);
            return { ok: true, text: '已记录第 ' + job.findings.length + ' 条意见。' };
          },
          finish: async () => {
            if (tracker.finished) return { ok: true, text: '检视已结束。' };
            let unread = [...tracker.diffFiles].filter((d) => !tracker.read.has(d));
            if (unread.length) { await new Promise((r) => setTimeout(r, 400)); unread = [...tracker.diffFiles].filter((d) => !tracker.read.has(d)); }
            if (unread.length && !tracker.wrapUp) return { ok: false, text: '还有 ' + unread.length + ' 个差异文件没有读取，请先用 read 读完再调用 finish_review：\n' + unread.join('\n') };
            if (unread.length) return { ok: false, text: '仍有 ' + unread.length + ' 个差异文件未读，本次检视无法完成。' };
            tracker.finished = true;
            this.app.changed(pid, iid);
            return { ok: true, text: '检视已结束，共提交 ' + job.findings.length + ' 条意见。请直接结束回复。' };
          }
        });
        job.tracker = tracker;
        const taskFile = path.join(work, 'task.md');
        fs.writeFileSync(taskFile, this.buildPrompt({ mr, commits, included, excluded, rules: ruleSel.used, lang: cfg.outputLanguage }));
        try {
          const r = await this.app.opencode.review({
            copyDir: copy, taskFile, mcpUrl: this.app.mcpUrl(token), excludes: cfg.excludeFileTypes,
            wrapUpMs: cfg.wrapUpMinutes * 60000, timeoutMs: cfg.opencodeTimeoutMinutes * 60000, signal, tracker,
            onProgress: () => { job.phase = tracker.wrapUp ? 'wrapup' : 'review'; this.app.changed(pid, iid); }, rawLog
          });
          model = await this.app.opencode.modelOf(r.sessionId, copy);
          if (!model) this.log.warn('review.model unknown !' + iid);
        } finally {
          this.app.mcp.close(token);
        }
        check();
        conclusion = job.findings.length ? 'issues' : 'pass';
        this.setStep(job, 7);
      }

      // 7. save report
      const findings = sortFindings(job.findings).map((f, i) => Object.assign({ id: 'f' + (i + 1) }, f));
      job.objN = findings.length;
      job.obj = findings.length;
      const now = Date.now();
      job.times[6] = now - job.stepStartedAt;
      const report = {
        schemaVersion: 1,
        id: newId('rp'),
        attemptId: job.id,
        projectId: pid,
        projectPath: project.path,
        iid,
        mrTitle: mr.title,
        mrWebUrl: mr.web_url || null,
        mrUpdatedAt: mr.updated_at,
        sourceBranch: mr.source_branch,
        targetBranch: mr.target_branch,
        sourceSha: srcSha,
        targetSha: tgtSha,
        mergeBase: base,
        model: conclusion === 'empty' ? null : (model || '未知'),
        rules: ruleSel.used,
        skippedRules: ruleSel.skipped,
        changedFiles: included.map((f) => ({ path: f.path, add: f.add, del: f.del, status: f.status })),
        excluded,
        conclusion,
        findings,
        startedAt: job.startedAt,
        createdAt: now,
        durationMs: now - job.startedAt,
        stepTimes: job.times.slice()
      };
      try {
        this.store.saveReport(pid, iid, report);
        this.store.appendAttempt(pid, iid, { t: 'ended', id: job.id, at: now, status: 'completed', reportId: report.id, conclusion, steps: job.times.slice() });
      } catch (e) {
        throw new ReviewFailure({ step: 7, kind: 'ai', code: 'SAVE_FAILED', title: '步骤 7/7 保存报告失败', reason: '写入数据目录失败：' + e.message, next: '检查磁盘空间和数据目录权限后重新检视。' });
      }
      this.log.info('review.done !' + iid + ' project=' + pid + ' result=' + conclusion + ' findings=' + findings.length + ' model=' + (report.model || '-') + ' duration=' + Math.round(report.durationMs / 1000) + 's');
      this.app.notify('!' + iid + ' 检视完成 · ' + (conclusion === 'issues' ? '发现 ' + findings.length + ' 条意见' : conclusion === 'pass' ? '未发现问题' : '无可检视的变更'));
    } catch (e) {
      const stopped = e instanceof Stopped || signal.aborted;
      if (stopped) {
        job.stopNote = '正在停止 · 清理临时目录';
        this.app.changed(pid, iid);
        await rmrf(work).catch(() => {});
        this.store.appendAttempt(pid, iid, { t: 'ended', id: job.id, at: Date.now(), status: 'stopped', stopReason: job.stopReason || '已主动停止', steps: job.times.slice() });
        this.log.info('review.stopped !' + iid + ' project=' + pid + ' reason=' + (job.stopReason || 'user'));
        if (job.stopReason !== 'ReviewX 关闭时中断' && job.stopReason !== '项目已移除') this.app.notify('!' + iid + ' 已停止');
      } else {
        const f = e instanceof ReviewFailure ? e : new ReviewFailure({ step: job.step || 1, kind: job.step >= 6 ? 'ai' : 'step', code: 'INTERNAL', title: '步骤 ' + (job.step || 1) + '/7 ' + STEPS[(job.step || 1) - 1] + '失败', reason: 'ReviewX 内部错误：' + e.message, next: '查看会话日志后重新检视。', detail: e.stack });
        if (job.step && job.stepStartedAt) job.times[job.step - 1] = null;
        const info = f.toJSON();
        info.completedSteps = Math.max(0, f.step - 1);
        info.findingsSubmitted = job.findings.length;
        this.store.appendAttempt(pid, iid, { t: 'ended', id: job.id, at: Date.now(), status: 'failed', failure: info, steps: job.times.slice() });
        this.log.error('review.failed !' + iid + ' project=' + pid + ' step=' + f.step + '/7 code=' + f.code + ' reason=' + f.reason + ' queue=' + (f.stopsQueue ? 'stopped' : 'continue') + (f.detail ? '\n' + redact(f.detail) : ''));
        if (raw.length) this.log.error('review.raw_output !' + iid + '\n' + redact(raw.join('\n')).slice(0, 200000));
        if (f.stopsQueue) {
          for (const j of this.jobs.slice()) if (j !== job && j.status === 'queued') this.cancel(j.pid, j.iid, '队列已停止：!' + iid + ' 检视失败');
        }
        this.app.notify('!' + iid + ' 检视失败 · ' + f.title.replace(/^步骤 \d\/7 /, ''));
      }
    } finally {
      await rmrf(work).catch((err) => this.log.warn('review.cleanup failed dir=' + work + ' ' + err.message));
    }
  }

  buildPrompt({ mr, commits, included, excluded, rules, lang }) {
    const L = [];
    L.push('# ReviewX 检视任务', '');
    L.push('你是代码检视助手，对一个 CodeHub MR 做只读检视。当前工作目录是该 MR 源分支的完整代码（检视副本），只能读取，不能修改。', '');
    L.push('## MR', '- 标题：' + mr.title, '- 分支：' + mr.source_branch + ' → ' + mr.target_branch, '');
    L.push('## 变更范围内的提交说明');
    if (!commits.length) L.push('（无）');
    for (const c of commits.slice(0, 200)) {
      L.push('- ' + c.sha + ' ' + c.subject);
      if (c.body) L.push(c.body.split('\n').slice(0, 20).map((x) => '  ' + x).join('\n'));
    }
    L.push('');
    L.push('## 变更文件（' + included.length + ' 个）');
    L.push('每个文件的差异（按函数边界附带上下文）已写成只读文件，放在 `.reviewx-diff/` 下，路径与源文件对应：', '');
    L.push('| 文件 | 增 | 删 | 差异文件 |', '| --- | --- | --- | --- |');
    for (const f of included) L.push('| ' + f.path + ' | +' + f.add + ' | -' + f.del + ' | ' + f.diffFiles.join('<br>') + ' |');
    L.push('');
    if (excluded.length) L.push('另有 ' + excluded.length + ' 个文件（锁文件、图片、压缩产物、二进制等）已被排除，不需要也不能读取。', '');
    L.push('## 本次使用的规则');
    if (!rules.length) L.push('（本次没有适用的规则，按通用标准检视）');
    for (const r of rules) {
      L.push('', '### 规则：' + r.name + (r.files ? '（适用文件：' + r.files + '）' : ''), '', r.content.trim());
    }
    L.push('');
    L.push('## 工作方式',
      '1. 用 read 工具逐个读取上面列出的**全部**差异文件，一个都不能漏。',
      '2. 需要时查阅检视副本中的相关源码。每次查阅都要对应差异中的一个具体疑点，例如被修改代码的调用方和被调用方、引用的定义、类型、样式和配置、相关测试；同一轮中一次发出多个查阅，避免逐个查阅拉长轮数。',
      '3. 不要浏览目录、通读无关文件，也不要为确认第三方库或框架的行为去查找其源码。',
      '4. 每核实一个问题，立即调用 reviewx_report_finding 提交一条意见；校验不通过时按返回的错误修正后重新提交。',
      '5. 全部差异文件读完、所有意见提交后，调用 reviewx_finish_review 结束检视。没有发现问题时也要调用。',
      '6. 只有通过工具提交的意见才会被采信；不要在回复里写 JSON 或 Markdown 形式的意见。', '');
    L.push('## 判断原则',
      '- 只报告本次变更引入的问题。每条意见须能指出引入问题的修改，有可见代码作为证据（evidence 写明「文件:行号」及对应代码）。',
      '- 说明位置、触发条件和后果，并给出可执行的修改建议。',
      '- 上下文不足以确认时不要报告，不要臆造缺陷。',
      '- 不设最低严重程度和数量上限，fatal、major、minor、suggestion 四级意见全部提交。',
      '- severity：fatal 会导致数据损坏、安全漏洞或服务不可用；major 功能错误或明显缺陷；minor 局部问题或边界情况；suggestion 可维护性等改进建议。',
      '- rule：意见属于上面某条规则时，填写该规则名；不属于任何规则时留空。', '');
    L.push('## 输出语言', '意见用' + lang + '书写；代码、标识符、文件路径和错误信息保持原文。');
    return L.join('\n') + '\n';
  }

  // Snapshot of queue/progress for the UI.
  view() {
    return this.jobs.map((j) => ({
      id: j.id, pid: j.pid, iid: j.iid, title: j.title, status: j.status, queuedAt: j.queuedAt, startedAt: j.startedAt,
      step: j.step, stepName: j.step ? STEPS[j.step - 1] : '', stepStartedAt: j.stepStartedAt, times: j.times,
      obj: j.obj || 0, objN: j.objN || 0,
      diffRead: j.tracker ? j.tracker.read.size : 0, diffN: j.diffN || 0, findings: j.findings.length,
      phase: j.tracker && j.tracker.wrapUp ? 'wrapup' : (j.phase || null),
      stopNote: j.stopNote || null,
      limitMs: this.app.cfg.opencodeTimeoutMinutes * 60000
    }));
  }
}

module.exports = { ReviewEngine, STEPS, pickCloneUrl, splitDiff, SEV_RANK };
