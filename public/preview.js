'use strict';
/* ReviewX preview mode (/preview): an in-browser stand-in for the ReviewX
 * server. It answers the same API calls with the same data shapes and pushes
 * the same live events, using sample data. Nothing leaves this page: no
 * CodeHub, Git, OpenCode or local files are touched. Reload to start over. */
(function () {
  const STEPS = ['读取 MR 信息', '拉取源分支', '拉取目标分支', '校验 MR 未变化', '生成变更快照', 'OpenCode 检视', '保存报告与意见'];
  const STEP_MS = [1200, 2200, 1600, 900, 0, 14000, 700];
  const FILE_MS = 220;
  const LIMIT_MS = 13 * 60000;
  const MODEL = 'deepseek/deepseek-chat（示例）';
  const SEV_RANK = { fatal: 0, major: 1, minor: 2, suggestion: 3 };
  const SENT = ['published', 'manual', 'failed', 'unknown', 'sending'];
  const DATA_DIR = 'C:\\Users\\dev\\AppData\\Local\\ReviewX';
  const MIN = 60000;

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const pad = (n) => String(n).padStart(2, '0');
  const hms = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  let seq = 0;
  const nid = (p) => p + Date.now().toString(36) + (seq++).toString(36);

  function lang(p) {
    const ext = (p.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
    return ({ ts: 'typescript', tsx: 'tsx', js: 'js', go: 'go', java: 'java', py: 'python' })[ext] || ext;
  }

  // Compact finding definition → the structured shape the server stores.
  function F(severity, rule, title, summary, loc, code, consequence, scope, trigger, solution, fix, prevention, tags) {
    const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(loc || '');
    const p = loc && loc.indexOf('未定位') < 0 ? m[1] : '';
    return {
      severity, rule: rule || '', title, summary, tags: tags || (rule ? [rule] : []),
      location: { path: p, start_line: m && m[2] ? Number(m[2]) : null, end_line: m && m[3] ? Number(m[3]) : (m && m[2] ? Number(m[2]) : null) },
      related_code: code ? { language: lang(p), code } : null,
      impact: { consequence, scope, trigger },
      solutions: [{ description: solution, code: fix ? { language: lang(p), code: fix } : null }],
      prevention: prevention || []
    };
  }

  const LIB = {
    scopeCheck: F('fatal', '安全', '报告读取缺少项目范围校验', 'readReport 收到报告 ID 后直接返回内容，没有核对报告是否属于当前项目，跨项目请求可以读到其他项目的检视报告。', 'src/services/report-loader.ts:42-49', 'export async function readReport(id: string) {\n  const report = await store.get(id);\n  return report.body;\n}', '可跨项目读取检视报告', '所有读取 /api/reports 的页面', '请求中带入其他项目的报告 ID', '返回正文前核对 report.projectId 与请求的项目一致，不一致时按「不存在」处理。', 'if (report.projectId !== projectId) {\n  throw new NotFoundError("Report not found");\n}', ['按资源读取的接口统一经过项目范围校验', '为跨项目访问补充集成测试']),
    cycle: F('fatal', '正确性', '跨文件引用解析遇到循环依赖时无限递归', 'resolveRefs 递归展开引用时没有记录已访问节点，A → B → A 的循环会耗尽调用栈。', 'src/analysis/xref.ts:118-131', 'function resolveRefs(node: Node): Ref[] {\n  return node.refs.flatMap(r => resolveRefs(lookup(r)));\n}', '检视进程栈溢出退出', '存在循环引用的仓库', '两个模块互相 import', '引入 visited 集合，已访问的节点直接返回空结果。', '', ['递归遍历统一使用带 visited 的工具函数']),
    emptyConf: F('major', '正确性', '空配置会中断后续任务', '配置文件存在但内容为空时，解析器仍读取首个节点，异常没有转为可处理的结果，导致后续任务提前结束。', 'src/config/parse.ts:18-26', 'const root = yaml.parse(source);\nreturn root.entries[0];', '后续检视任务全部跳过', '新建项目的默认配置', '配置文件为空或只有注释', '先处理空输入，返回空结果并附带警告。', 'if (!source.trim()) {\n  return { entries: [], warnings: ["配置为空"] };\n}', ['为解析器补充空文件与仅注释文件的用例']),
    lineMap: F('major', '正确性', '截断调用方上下文后行号映射错位', '上下文超过上限被截断后，lineMap 仍按原始偏移计算，意见中的行号会整体错位。', 'src/analysis/context.ts:77-90', 'const snippet = lines.slice(start, start + LIMIT);\nreturn { snippet, lineMap: buildMap(lines) };', '意见定位到错误的行', '大文件中的意见', '单段上下文超过 400 行', '截断后基于 snippet 重新构建 lineMap，并保留起始行偏移。', '', ['对截断路径增加行号断言']),
    pending: F('minor', '', '请求失败后按钮仍显示「提交中」', '请求成功时会清除 pending，失败分支只更新错误信息，按钮会一直停在提交中。', 'app/components/review.tsx:210-214', '', '用户无法再次提交', '发起检视按钮', '网络请求失败', '在 finally 中统一清除 pending 状态。', '', ['异步按钮统一使用同一个提交状态 Hook']),
    cycleTest: F('suggestion', '可维护性', '为循环引用补充回归测试', '本次修改涉及引用解析的边界条件，现有测试没有覆盖循环引用和自引用。', '', '', '回归难以及时发现', 'tests/analysis', '后续重构引用解析', '新增 A → B → A 与 A → A 两个用例。', '', ['边界条件修复须附带回归测试']),
    cacheKey: F('major', '性能', '缓存键未包含目标分支', '代码快照缓存只按源分支和提交号生成键，目标分支变化后仍命中旧快照，差异基于错误的基线。', 'src/cache/snapshot-key.ts:12-18', 'return `${mr.sourceBranch}:${mr.headSha}`;', '检视基于过期的目标分支', '所有复用缓存的检视', 'MR 修改目标分支或目标分支有新提交', '缓存键加入目标分支名与目标提交号。', 'return `${mr.sourceBranch}:${mr.headSha}:${mr.targetBranch}:${mr.baseSha}`;', ['缓存键须覆盖所有影响结果的输入']),
    logBody: F('minor', '安全', '日志打印完整请求体', '调用 CodeHub CLI 失败时把完整请求体写入诊断日志，其中包含评论正文与访问令牌头。', 'src/codehub/client.ts:88', 'log.error("publish failed", { request });', '诊断日志泄露令牌', '会话日志文件', '发布评论失败', '只记录请求方法、路径与状态码，令牌头统一脱敏。', 'log.error("publish failed", { method: req.method, path: req.path, status });', ['日志字段走白名单', '为脱敏逻辑补单元测试']),
    truncate: F('suggestion', '可维护性', '抽取上下文截断工具函数', '三处调用方各自实现了「超过上限截断并保留首尾」的逻辑，规则略有不同。', 'src/analysis/context.ts', '', '截断行为不一致', '上下文构建', '修改截断上限', '抽取 truncateContext(lines, limit) 并统一调用。', '', ['重复逻辑超过两处即抽取']),
    schema: F('major', '正确性', '结构化字段缺少 schema 版本号', '报告 JSON 没有记录 schema 版本，后续字段调整后旧报告无法判断如何解析。', 'src/shared/types.ts:12-30', 'export interface Report {\n  findings: Finding[];\n}', '升级后旧报告解析失败', '所有历史报告', '修改 Finding 字段', '在报告根节点增加 schemaVersion，读取时按版本迁移。', '', ['数据格式变更须附带迁移用例']),
    hunk: F('major', '正确性', '合并差异块时丢失文件末尾换行', 'mergeHunks 拼接相邻差异块时去掉了最后一行的换行，生成的快照与 CodeHub 显示不一致。', 'src/diff/merge.ts:61-74', 'return hunks.map(h => h.lines.join("\\n")).join("");', '快照与 MR 页面不一致', '末尾无换行的文件', '相邻差异块合并', '拼接时保留每个差异块原有的结尾换行。', 'return hunks.map(h => h.lines.join("\\n") + h.eol).join("");', ['差异快照与 git diff 输出逐字节比对']),
    hunkTest: F('suggestion', '可维护性', '为 hunk 解析补充属性测试', '解析器只覆盖了手写样例，缺少随机生成差异的属性测试。', 'tests/diff/parse.test.ts', '', '边界问题难以发现', 'diff 解析', '后续重构', '用随机生成的补丁验证「解析后再渲染」与原文一致。', '', ['解析器改动须附带属性测试']),
    abort: F('minor', '并发安全', '取消信号没有传递到 git 子进程', '停止任务时只终止了 OpenCode，正在运行的 git fetch 会继续占用网络直到超时。', 'src/queue/process.ts:88-97', 'controller.abort();\nopencode.kill();', '停止后仍占用网络', '步骤 2–3 中停止', '在拉取代码时点击停止', '用同一个 AbortSignal 终止整个子进程树。', '', ['子进程统一挂到任务的进程树上']),
    unlink: F('major', '性能', '快照清理逐个删除文件', '临时目录包含上万个文件时，逐个 unlink 让清理耗时超过 1 分钟。', 'src/server/paths.ts:70-82', 'for (const f of files) await fs.unlink(f);', '停止任务很慢', '大型仓库', '停止或完成检视', '改为 fs.rm(dir, { recursive: true })。', 'await fs.rm(dir, { recursive: true, force: true });', ['目录清理统一用递归删除']),
    recon: F('fatal', '正确性', '重复对账时未加锁', '两个对账任务同时运行时会各自写入同一批流水，导致金额重复入账。', 'src/recon/job.ts:40-58', 'const rows = await fetchPending();\nawait writeLedger(rows);', '重复入账', '所有对账批次', '定时任务与手动触发重叠', '按批次号获取锁，拿不到锁时直接返回。', 'await withLock(`recon:${batchId}`, () => writeLedger(rows));', ['幂等任务统一要求批次锁']),
    reconLog: F('minor', '可维护性', '对账日志缺少 traceId', '出错时无法把日志与具体批次关联。', 'src/recon/job.ts:12', '', '排障困难', '对账日志', '任意失败', '在日志上下文中加入 batchId 与 traceId。', '', ['任务日志统一带上下文字段']),
    refund: F('major', '金额校验', '退款金额没有与已退金额比对', '退款接口只校验了单次金额不超过实付，多次部分退款累计后可以超过实付金额。', 'src/refund/service.ts:31-44', 'if (req.amount > order.paid) throw new Error("超额退款");\nawait createRefund(order.id, req.amount);', '累计退款超过实付', '所有支持部分退款的订单', '同一订单多次发起部分退款', '比对 req.amount + order.refunded 与 order.paid。', 'if (req.amount + order.refunded > order.paid) {\n  throw new Error("超额退款");\n}', ['金额入参必须与订单实付、已退金额比对'])
  };

  // What a review of each MR produces in the preview.
  const PLANS = {
    '101/401': { files: 9, findings: ['emptyConf', 'pending'] },
    '101/402': { files: 14, findings: ['abort'] },
    '101/403': { files: 48, findings: ['hunk', 'hunkTest'] },
    '101/404': { files: 12, findings: ['scopeCheck', 'lineMap'] },
    '101/405': { files: 21, findings: [] },
    '101/406': { files: 30, findings: ['unlink'] },
    '101/407': { files: 0, findings: [], excluded: [['pnpm-lock.yaml', '锁文件'], ['public/hero.png', '图片'], ['public/hero@2x.png', '图片'], ['public/icons.svg', '图片']] },
    '101/408': { files: 6, fail: 'gitAuth' },
    '202/601': { files: 7, findings: [] },
    '202/603': { files: 5, findings: ['pending'] },
    '318/88': { files: 3, findings: [] },
    '318/91': { files: 11, findings: ['recon', 'reconLog'] },
    '318/95': { files: 8, findings: ['refund'] }
  };

  const FAILS = {
    gitAuth: { step: 3, kind: 'env', code: 'GIT_AUTH', title: '步骤 3/7 拉取目标分支失败', reason: 'Git 认证失败', next: '在终端用 git 拉取一次该仓库，确认本机凭据管理器或 SSH 密钥可用后重新检视。', detail: "fatal: Authentication failed for 'https://codehub.example.com/platform/review-engine.git/'（预览示例）" },
    timeout: { step: 6, kind: 'ai', code: 'OPENCODE_TIMEOUT', title: '步骤 6/7 超时', reason: '步骤 6 总时长超过「OpenCode 超时」（13 分钟）', next: '调大配置项「OpenCode 超时」（opencodeTimeoutMinutes）后重启 ReviewX，再重新检视。', detail: 'elapsed=780s' }
  };

  const EXCL = [{ path: 'pnpm-lock.yaml', reason: '锁文件' }, { path: 'public/logo.svg', reason: '图片' }, { path: 'public/fonts/inter.woff2', reason: '字体' }];

  const RULE_BODY = {
    security: '## 检查要点\n- 外部输入进入 SQL、命令或文件路径前必须校验\n- 按 ID 读取的资源必须核对所属项目\n- 日志与报告中不得出现凭据\n\n## 反例\n```ts\nreturn store.get(id).body;\n```\n\n## 正例\n```ts\nif (report.projectId !== projectId) throw notFound();\n```\n',
    correctness: '## 检查要点\n- 边界条件：空输入、循环引用、超长输入\n- 错误分支必须释放资源与状态\n\n## 反例\n```ts\nreturn root.entries[0];\n```\n',
    performance: '## 检查要点\n- 循环内的 I/O 与网络请求\n- 大目录的逐个文件操作\n',
    maintainability: '## 检查要点\n- 命名表达单位与含义\n- 修复边界条件须附带回归测试\n'
  };

  let st; let listeners = []; let timer = null;
  // Bumped on every reset; callbacks scheduled for an older session do nothing.
  let gen = 0;
  function later(fn, ms) { const g = gen; return setTimeout(() => { if (g === gen) fn(); }, ms); }

  // ---------- seed data ----------
  function seed() {
    const now = Date.now();
    const s = {
      rev: 1, mrRev: {},
      projects: [
        { id: '101', path: 'platform/review-engine', webUrl: 'https://codehub.example.com/platform/review-engine', order: 1, removed: false },
        { id: '202', path: 'apps/internal/tools/task-console', webUrl: 'https://codehub.example.com/apps/internal/tools/task-console', order: 2, removed: false },
        { id: '318', path: 'finance/payment-service', webUrl: 'https://codehub.example.com/finance/payment-service', order: 3, removed: false }
      ],
      // What "CodeHub" would return for each project.
      remote: {
        101: [
          mr('401', '补充配置校验', 'feat/config-validate', 'zhang.san', 7 * 60 * MIN),
          mr('402', '为检视队列增加取消信号，确保停止后能清理临时工作区并及时释放子进程持有的文件锁', 'feat/queue-abort', 'li.si', 6.8 * 60 * MIN),
          mr('403', '重构差异解析器', 'refactor/diff-parser', 'wang.wu', 6.6 * 60 * MIN),
          mr('404', '修复跨文件引用分析中的边界条件，保留必要的调用方上下文', 'fix/xref-boundary', 'li.si', 40 * MIN),
          mr('405', '整理结构化检视结果与证据引用', 'feat/structured-findings', 'zhao.liu', 6.3 * 60 * MIN),
          mr('406', '优化仓库快照清理', 'perf/snapshot-cleanup', 'zhang.san', 6.2 * 60 * MIN),
          mr('407', '升级图片资源与锁文件', 'chore/assets', 'wang.wu', 6 * 60 * MIN),
          mr('408', '迁移到新的鉴权中间件', 'feat/auth-middleware', 'chen.qi', 5 * 60 * MIN)
        ],
        202: [
          mr('601', '完善报告加载失败时的诊断', 'feat/report-diag', 'zhao.liu', 7.5 * 60 * MIN),
          mr('603', '支持逐条发送检视意见', 'feat/send-one', 'zhao.liu', 7.2 * 60 * MIN)
        ],
        318: [
          mr('88', '升级 Netty 到 4.1.114', 'chore/netty-4.1.114', 'sun.ba', 3 * 60 * MIN),
          mr('91', '对账任务改造为幂等', 'feat/recon-idempotent', 'zhou.jiu', 2 * 60 * MIN),
          mr('95', '退款支持多次部分退款', 'feat/partial-refund', 'wu.shi', 50 * MIN)
        ]
      },
      fetched: {}, fetchState: {}, failOnce: { 202: true },
      fetch: { active: false, total: 3, done: 3, ok: 2, failed: 1, summary: '已更新 2/3 个项目，1 个失败', finishedAt: now - 25 * MIN },
      attempts: {}, reports: {}, records: {},
      queue: [], sending: null, removing: {},
      rules: [], logs: []
    };
    s.fetched[101] = { at: now - 25 * MIN, mrs: clone(s.remote[101]) };
    s.fetched[202] = { at: now - 3 * 60 * MIN, mrs: clone(s.remote[202]) };
    s.fetchState = { 101: { status: 'updated', lastSuccessAt: now - 25 * MIN }, 202: { status: 'failed', error: '网络不可用', lastSuccessAt: now - 3 * 60 * MIN }, 318: { status: 'never' } };
    // The MR was updated after its report: stale.
    s.fetched[101].mrs.find((m) => m.iid === '404').updatedAt = iso(40 * MIN);

    const rep = (key, ago, conclusion, defs, extra) => {
      const id = nid('rp');
      const findings = sortF(defs.map((k) => clone(LIB[k]))).map((f, i) => Object.assign({ id: 'f' + (i + 1) }, f));
      const mrInfo = s.remote[key.split('/')[0]].find((m) => m.iid === key.split('/')[1]);
      const r = Object.assign({ id, createdAt: now - ago, conclusion, model: conclusion === 'empty' ? null : MODEL, sourceSha: hex(), mrUpdatedAt: mrInfo.updatedAt, durationMs: 9 * MIN + 5000, rules: ['安全', '正确性', '性能', '可维护性'], skippedRules: [], excluded: EXCL, changedFiles: Math.max(1, defs.length * 4), findings }, extra || {});
      (s.reports[key] = s.reports[key] || []).unshift(r);
      attempt(s, key, { status: 'completed', reportId: id, endedAt: r.createdAt });
      return r;
    };
    const rec = (key, r, n, a, more) => (s.records[key] = s.records[key] || []).push(Object.assign({ a, reportId: r.id, fid: 'f' + n, at: now - 20 * MIN }, more || {}));

    // !404: an archived report and a newer one with every finding state.
    const old = rep('101/404', 22 * 60 * MIN, 'issues', ['scopeCheck', 'emptyConf', 'cacheKey', 'logBody', 'truncate'], { mrUpdatedAt: iso(23 * 60 * MIN) });
    rec('101/404', old, 2, 'result', { result: 'published' }); rec('101/404', old, 3, 'result', { result: 'published' }); rec('101/404', old, 4, 'dismiss');
    const r404 = rep('101/404', 3 * 60 * MIN, 'issues', ['scopeCheck', 'cycle', 'emptyConf', 'lineMap', 'pending', 'cycleTest'], { mrUpdatedAt: iso(4 * 60 * MIN), durationMs: 14 * MIN + 22000 });
    rec('101/404', r404, 2, 'result', { result: 'unknown', reason: '发送结果未知' });
    rec('101/404', r404, 3, 'result', { result: 'published' });
    rec('101/404', r404, 4, 'result', { result: 'failed', reason: '网络不可用' });
    rec('101/404', r404, 5, 'dismiss');
    const r405 = rep('101/405', 2 * 60 * MIN, 'issues', ['schema', 'logBody', 'truncate']);
    rec('101/405', r405, 1, 'result', { result: 'published' }); rec('101/405', r405, 2, 'dismiss'); rec('101/405', r405, 3, 'result', { result: 'published' });
    rep('101/407', 2.5 * 60 * MIN, 'empty', [], { excluded: PLANS['101/407'].excluded.map((x) => ({ path: x[0], reason: x[1] })), durationMs: 9000, changedFiles: 0, rules: [] });
    attempt(s, '101/406', { status: 'failed', failure: Object.assign({ completedSteps: 5, findingsSubmitted: 0, stopsQueue: true, unread: null }, FAILS.timeout), endedAt: now - 90 * MIN });
    rep('202/601', 4 * 60 * MIN, 'pass', [], { durationMs: 6 * MIN + 12000 });
    attempt(s, '202/603', { status: 'stopped', stopReason: 'ReviewX 关闭时中断', endedAt: now - 5 * 60 * MIN });

    // A review already running and one waiting behind it.
    s.queue.push(job(s, '101', '403', { status: 'running', step: 5, startedAt: now - 5200, stepStartedAt: now - 1500, times: [1100, 2100, 1500, 800], obj: 7 }));
    s.queue.push(job(s, '101', '402', {}));

    s.rules = [
      rule('global/security.md', 'global', '安全', '', true, true, RULE_BODY.security, { hits: 22, sent: 17, dismissed: 5 }),
      rule('global/correctness.md', 'global', '正确性', '', true, true, RULE_BODY.correctness, { hits: 41, sent: 29, dismissed: 12 }),
      rule('global/performance.md', 'global', '性能', '', true, true, RULE_BODY.performance, { hits: 9, sent: 4, dismissed: 5 }),
      rule('global/maintainability.md', 'global', '可维护性', '', true, true, RULE_BODY.maintainability, { hits: 34, sent: 6, dismissed: 28 }),
      rule('global/sql-concat.md', 'global', 'SQL 拼接', 'src/db/**', false, false, '## 检查要点\n- 禁止字符串拼接 SQL，一律使用参数化查询\n', { hits: 0, sent: 0, dismissed: 0 }),
      rule('global/parser-empty-input.md', 'global', '解析器须处理空输入', 'src/config/**', false, false, '## 检查要点\n- 解析器必须先处理空输入与仅注释输入\n- 异常需转为可处理的结果，不能中断后续任务\n\n## 反例\n```ts\nconst root = yaml.parse(source);\nreturn root.entries[0];\n```\n', { hits: 0, sent: 0, dismissed: 0 }, { draft: true, source: '来自 !404「空配置会中断后续任务」' }),
      rule('projects/101/git-timeout.md', '101', 'Git 子进程超时', 'src/server/git.ts', true, false, '## 检查要点\n- 每个 git 子进程都必须有超时与取消信号\n', { hits: 3, sent: 3, dismissed: 0 }),
      rule('projects/101/concurrency.md', '101', '并发安全', 'src/queue/**', true, false, '## 检查要点\n- 共享状态的读改写必须加锁或串行化\n', { hits: 5, sent: 4, dismissed: 1 }),
      rule('projects/101/naming-old.md', '101', 'naming-old', '', false, false, '这是一份缺少元信息块的旧规则文件。\n', { hits: 0, sent: 0, dismissed: 0 }, { error: '缺少开头的 --- 元信息块' }),
      rule('projects/318/amount.md', '318', '金额校验', 'src/refund/**', true, false, '## 检查要点\n- 金额入参必须与订单实付、已退金额比对\n', { hits: 0, sent: 0, dismissed: 0 })
    ];

    const L = (agoS, lvl, msg) => s.logs.push({ t: hms(new Date(now - agoS * 1000)), at: now - agoS * 1000, lvl, msg });
    L(5, 'INFO', 'review.start !403 project=101');
    L(1500, 'INFO', 'mr.fetch done ok=2 failed=1');
    L(1501, 'WARN', 'mr.fetch project=202 failed reason=NETWORK_ERROR kept_previous=' + hms(new Date(now - 3 * 60 * MIN)));
    L(1502, 'INFO', 'mr.fetch project=101 updated open=8');
    L(1503, 'INFO', 'mr.fetch start projects=3 concurrency=6');
    L(5400, 'ERROR', 'review.failed !406 project=101 step=6/7 code=OPENCODE_TIMEOUT reason=步骤 6 总时长超过「OpenCode 超时」（13 分钟） queue=stopped');
    L(7200, 'WARN', 'comment.publish !404 f4 result=failed reason=网络不可用');
    L(7300, 'WARN', 'comment.publish !404 f2 result=unknown reason=发送结果未知');
    L(12000, 'INFO', 'server.start addr=127.0.0.1:17080 data=' + DATA_DIR + ' version=1.0.0（预览）');
    s.logs.sort((a, b) => a.at - b.at);
    return s;
  }

  function mr(iid, title, branch, author, agoMs) {
    return { iid, title, state: 'opened', isDraft: false, author, sourceBranch: branch, targetBranch: 'main', updatedAt: iso(agoMs), createdAt: iso(agoMs + 3 * 60 * MIN), webUrl: 'https://codehub.example.com/merge_requests/' + iid };
  }
  function hex() { let x = ''; for (let i = 0; i < 40; i++) x += '0123456789abcdef'[Math.floor(Math.random() * 16)]; return x; }
  function rule(id, scope, name, files, enabled, builtin, body, base, extra) {
    return Object.assign({ id, file: id, scope, name, files, enabled, builtin, draft: false, source: '', body, error: null, base }, extra || {});
  }
  function attempt(s, key, a) {
    const list = s.attempts[key] = s.attempts[key] || [];
    const rec = Object.assign({ id: nid('rv'), queuedAt: (a.endedAt || Date.now()) - 60000 }, a);
    list.unshift(rec);
    return rec;
  }
  function job(s, pid, iid, extra) {
    const key = pid + '/' + iid;
    const m = (s.fetched[pid] && s.fetched[pid].mrs.find((x) => x.iid === iid)) || {};
    const plan = PLANS[key] || { files: 4 + (Number(iid) % 9), findings: [['emptyConf', 'pending'], ['cacheKey'], [], ['logBody', 'truncate']][Number(iid) % 4] };
    const j = Object.assign({ id: nid('rv'), pid, iid, title: m.title || '!' + iid, status: 'queued', queuedAt: Date.now(), step: 0, times: [], obj: 0, objN: 0, diffRead: 0, diffN: 0, findings: 0, phase: null, stopNote: null, limitMs: LIMIT_MS, plan, found: [] }, extra || {});
    if (j.status === 'running') { j.objN = plan.files; j.diffN = plan.files; }
    const a = attempt(s, key, { status: j.status === 'queued' ? 'queued' : 'running', queuedAt: j.queuedAt });
    j.id = a.id;
    return j;
  }

  function sortF(list) {
    return list.slice().sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || (a.location.path || '\uffff').localeCompare(b.location.path || '\uffff') || (a.location.start_line || 0) - (b.location.start_line || 0));
  }

  // ---------- events ----------
  let emitPending = false;
  function changed(key) {
    st.rev++;
    if (key) st.mrRev[key] = st.rev;
    if (emitPending) return;
    emitPending = true;
    setTimeout(() => { emitPending = false; emit('state', snapshot()); }, 40);
  }
  function emit(type, data) { for (const l of listeners) { try { l(type, clone(data)); } catch (e) { console.error(e); } } }
  function toast(text) { emit('toast', { text }); }
  function log(lvl, msg) { const d = new Date(); const e = { t: hms(d), at: d.getTime(), lvl, msg }; st.logs.push(e); if (st.logs.length > 500) st.logs.shift(); emit('log', e); }

  // ---------- derived views (same shapes as src/app.js) ----------
  const active = () => st.projects.filter((p) => !p.removed).sort((a, b) => a.order - b.order);
  const project = (pid) => active().find((p) => p.id === pid) || null;
  const openMrs = (pid) => (st.fetched[pid] ? st.fetched[pid].mrs : []);
  const openMr = (pid, iid) => (project(pid) ? openMrs(pid).find((m) => m.iid === iid) || null : null);
  const shortName = (p) => p.split('/').pop();
  const folderOf = (p) => { const a = p.split('/'); a.pop(); return a.join(' / ') || '—'; };

  function states(key, reportId) {
    const out = {};
    for (const r of st.records[key] || []) {
      if (r.reportId !== reportId) continue;
      if (r.a === 'dismiss') out[r.fid] = { state: 'dismissed', at: r.at };
      else if (r.a === 'undo') out[r.fid] = { state: 'pending', at: r.at };
      else if (r.a === 'sending') out[r.fid] = { state: 'sending', at: r.at };
      else if (r.a === 'result') out[r.fid] = { state: r.result, at: r.at, reason: r.reason };
      else if (r.a === 'mark') out[r.fid] = r.result === 'published' ? { state: 'manual', at: r.at } : { state: 'failed', at: r.at, reason: '已核对：确认未发布' };
    }
    return out;
  }
  function stateOf(stt, key, reportId, fid) {
    if (st.sending && st.sending.key === key && st.sending.reportId === reportId && st.sending.fid === fid) return { state: 'sending' };
    return stt[fid] || { state: 'pending' };
  }
  function counts(key) {
    const latest = (st.reports[key] || [])[0];
    let pending = 0; let verify = 0;
    if (latest && latest.conclusion === 'issues') {
      const stt = states(key, latest.id);
      for (const f of latest.findings) { const x = stateOf(stt, key, latest.id, f.id).state; if (x === 'pending') pending++; if (x === 'failed' || x === 'unknown') verify++; }
    }
    return { pending, verify, total: latest ? latest.findings.length : 0 };
  }
  const lastAttempt = (key) => (st.attempts[key] || []).find((a) => ['failed', 'stopped', 'completed'].includes(a.status)) || null;
  const jobView = (j) => { const o = Object.assign({}, j); delete o.plan; delete o.found; delete o.stopAt; return o; };

  function snapshot() {
    const projects = active().map((p) => ({ id: p.id, path: p.path, short: shortName(p.path), folder: folderOf(p.path), webUrl: p.webUrl, fetch: st.fetchState[p.id] || { status: 'never' }, removing: Boolean(st.removing[p.id]) }));
    const mrs = [];
    for (const p of projects) {
      for (const m of openMrs(p.id)) {
        const key = p.id + '/' + m.iid;
        const j = st.queue.find((x) => x.pid === p.id && x.iid === m.iid);
        const latest = (st.reports[key] || [])[0];
        const la = lastAttempt(key);
        const c = counts(key);
        let state = 'unreviewed';
        if (j) state = j.status === 'queued' ? 'queued' : j.status === 'stopping' ? 'stopping' : 'running';
        else if (latest) state = 'done';
        else if (la) state = la.status;
        mrs.push({
          pid: p.id, iid: m.iid, title: m.title, updatedAt: m.updatedAt, webUrl: m.webUrl, author: m.author, sourceBranch: m.sourceBranch, targetBranch: m.targetBranch, isDraft: m.isDraft,
          state, conclusion: latest ? latest.conclusion : null, pending: c.pending, verify: c.verify, total: c.total,
          stale: Boolean(latest && latest.mrUpdatedAt !== m.updatedAt), reportAt: latest ? latest.createdAt : null, durationMs: latest ? latest.durationMs : null,
          excludedCount: latest ? latest.excluded.length : 0,
          last: la ? { status: la.status, at: la.endedAt, failure: la.failure ? { title: la.failure.title, step: la.failure.step } : null, stopReason: la.stopReason || null } : null,
          lastNewer: Boolean(la && latest && la.status !== 'completed' && la.endedAt > latest.createdAt),
          rev: st.mrRev[key] || 0
        });
      }
    }
    return {
      version: '1.0.0（预览）', rev: st.rev, now: Date.now(), preview: true,
      dataDir: DATA_DIR, logPath: DATA_DIR + '\\logs\\' + new Date().toISOString().slice(0, 10) + '.log', configPath: 'C:\\Users\\dev\\AppData\\Roaming\\ReviewX\\config.json', rulesDir: DATA_DIR + '\\rules',
      projects, mrs, queue: st.queue.map(jobView), fetch: st.fetch, sending: st.sending ? { pid: st.sending.pid, iid: st.sending.iid, reportId: st.sending.reportId, fid: st.sending.fid } : null,
      drafts: st.rules.filter((r) => r.draft && !r.error).map((r) => ({ id: r.id, name: r.name, source: r.source }))
    };
  }

  function detail(pid, iid) {
    const key = pid + '/' + iid;
    const p = st.projects.find((x) => x.id === pid) || { path: '' };
    const open = openMr(pid, iid);
    const reps = st.reports[key] || [];
    const j = st.queue.find((x) => x.pid === pid && x.iid === iid);
    const reports = reps.map((r, idx) => {
      const stt = states(key, r.id);
      return {
        id: r.id, latest: idx === 0, createdAt: r.createdAt, conclusion: r.conclusion, model: r.model, sourceSha: r.sourceSha, mrUpdatedAt: r.mrUpdatedAt, durationMs: r.durationMs,
        rules: r.rules, skippedRules: r.skippedRules, excluded: r.excluded, changedFiles: r.changedFiles,
        findings: r.findings.map((f) => {
          let s = stateOf(stt, key, r.id, f.id);
          if (idx > 0 && s.state === 'pending') s = { state: 'superseded' };
          return Object.assign({}, f, { loc: locText(f.location), state: s.state, stateAt: s.at || null, reason: s.reason || null, commentUrl: null });
        })
      };
    });
    const mrInfo = open || (reps[0] ? { iid, title: (st.remote[pid] || []).find((m) => m.iid === iid)?.title || '!' + iid, webUrl: null, updatedAt: reps[0].mrUpdatedAt } : { iid, title: '!' + iid });
    return { pid, iid, projectPath: p.path, projectWebUrl: p.webUrl || null, open: Boolean(open), mr: mrInfo, job: j ? jobView(j) : null, reports, last: lastAttempt(key), stale: Boolean(open && reps[0] && reps[0].mrUpdatedAt !== open.updatedAt), rev: st.mrRev[key] || 0 };
  }

  function locText(l) {
    if (!l || !l.path) return '未定位到具体文件';
    return l.path + (l.start_line ? ':' + l.start_line + (l.end_line && l.end_line !== l.start_line ? '-' + l.end_line : '') : '');
  }

  // Per rule name: hits / sent / dismissed over every report in this session.
  function ruleCounts() {
    const out = {};
    for (const key of Object.keys(st.reports)) {
      st.reports[key].forEach((r) => {
        const stt = states(key, r.id);
        for (const f of r.findings) {
          if (!f.rule) continue;
          const k = f.rule;
          out[k] = out[k] || { hits: 0, sent: 0, dismissed: 0 };
          out[k].hits++;
          const x = stateOf(stt, key, r.id, f.id).state;
          if (SENT.includes(x)) out[k].sent++; else if (x === 'dismissed') out[k].dismissed++;
        }
      });
    }
    return out;
  }

  function rulesView() {
    // Sample base stats plus the change since the session started, so
    // decisions on the seeded reports count too without double-counting them.
    const now = ruleCounts();
    const zero = { hits: 0, sent: 0, dismissed: 0 };
    const extra = {};
    for (const k of Object.keys(now)) {
      const b = st.baselineCounts[k] || zero;
      extra[k] = { hits: now[k].hits - b.hits, sent: now[k].sent - b.sent, dismissed: now[k].dismissed - b.dismissed };
    }
    return rulesWith(extra);
  }

  function rulesWith(extra) {
    return st.rules.map((r) => {
      const e = extra[r.name] || { hits: 0, sent: 0, dismissed: 0 };
      const o = Object.assign({}, r, { stats: { hits: r.base.hits + e.hits, sent: r.base.sent + e.sent, dismissed: r.base.dismissed + e.dismissed } });
      delete o.base;
      return o;
    });
  }

  // ---------- simulation ----------
  function finishFetch() {
    const f = st.fetch;
    f.active = false; f.finishedAt = Date.now();
    f.summary = '已更新 ' + f.ok + '/' + f.total + ' 个项目，' + f.failed + ' 个失败';
    log('INFO', 'mr.fetch done ok=' + f.ok + ' failed=' + f.failed);
    toast('获取完成：' + f.summary);
    changed();
  }

  function startFetch(pids) {
    if (st.fetch.active) throw new Error('正在获取 MR，请稍候');
    const all = active().map((p) => p.id);
    const list = pids ? all.filter((x) => pids.includes(x)) : all;
    if (!list.length) throw new Error('没有关注项目');
    st.fetch = { active: true, total: list.length, done: 0, ok: 0, failed: 0, summary: '', finishedAt: null };
    log('INFO', 'mr.fetch start projects=' + list.length + ' concurrency=6');
    list.forEach((pid) => { st.fetchState[pid] = Object.assign({}, st.fetchState[pid], { status: 'fetching' }); });
    changed();
    list.forEach((pid, i) => {
      // The first project alone, then the rest in parallel.
      later(() => {
        if (!project(pid)) { st.fetch.done++; } else if (st.failOnce[pid]) {
          st.failOnce[pid] = false;
          st.fetchState[pid] = { status: 'failed', error: '网络不可用', lastSuccessAt: st.fetched[pid] ? st.fetched[pid].at : null };
          st.fetch.done++; st.fetch.failed++;
          log('WARN', 'mr.fetch project=' + pid + ' failed reason=NETWORK_ERROR kept_previous=' + (st.fetched[pid] ? hms(new Date(st.fetched[pid].at)) : 'none'));
        } else {
          const prev = st.fetched[pid];
          const mrs = clone(st.remote[pid] || []).map((m) => { const o = prev && prev.mrs.find((x) => x.iid === m.iid); return o && o.updatedAt > m.updatedAt ? Object.assign(m, { updatedAt: o.updatedAt }) : m; });
          st.fetched[pid] = { at: Date.now(), mrs };
          st.fetchState[pid] = { status: 'updated', lastSuccessAt: Date.now() };
          st.fetch.done++; st.fetch.ok++;
          st.rev++;
          for (const m of mrs) st.mrRev[pid + '/' + m.iid] = st.rev;
          log('INFO', 'mr.fetch project=' + pid + ' updated open=' + mrs.length);
        }
        changed();
        if (st.fetch.done >= st.fetch.total) finishFetch();
      }, i === 0 ? 1100 : 1100 + 700 + i * 450);
    });
  }

  function enqueue(pid, iid) {
    const key = pid + '/' + iid;
    if (st.queue.some((j) => j.pid === pid && j.iid === iid)) throw new Error('该 MR 已有检视在排队或进行中');
    if (!openMr(pid, iid)) throw new Error('该 MR 不在最近一次获取的开放 MR 列表中');
    const j = job(st, pid, iid, {});
    st.queue.push(j);
    const pos = st.queue.filter((x) => x.status === 'queued').length;
    log('INFO', 'review.enqueue !' + iid + ' project=' + pid + ' position=' + pos);
    changed(key);
    return { position: pos, total: pos };
  }

  function endJob(j, status, extra) {
    const key = j.pid + '/' + j.iid;
    const a = (st.attempts[key] || []).find((x) => x.id === j.id);
    if (a) Object.assign(a, { status, endedAt: Date.now(), steps: j.times.slice() }, extra || {});
    st.queue = st.queue.filter((x) => x !== j);
    changed(key);
  }

  function cancel(pid, iid, reason) {
    const j = st.queue.find((x) => x.pid === pid && x.iid === iid && x.status === 'queued');
    if (!j) throw new Error('该 MR 没有排队中的检视');
    endJob(j, 'stopped', { stopReason: reason || '已取消 · 尚未开始' });
    log('INFO', 'review.cancel !' + iid + ' project=' + pid);
  }

  function stop(pid, iid, reason) {
    const j = st.queue.find((x) => x.pid === pid && x.iid === iid);
    if (!j) throw new Error('该 MR 没有进行中的检视');
    if (j.status === 'queued') return cancel(pid, iid, reason);
    if (j.status === 'stopping') return;
    j.status = 'stopping'; j.stopNote = '正在停止 · 终止子进程'; j.stopAt = Date.now(); j.stopReason = reason || '已主动停止';
    log('INFO', 'review.stop !' + iid + ' requested');
    changed(pid + '/' + iid);
  }

  function setStep(j, n) {
    const now = Date.now();
    if (j.step) j.times[j.step - 1] = now - j.stepStartedAt;
    j.step = n; j.stepStartedAt = now; j.obj = 0;
    if (n === 5) j.objN = j.plan.files;
    if (n === 7) { j.objN = j.found.length; j.obj = j.found.length; }
  }

  function complete(j) {
    const key = j.pid + '/' + j.iid;
    const m = openMr(j.pid, j.iid) || {};
    const conclusion = j.plan.excluded ? 'empty' : j.found.length ? 'issues' : 'pass';
    const findings = sortF(j.found).map((f, i) => Object.assign({ id: 'f' + (i + 1) }, f));
    const now = Date.now();
    j.times[6] = now - j.stepStartedAt;
    const excluded = j.plan.excluded ? j.plan.excluded.map((x) => ({ path: x[0], reason: x[1] })) : EXCL.slice(0, 1 + (Number(j.iid) % 3));
    const r = { id: nid('rp'), preview: true, createdAt: now, conclusion, model: conclusion === 'empty' ? null : MODEL, sourceSha: hex(), mrUpdatedAt: m.updatedAt, durationMs: now - j.startedAt, rules: rulesFor(j.pid), skippedRules: j.pid === '101' ? [{ name: 'naming-old', reason: '缺少开头的 --- 元信息块' }] : [], excluded, changedFiles: j.plan.files, findings };
    (st.reports[key] = st.reports[key] || []).unshift(r);
    endJob(j, 'completed', { reportId: r.id, conclusion });
    log('INFO', 'review.done !' + j.iid + ' project=' + j.pid + ' result=' + conclusion + ' findings=' + findings.length + ' model=' + (r.model || '-') + ' duration=' + Math.round(r.durationMs / 1000) + 's');
    toast('!' + j.iid + ' 检视完成 · ' + (conclusion === 'issues' ? '发现 ' + findings.length + ' 条意见' : conclusion === 'pass' ? '未发现问题' : '无可检视的变更'));
  }

  function rulesFor(pid) { return st.rules.filter((r) => r.enabled && !r.error && !r.draft && (r.scope === 'global' || r.scope === pid)).map((r) => r.name); }

  function fail(j, def) {
    const failure = Object.assign({ completedSteps: def.step - 1, findingsSubmitted: j.found.length, stopsQueue: def.kind === 'env' || def.kind === 'ai', unread: null }, def);
    j.times[j.step - 1] = null;
    endJob(j, 'failed', { failure });
    log('ERROR', 'review.failed !' + j.iid + ' project=' + j.pid + ' step=' + def.step + '/7 code=' + def.code + ' reason=' + def.reason + ' queue=' + (failure.stopsQueue ? 'stopped' : 'continue'));
    if (failure.stopsQueue) for (const q of st.queue.slice()) if (q.status === 'queued') cancel(q.pid, q.iid, '队列已停止：!' + j.iid + ' 检视失败');
    toast('!' + j.iid + ' 检视失败 · ' + def.title.replace(/^步骤 \d\/7 /, ''));
  }

  function tick() {
    const j = st.queue[0];
    if (!j) return;
    const now = Date.now();
    const key = j.pid + '/' + j.iid;
    if (j.status === 'queued') {
      j.status = 'running'; j.startedAt = now;
      const a = (st.attempts[key] || []).find((x) => x.id === j.id);
      if (a) Object.assign(a, { status: 'running', startedAt: now });
      setStep(j, 1);
      log('INFO', 'review.start !' + j.iid + ' project=' + j.pid);
      changed(key);
      return;
    }
    if (j.status === 'stopping') {
      const el = now - j.stopAt;
      if (el > 1700) {
        endJob(j, 'stopped', { stopReason: j.stopReason });
        log('INFO', 'review.stopped !' + j.iid + ' project=' + j.pid + ' reason=' + j.stopReason);
        if (j.stopReason === '已主动停止') toast('!' + j.iid + ' 已停止');
      } else if (el > 800 && j.stopNote !== '正在停止 · 清理临时目录') { j.stopNote = '正在停止 · 清理临时目录'; changed(key); }
      return;
    }
    const el = now - j.stepStartedAt;
    const fdef = j.plan.fail ? FAILS[j.plan.fail] : null;
    if (fdef && j.step === fdef.step && el > STEP_MS[j.step - 1] * 0.7) { fail(j, fdef); return; }
    if (j.step === 5) {
      const n = Math.min(j.objN, Math.floor(el / FILE_MS));
      if (n !== j.obj) { j.obj = n; changed(key); }
      if (j.obj >= j.objN) {
        if (j.plan.excluded) setStep(j, 7);
        else { setStep(j, 6); j.diffN = j.plan.files; j.diffRead = 0; j.phase = 'review'; }
        changed(key);
      }
      return;
    }
    if (j.step === 6) {
      const total = STEP_MS[5];
      const read = Math.min(j.diffN, Math.ceil((el / (total * 0.75)) * j.diffN));
      const defs = j.plan.findings || [];
      const want = Math.min(defs.length, Math.floor((el / total) * (defs.length + 1)));
      let dirty = false;
      if (read !== j.diffRead) { j.diffRead = read; dirty = true; }
      while (j.found.length < want) { j.found.push(clone(LIB[defs[j.found.length]])); j.findings = j.found.length; dirty = true; }
      if (el >= total) {
        while (j.found.length < defs.length) j.found.push(clone(LIB[defs[j.found.length]]));
        j.findings = j.found.length; j.diffRead = j.diffN; j.phase = null;
        setStep(j, 7); dirty = true;
      }
      if (dirty) changed(key);
      return;
    }
    if (j.step === 7) { if (el >= STEP_MS[6]) complete(j); return; }
    if (el >= STEP_MS[j.step - 1]) { setStep(j, j.step + 1); changed(key); }
  }

  // ---------- findings ----------
  function requireLatest(pid, iid, reportId) {
    if (!openMr(pid, iid)) throw new Error('该 MR 已不在开放 MR 列表中');
    const latest = (st.reports[pid + '/' + iid] || [])[0];
    if (!latest || latest.id !== reportId) throw new Error('只能处理最新报告中的意见');
    return latest;
  }

  function decide(b, action) {
    const key = b.pid + '/' + b.iid;
    const r = requireLatest(b.pid, b.iid, b.reportId);
    if (!r.findings.some((f) => f.id === b.fid)) throw new Error('意见不存在');
    const cur = stateOf(states(key, r.id), key, r.id, b.fid).state;
    const rec = { reportId: r.id, fid: b.fid, at: Date.now() };
    if (action === 'dismiss') { if (cur !== 'pending') throw new Error('只有待处理的意见可以标为不发送'); rec.a = 'dismiss'; }
    if (action === 'undo') { if (cur !== 'dismissed') throw new Error('只有标为不发送的意见可以撤销'); rec.a = 'undo'; }
    if (action === 'mark') { if (cur !== 'unknown') throw new Error('只有结果未知的意见需要核对标记'); rec.a = 'mark'; rec.result = b.result === 'published' ? 'published' : 'unpublished'; }
    (st.records[key] = st.records[key] || []).push(rec);
    log('INFO', 'finding.' + action + ' !' + b.iid + ' ' + b.fid + (rec.result ? ' ' + rec.result : ''));
    changed(key);
  }

  function send(b) {
    const key = b.pid + '/' + b.iid;
    if (st.sending) throw new Error('有一条评论正在发送，请稍候');
    if (st.removing[b.pid]) throw new Error('项目正在移除');
    const r = requireLatest(b.pid, b.iid, b.reportId);
    const f = r.findings.find((x) => x.id === b.fid);
    if (!f) throw new Error('意见不存在');
    const cur = stateOf(states(key, r.id), key, r.id, b.fid).state;
    if (cur !== 'pending' && cur !== 'failed') throw new Error('该意见当前不能发送');
    (st.records[key] = st.records[key] || []).push({ a: 'sending', reportId: r.id, fid: b.fid, at: Date.now() });
    st.sending = { key, pid: b.pid, iid: b.iid, reportId: r.id, fid: b.fid };
    log('INFO', 'comment.publish !' + b.iid + ' ' + b.fid + ' start');
    changed(key);
    later(() => {
      (st.records[key] = st.records[key] || []).push({ a: 'result', reportId: r.id, fid: b.fid, result: 'published', at: Date.now() });
      st.sending = null;
      log('INFO', 'comment.publish !' + b.iid + ' ' + b.fid + ' result=published');
      toast('已发布为 !' + b.iid + ' 的 MR 评论（预览：未真正发送）');
      changed(key);
    }, 1300);
  }

  function bulkDismiss(b) {
    const key = b.pid + '/' + b.iid;
    const r = requireLatest(b.pid, b.iid, b.reportId);
    const stt = states(key, r.id);
    let n = 0;
    for (const f of r.findings) {
      if (stateOf(stt, key, r.id, f.id).state !== 'pending') continue;
      (st.records[key] = st.records[key] || []).push({ a: 'dismiss', reportId: r.id, fid: f.id, at: Date.now(), bulk: true });
      n++;
    }
    log('INFO', 'finding.bulk_dismiss !' + b.iid + ' count=' + n);
    changed(key);
    return { count: n };
  }

  function draft(b) {
    const r = (st.reports[b.pid + '/' + b.iid] || []).find((x) => x.id === b.reportId);
    const f = r && r.findings.find((x) => x.id === b.fid);
    if (!f) throw new Error('意见不存在');
    const ext = (f.location.path.match(/\.[A-Za-z0-9]+$/) || [''])[0];
    const id = uniqueRuleId('global', f.title);
    const code = f.related_code ? '```' + f.related_code.language + '\n' + f.related_code.code + '\n```' : '（补充反例代码）';
    st.rules.push(rule(id, 'global', f.title, ext ? '*' + ext : '', false, false, '## 检查要点\n- ' + f.summary + '\n- ' + f.solutions[0].description + '\n\n## 反例\n' + code + '\n\n## 正例\n（补充正例代码）\n', { hits: 0, sent: 0, dismissed: 0 }, { draft: true, source: '来自 !' + b.iid + '「' + f.title + '」' }));
    log('INFO', 'rule.draft id=' + id + ' from=!' + b.iid + ' ' + b.fid);
    changed();
    return { id };
  }

  // ---------- projects ----------
  const NAMES = { 512: 'apps/data/etl-runner', 606: 'apps/mobile/checkout-app', 700: 'infra/gateway' };

  function addProject(raw) {
    const id = String(raw == null ? '' : raw).trim();
    if (!/^[1-9]\d*$/.test(id)) return { ok: false, tone: 'bad', text: 'Project ID 应为正整数' };
    const ex = st.projects.find((p) => p.id === id && !p.removed);
    if (ex) return { ok: false, tone: 'info', text: '该项目已在关注列表中：' + ex.path + '（' + id + '）', flash: id };
    if (id === '999') { log('WARN', 'project.add id=999 failed reason=HTTP_ERROR 项目不存在或无访问权限'); return { ok: false, tone: 'bad', text: '项目不存在或无访问权限' }; }
    if (id === '777') { log('WARN', 'project.add id=777 failed reason=AUTH_ERROR'); return { ok: false, tone: 'bad', text: 'CodeHub CLI 未登录（请重新登录）' }; }
    if (id === '888') { log('WARN', 'project.add id=888 failed reason=NETWORK_ERROR'); return { ok: false, tone: 'bad', text: '网络不可用' }; }
    const order = st.projects.reduce((m, p) => Math.max(m, p.order), 0) + 1;
    const prev = st.projects.find((p) => p.id === id);
    let text;
    if (prev) {
      Object.assign(prev, { removed: false, order });
      let n = 0;
      for (const k of Object.keys(st.reports)) if (k.split('/')[0] === id) n += st.reports[k].length;
      text = '已恢复关注 ' + prev.path + '，已恢复 ' + n + ' 份历史报告';
      st.fetchState[id] = st.fetched[id] ? { status: 'updated', lastSuccessAt: st.fetched[id].at } : { status: 'never' };
      log('INFO', 'project.restore id=' + id + ' reports=' + n);
    } else {
      const path = NAMES[id] || 'apps/demo/project-' + id;
      st.projects.push({ id, path, webUrl: 'https://codehub.example.com/' + path, order, removed: false });
      if (!st.remote[id]) {
        st.remote[id] = id === '512'
          ? [mr('5121', '按分区并行执行导入任务', 'feat/parallel-import', 'qian.yi', 30 * MIN), mr('5122', '修正时区换算导致的重复调度', 'fix/tz-schedule', 'qian.yi', 90 * MIN)]
          : [mr(id + '1', '示例：补充输入校验', 'feat/validate-input', 'dev', 45 * MIN)];
      }
      st.fetchState[id] = { status: 'never' };
      text = '已添加 ' + path + '（' + id + '）';
      log('INFO', 'project.add id=' + id + ' path=' + path);
    }
    changed();
    return { ok: true, tone: 'ok', text };
  }

  function removeProject(pid) {
    const p = project(pid);
    if (!p) throw new Error('项目不在关注列表中');
    if (st.removing[pid]) throw new Error('该项目正在移除');
    if (st.sending && st.sending.pid === pid) throw new Error('该项目有评论正在发送，请等发送结束后再移除');
    st.removing[pid] = true;
    changed();
    for (const j of st.queue.slice()) if (j.pid === pid && j.status === 'queued') cancel(pid, j.iid, '项目已移除');
    const running = st.queue.find((j) => j.pid === pid);
    if (running) stop(pid, running.iid, '项目已移除');
    const g = gen;
    return new Promise((resolve) => {
      const wait = () => {
        if (g !== gen) { resolve({ text: '已恢复初始示例数据' }); return; }
        if (st.queue.some((j) => j.pid === pid)) { setTimeout(wait, 200); return; }
        p.removed = true;
        delete st.removing[pid];
        delete st.fetchState[pid];
        log('INFO', 'project.remove id=' + pid + ' cache=deleted');
        changed();
        resolve({ text: '已移除 ' + shortName(p.path) });
      };
      setTimeout(wait, 400);
    });
  }

  // ---------- rules ----------
  function slug(name) { return String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'rule'; }
  function uniqueRuleId(scope, name) {
    const dir = scope === 'global' ? 'global/' : 'projects/' + scope + '/';
    let id = dir + slug(name) + '.md'; let i = 2;
    while (st.rules.some((r) => r.id === id)) id = dir + slug(name) + '-' + (i++) + '.md';
    return id;
  }
  const getRule = (id) => { const r = st.rules.find((x) => x.id === id); if (!r) throw new Error('规则不存在'); return r; };

  function saveRule(b) {
    const r = getRule(b.id);
    if (r.error) throw new Error('规则格式错误：' + r.error);
    if (typeof b.name === 'string' && !b.name.trim()) throw new Error('规则名称不能为空');
    const name = typeof b.name === 'string' ? b.name.trim() : r.name;
    if (st.rules.some((x) => x !== r && x.name === name && (x.scope === r.scope || x.scope === 'global' || r.scope === 'global'))) throw new Error('名称与另一条规则重复');
    Object.assign(r, { name, files: typeof b.files === 'string' ? b.files : r.files, body: typeof b.body === 'string' ? b.body : r.body });
    if (b.confirmDraft) Object.assign(r, { draft: false, enabled: true });
    log('INFO', 'rule.save id=' + r.id);
    changed();
    return { id: r.id };
  }

  function moveRule(b) {
    const r = getRule(b.id);
    if (r.builtin) throw new Error('内置规则固定为全局');
    const id = uniqueRuleId(String(b.scope), r.name);
    Object.assign(r, { id, file: id, scope: String(b.scope) });
    log('INFO', 'rule.scope id=' + id);
    changed();
    return { id };
  }

  // ---------- request router ----------
  const routes = [
    ['GET', /^\/api\/state$/, () => snapshot()],
    ['GET', /^\/api\/mr\/(\d+)\/(\d+)$/, (m) => detail(m[1], m[2])],
    ['GET', /^\/api\/logs$/, () => ({ path: snapshot().logPath, entries: st.logs.slice().reverse() })],
    ['GET', /^\/api\/rules$/, () => ({ rules: rulesView(), dir: DATA_DIR + '\\rules' })],
    ['GET', /^\/api\/projects\/(\d+)\/impact$/, (m) => ({ tasks: st.queue.filter((j) => j.pid === m[1]).map((j) => ({ iid: j.iid, title: j.title, status: j.status })) })],
    ['POST', /^\/api\/projects$/, (m, b) => delay(addProject(b.id), 900)],
    ['POST', /^\/api\/projects\/(\d+)\/remove$/, (m) => removeProject(m[1])],
    ['POST', /^\/api\/projects\/(\d+)\/clear-cache$/, (m) => {
      const p = project(m[1]); if (!p) throw new Error('项目不在关注列表中');
      if (st.queue.some((j) => j.pid === m[1] && j.status !== 'queued')) throw new Error('该项目有检视进行中，请等它结束后再清除代码缓存');
      log('INFO', 'cache.clear project=' + m[1]);
      return { text: '已清除 ' + shortName(p.path) + ' 的代码缓存，下次检视时重建' };
    }],
    ['POST', /^\/api\/projects\/(\d+)\/open$/, (m) => { const p = project(m[1]); return { text: '预览模式不会打开浏览器。实际会打开 ' + (p ? p.webUrl : 'CodeHub 项目页') }; }],
    ['POST', /^\/api\/fetch$/, (m, b) => { startFetch(b.pid ? [String(b.pid)] : null); return { ok: true }; }],
    ['POST', /^\/api\/reviews$/, (m, b) => enqueue(String(b.pid), String(b.iid))],
    ['POST', /^\/api\/reviews\/stop$/, (m, b) => { stop(String(b.pid), String(b.iid)); return { ok: true }; }],
    ['POST', /^\/api\/reviews\/cancel$/, (m, b) => { cancel(String(b.pid), String(b.iid)); return { ok: true }; }],
    ['POST', /^\/api\/mr\/(\d+)\/(\d+)\/open$/, (m) => ({ text: '预览模式不会打开浏览器。实际会打开 CodeHub MR !' + m[2] })],
    ['POST', /^\/api\/findings\/send$/, (m, b) => { send(b); return { ok: true }; }],
    ['POST', /^\/api\/findings\/dismiss$/, (m, b) => { decide(b, 'dismiss'); return { ok: true }; }],
    ['POST', /^\/api\/findings\/undo$/, (m, b) => { decide(b, 'undo'); return { ok: true }; }],
    ['POST', /^\/api\/findings\/mark$/, (m, b) => { decide(b, 'mark'); return { ok: true }; }],
    ['POST', /^\/api\/findings\/bulk-dismiss$/, (m, b) => bulkDismiss(b)],
    ['POST', /^\/api\/findings\/draft$/, (m, b) => draft(b)],
    ['POST', /^\/api\/rules$/, (m, b) => { const scope = String(b.scope || 'global'); const id = uniqueRuleId(scope, '未命名规则'); st.rules.push(rule(id, scope, '未命名规则' + (st.rules.filter((r) => r.name.startsWith('未命名规则')).length || ''), '', false, false, '## 检查要点\n- \n\n## 正例\n\n## 反例\n', { hits: 0, sent: 0, dismissed: 0 })); changed(); return { id }; }],
    ['POST', /^\/api\/rules\/save$/, (m, b) => saveRule(b)],
    ['POST', /^\/api\/rules\/toggle$/, (m, b) => { const r = getRule(b.id); if (r.error) throw new Error('规则格式错误：' + r.error); r.enabled = !r.enabled; r.draft = false; log('INFO', 'rule.toggle id=' + r.id + ' enabled=' + r.enabled); changed(); return { enabled: r.enabled }; }],
    ['POST', /^\/api\/rules\/scope$/, (m, b) => moveRule(b)],
    ['POST', /^\/api\/rules\/copy$/, (m, b) => { const r = getRule(b.id); const name = r.name + ' 副本'; const id = uniqueRuleId(r.scope, name); st.rules.push(rule(id, r.scope, name, r.files, false, false, r.body, { hits: 0, sent: 0, dismissed: 0 })); changed(); return { id }; }],
    ['POST', /^\/api\/rules\/delete$/, (m, b) => { const r = getRule(b.id); if (r.builtin) throw new Error('内置规则不能删除，可以停用'); st.rules = st.rules.filter((x) => x !== r); log('INFO', 'rule.delete id=' + r.id); changed(); return { ok: true }; }],
    ['POST', /^\/api\/rules\/open-dir$/, () => ({ text: '预览模式不会打开资源管理器。实际会打开 ' + DATA_DIR + '\\rules' })]
  ];

  function delay(v, ms) { return new Promise((r) => setTimeout(() => r(v), ms)); }

  async function request(method, url, body) {
    const path = url.split('?')[0];
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const mt = re.exec(path);
      if (!mt) continue;
      await delay(null, 60);
      return clone(await fn(mt, body || {}));
    }
    throw new Error('接口不存在');
  }

  function start() {
    gen++;
    st = seed();
    st.baselineCounts = ruleCounts();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 250);
  }

  start();
  window.ReviewXPreview = {
    request,
    subscribe(fn) {
      listeners.push(fn);
      setTimeout(() => fn('state', snapshot()), 0);
      return () => { listeners = listeners.filter((x) => x !== fn); };
    },
    reset() { start(); changed(); }
  };
})();
