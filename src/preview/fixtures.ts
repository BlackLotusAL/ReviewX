import type { Attempt, Detail, Finding, Log, MR, Project, Report, Rule } from '../types'

export const scenarios = [
  { id: 'workspace', label: '完整工作台', view: 'queue' },
  { id: 'report', label: '检视报告', view: 'queue', iid: '404' },
  { id: 'running', label: '检视中', view: 'queue', iid: '402' },
  { id: 'failed', label: '检视失败', view: 'queue', iid: '406' },
  { id: 'success', label: '未发现问题', view: 'queue', iid: '410' },
  { id: 'excluded', label: '无可检视变更', view: 'queue', iid: '411' },
  { id: 'rules', label: '规则配置', view: 'rules' },
  { id: 'logs', label: '会话日志', view: 'logs' },
  { id: 'empty', label: '空页面', view: 'queue' },
] as const
export type Scenario = typeof scenarios[number]['id']
export const steps = ['读取 MR 信息', '拉取源分支', '拉取目标分支', '校验 MR 未变化', '生成变更快照', 'OpenCode 检视', '保存报告与意见']

export function createFixtures(scenario: Scenario) {
  const base = Date.now()
  const ago = (minutes: number) => new Date(base - minutes * 60_000).toISOString()
  const rules: Rule[] = [
    { id: 'correctness', name: '正确性', scope: 'global', enabled: true, builtin: true, files: [], points: '检查状态变化、边界输入和错误处理是否完整。', good: '先验证输入，再更新状态。', bad: '未检查空值就直接访问属性。', stats: { hits: 28, sent: 19, dismissed: 5 } },
    { id: 'security', name: '权限与数据隔离', scope: 'global', enabled: true, builtin: true, files: [], points: '所有资源访问都必须验证当前项目与资源的归属关系。', good: '使用项目 ID 和资源 ID 联合查询。', bad: '仅依赖客户端传入的资源 ID。', stats: { hits: 12, sent: 10, dismissed: 1 } },
    { id: 'transactions', name: '数据库事务一致性', scope: '101', enabled: true, files: ['src/db/**'], points: '关联写入必须处于同一个事务中，失败后完整回滚。', good: '在事务回调中完成全部写入。', bad: '多次独立提交导致部分更新。', stats: { hits: 9, sent: 6, dismissed: 2 } },
    { id: 'ui', name: '交互与可访问性', scope: '102', enabled: false, files: ['src/**/*.tsx'], points: '交互控件应提供可访问名称，并支持键盘操作。', good: '图标按钮提供 aria-label。', bad: '只能用鼠标操作的 div。', stats: { hits: 7, sent: 4, dismissed: 3 } },
  ]
  const findings: Finding[] = [
    { id: 'f-access', severity: 'fatal', title: '报告读取缺少项目范围校验', rule: '权限与数据隔离', tags: ['权限', '数据隔离'],
      summary: '报告接口只按报告 ID 查询，未验证报告所属项目。切换项目后仍可能读到另一项目的报告。',
      location: { path: 'src/services/reports.ts', start_line: 42, end_line: 46 },
      related_code: { language: 'typescript', code: 'export async function readReport(projectId: string, id: string) {\n  const report = await store.get(id);\n  return report.body;\n}' },
      impact: { consequence: '其他项目的报告内容可能被读取。', scope: '报告详情接口。', trigger: '请求的报告 ID 不属于当前项目。' },
      solutions: [{ description: '在查询时同时限定项目 ID，并对未找到的资源返回 404。', code: { language: 'typescript', code: 'const report = await store.find({ projectId, id });\nif (!report) throw new NotFoundError();\nreturn report.body;' } }],
      prevention: ['覆盖跨项目访问的集成测试。', '将资源归属校验集中到数据访问层。'], handling: { state: 'pending' }, history: [] },
    { id: 'f-config', severity: 'major', title: '空配置会中断后续任务', rule: '正确性', summary: '配置文件为空时，读取默认模型会触发空值异常，导致整个队列停止。', location: { path: 'src/config.ts', start_line: 18 },
      related_code: { language: 'typescript', code: 'const model = config.ai.defaultModel;' },
      impact: { consequence: '后续 MR 无法继续检视。', scope: '首次启动或配置重置后的任务。', trigger: '配置中没有 ai 字段。' },
      solutions: [{ description: '校验配置，并为缺失字段提供默认值。', code: { language: 'typescript', code: "const model = config.ai?.defaultModel ?? 'default';" } }],
      prevention: ['增加空配置与部分配置的测试。'], handling: { state: 'pending' }, history: [] },
    { id: 'f-logs', severity: 'minor', title: '错误日志缺少项目上下文', summary: '多个项目同时出现在队列中时，当前错误日志无法定位到具体 MR。', location: { path: 'src/runner.ts', start_line: 86 },
      impact: { consequence: '排查失败任务时难以定位。', scope: '检视失败日志。', trigger: '队列包含多个项目。' }, solutions: [{ description: '记录 projectId、iid 和当前步骤。' }],
      handling: { state: 'unknown', at: ago(8), message: '连接中断，无法确认发布结果。' }, history: [{ state: 'unknown', at: ago(8) }] },
    { id: 'f-retry', severity: 'minor', title: '重试前未清理临时目录', summary: '失败后的临时文件可能影响下一次检视。', location: { path: 'src/workspace.ts', start_line: 63 },
      impact: { consequence: '重试可能读取过期文件。', scope: '失败任务的临时工作区。', trigger: '重新检视失败的 MR。' }, solutions: [{ description: '在 finally 中统一清理，并在创建工作区前验证目录为空。' }],
      handling: { state: 'failed', at: ago(6), message: '演示发布失败：服务暂时不可用。' }, history: [{ state: 'failed', at: ago(6) }] },
    { id: 'f-test', severity: 'suggestion', title: '补充空输入测试', rule: '正确性', summary: '为解析器补充空字符串与空列表场景。', location: { path: 'tests/parser.test.ts', start_line: 12 },
      impact: { consequence: '边界行为可能在重构后回退。', scope: '解析器测试。', trigger: '输入为空。' }, solutions: [{ description: '添加覆盖边界输入的参数化测试。' }],
      handling: { state: 'dismissed', at: ago(4) }, history: [{ state: 'dismissed', at: ago(4) }] },
  ]
  const makeMR = (iid: string, title: string, branch: string, pid = '101'): MR => ({
    iid, project_id: pid, title, source_branch: branch, target_branch: 'main', updated_at: ago(30), web_url: '',
    attempt: null, report_id: null, conclusion: null, pending: 0, check: 0, stale: false, report_at: null,
  })
  const projects: Project[] = scenario === 'empty' ? [] : [
    { id: '101', full_name: 'demo/review-service', web_url: '', fetch_status: 'updated', fetched_at: ago(2), error: null, mrs: [
      makeMR('404', '完善检视报告的读取校验与错误处理', 'fix/report-validation'),
      makeMR('402', '为检视队列增加取消信号', 'feat/review-cancellation'),
      makeMR('403', '优化代码快照的生成流程', 'perf/snapshot'),
      makeMR('406', '调整模型连接与超时处理', 'fix/model-timeout'),
      makeMR('410', '补充请求参数的边界校验', 'test/request-validation'),
      makeMR('411', '更新项目文档与静态资源', 'docs/update'),
    ] },
    { id: '102', full_name: 'demo/web-console', web_url: '', fetch_status: 'failed', fetched_at: ago(18), error: '演示连接超时', mrs: [
      makeMR('208', '优化筛选栏的键盘操作', 'feat/filter-keyboard', '102'),
    ] },
  ]
  const details: Record<string, Detail> = {}
  for (const project of projects) for (const mr of project.mrs) {
    const detail: Detail = { reports: [], attempts: [] }
    details[`${project.id}/${mr.iid}`] = detail
    const statuses: Record<string, Attempt['status']> = { '404': 'completed', '402': 'running', '403': 'queued', '406': 'failed', '410': 'completed', '411': 'completed' }
    const status = statuses[mr.iid]
    if (!status) continue
    const attempt: Attempt = { id: `a-${mr.iid}`, project_id: project.id, iid: mr.iid, status, step: status === 'queued' ? 0 : status === 'completed' ? 7 : 6,
      message: status === 'failed' ? '模型连接超时，未生成报告' : status === 'running' ? '验证候选问题 · 3/5' : status === 'queued' ? '排队中' : '检视完成',
      created_at: ago(15), started_at: status === 'queued' ? undefined : ago(12), ended_at: status === 'completed' || status === 'failed' ? ago(10) : undefined,
      ai_started_at: status === 'running' ? ago(1) : undefined, queue_stopped: status === 'failed',
      steps: status === 'queued' ? [] : steps.slice(0, status === 'completed' ? 7 : 5).map((_, i) => ({ number: i + 1, seconds: 1.4 + i * 2 })),
    }
    mr.attempt = attempt; detail.attempts.push(attempt)
    if (status !== 'completed') continue
    const report: Report = { id: `r-${mr.iid}`, project_id: project.id, iid: mr.iid, project_name: project.full_name, mr_title: mr.title,
      mr_updated_at: mr.iid === '404' ? ago(45) : mr.updated_at, source_commit: '8a1c9e2b07e492cdf94a74303b8ec46209d552fc', target_commit: 'e96db23e682441680b3e2a925b2a021ba931f2fa',
      model: mr.iid === '411' ? '未调用 OpenCode' : 'Demo / review-model', created_at: ago(10), latest: true,
      rules: structuredClone(rules.filter(r => r.enabled && (r.scope === 'global' || r.scope === project.id))), invalid_rules: [],
      excluded: [{ path: 'package-lock.json', reason: '锁文件' }, { path: 'assets/logo.svg', reason: '静态资源' }],
      conclusion: mr.iid === '404' ? '发现问题' : mr.iid === '410' ? '未发现问题' : '无可检视的变更', findings: mr.iid === '404' ? structuredClone(findings) : [],
    }
    detail.reports.push(report)
    if (mr.iid === '404') {
      const old = structuredClone(report)
      old.id = 'r-404-history'; old.latest = false; old.created_at = ago(120)
      old.findings = [structuredClone(findings[1])]
      old.findings[0].handling = { state: 'superseded', at: ago(10) }
      detail.reports.push(old)
    }
  }
  const logs: Log[] = scenario === 'empty' ? [] : [
    { at: ago(0), level: 'INFO', message: '演示工作台已就绪' },
    { at: ago(2), level: 'ERROR', message: '模型连接超时，未生成报告', project_id: '101', iid: '406', step: 6, elapsed_seconds: 720 },
    { at: ago(4), level: 'WARN', message: '发送结果未知，请到 CodeHub 核对', project_id: '101', iid: '404' },
    { at: ago(6), level: 'INFO', message: '检视完成，发现 5 条意见', project_id: '101', iid: '404', model: 'Demo / review-model' },
    { at: ago(10), level: 'INFO', message: '代码快照已生成', project_id: '101', iid: '402', files: 12 },
  ]
  return { projects, details, rules: scenario === 'empty' ? [] : rules, logs }
}
