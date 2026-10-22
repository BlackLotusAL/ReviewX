import { ApiError, type ApiTransport } from '../api'
import type { Attempt, Finding, HandlingState, MR, Project, Report, Rule, Snapshot } from '../types'
import { createFixtures, steps, type Scenario } from './fixtures'

// This adapter owns only in-memory demo data. Unknown routes fail closed.
export function createPreviewTransport(scenario: Scenario): ApiTransport {
  const state = createFixtures(scenario)
  const template = createFixtures('workspace')
  const removed = new Map<string, Project>()
  const jobs = new Map<string, { started: number; stepMs: number }>()
  let sequence = 0
  let fetchJob: { ids: string[]; due: number } | null = null
  let sendJob: { report: Report; finding: Finding; due: number } | null = null
  let fetchProgress = { total: 0, done: 0, failed: 0 }
  const now = () => new Date().toISOString()
  const localDate = (value: string) => {
    const date = new Date(value)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  const id = () => `demo-${++sequence}`
  const allMRs = () => state.projects.flatMap(p => p.mrs)
  const queue = () => allMRs().map(m => m.attempt).filter((a): a is Attempt => !!a && ['queued', 'running', 'stopping'].includes(a.status))
  const log = (message: string, project_id?: string, iid?: string) => state.logs.unshift({ at: now(), level: 'INFO', message, project_id, iid })
  const findProject = (pid: string) => {
    const project = state.projects.find(p => p.id === pid)
    if (!project) throw new ApiError('演示项目不存在')
    return project
  }
  const findMR = (pid: string, iid: string) => {
    const mr = findProject(pid).mrs.find(m => m.iid === iid)
    if (!mr) throw new ApiError('演示 MR 不存在')
    return mr
  }
  const detail = (mr: MR) => state.details[`${mr.project_id}/${mr.iid}`] ||= { reports: [], attempts: [] }
  const findReport = (rid: string) => {
    const report = Object.values(state.details).flatMap(d => d.reports).find(r => r.id === rid)
    if (!report) throw new ApiError('演示报告不存在')
    return report
  }
  const changeHandling = (finding: Finding, next: HandlingState) => {
    const bucket = (s: HandlingState) => s === 'dismissed' ? 'dismissed' : ['sending', 'published', 'manual', 'failed', 'unknown'].includes(s) ? 'sent' : null
    const stats = state.rules.find(r => r.name === finding.rule)?.stats
    if (stats) {
      const before = bucket(finding.handling.state), after = bucket(next)
      if (before !== after) {
        if (before) stats[before] = Math.max(0, stats[before] - 1)
        if (after) stats[after]++
      }
    }
    finding.handling = { state: next, at: now() }
    finding.history.push({ ...finding.handling })
  }
  const sync = () => {
    for (const mr of allMRs()) {
      const report = detail(mr).reports[0]
      mr.report_id = report?.id || null; mr.report_at = report?.created_at || null; mr.conclusion = report?.conclusion || null
      mr.pending = report?.findings.filter(f => f.handling.state === 'pending').length || 0
      mr.check = report?.findings.filter(f => ['unknown', 'failed'].includes(f.handling.state)).length || 0
      mr.stale = !!report && report.mr_updated_at !== mr.updated_at
    }
  }
  const promote = () => {
    if (queue().some(a => a.status === 'running')) return
    const next = queue().find(a => a.status === 'queued')
    if (next) {
      next.status = 'running'; next.step = 1; next.started_at = now(); next.message = steps[0]
      jobs.set(next.id, { started: Date.now(), stepMs: 1100 })
    }
  }
  const complete = (mr: MR) => {
    const d = detail(mr)
    for (const old of d.reports) {
      old.latest = false
      for (const f of old.findings) if (f.handling.state === 'pending') changeHandling(f, 'superseded')
    }
    const report = structuredClone(template.details['101/404'].reports[0])
    Object.assign(report, { id: id(), project_id: mr.project_id, iid: mr.iid, project_name: findProject(mr.project_id).full_name,
      mr_title: mr.title, mr_updated_at: mr.updated_at, created_at: now(), latest: true,
      rules: structuredClone(state.rules.filter(r => r.enabled && (r.scope === 'global' || r.scope === mr.project_id))),
      findings: report.findings.slice(0, 2).map(f => ({ ...f, id: id(), handling: { state: 'pending' }, history: [] })),
    })
    d.reports.unshift(report)
    const a = mr.attempt!
    a.status = 'completed'; a.step = 7; a.message = '检视完成'; a.ended_at = now()
    a.steps = steps.map((_, i) => ({ number: i + 1, seconds: 1.1 }))
    jobs.delete(a.id)
    log('演示检视完成，发现 2 条意见', mr.project_id, mr.iid)
  }
  const advance = () => {
    if (sendJob && Date.now() >= sendJob.due) {
      changeHandling(sendJob.finding, 'published')
      log('演示意见已发布', sendJob.report.project_id, sendJob.report.iid)
      sendJob = null
    }
    if (fetchJob && Date.now() >= fetchJob.due) {
      for (const pid of fetchJob.ids) {
        const p = state.projects.find(p => p.id === pid)
        if (!p) continue
        p.fetch_status = 'updated'; p.fetched_at = now(); p.error = null
        if (!p.mrs.length) {
          const mr = structuredClone(template.projects[1].mrs[0])
          Object.assign(mr, { project_id: p.id, iid: '1', title: '完善演示项目的请求处理', updated_at: now() })
          p.mrs.push(mr); detail(mr)
        }
      }
      fetchProgress = { total: fetchJob.ids.length, done: fetchJob.ids.length, failed: 0 }
      fetchJob = null
      log('演示 MR 已更新')
    }
    for (const mr of allMRs()) {
      const a = mr.attempt, job = a && jobs.get(a.id)
      if (!a || !job || a.status !== 'running') continue
      const elapsed = Date.now() - job.started
      if (elapsed >= job.stepMs * 7) { complete(mr); continue }
      a.step = Math.min(7, Math.floor(elapsed / job.stepMs) + 1)
      a.message = steps[a.step - 1]
      a.steps = steps.slice(0, a.step - 1).map((_, i) => ({ number: i + 1, seconds: job.stepMs / 1000 }))
      if (a.step === 6 && !a.ai_started_at) a.ai_started_at = now()
    }
    promote(); sync()
  }
  // Seeded running tasks stay on screen long enough to inspect before advancing.
  for (const a of queue()) if (a.status === 'running') jobs.set(a.id, { started: Date.now() - 50_000, stepMs: 10_000 })

  const handle = (path: string, body?: unknown): unknown => {
    advance()
    const url = new URL(path, 'http://preview.invalid')
    const route = url.pathname
    const data = (body || {}) as Record<string, unknown>
    let match: RegExpMatchArray | null
    if (body === undefined) {
      if (route === '/state') return {
        csrf: 'preview', projects: state.projects, queue: queue(), fetching: !!fetchJob, fetch_progress: fetchProgress,
        sending: sendJob ? { report_id: sendJob.report.id, finding_id: sendJob.finding.id, project_id: sendJob.report.project_id } : null,
        steps, timeout: 720,
      } satisfies Snapshot
      if (route === '/rules') return { rules: state.rules, unassigned: scenario === 'empty' ? { hits: 0, sent: 0, dismissed: 0 } : { hits: 3, sent: 1, dismissed: 1 } }
      if (route === '/logs') return { logs: state.logs.filter(l => !url.searchParams.get('date') || localDate(l.at) === url.searchParams.get('date')) }
      if ((match = route.match(/^\/projects\/(\d+)\/mrs\/(\d+)$/))) return detail(findMR(match[1], match[2]))
    } else {
      if (route === '/projects') {
        const pid = String(data.id || '')
        if (!/^[1-9]\d*$/.test(pid)) throw new ApiError('Project ID 应为正整数')
        if (state.projects.some(p => p.id === pid)) throw new ApiError('该项目已在关注列表中')
        const archived = removed.get(pid)
        state.projects.push(archived || { id: pid, full_name: `demo/project-${pid}`, web_url: '', fetch_status: 'idle', fetched_at: null, error: null, mrs: [] })
        removed.delete(pid); log('已添加演示项目', pid)
        return { restored: archived?.mrs.reduce((count, mr) => count + detail(mr).reports.length, 0) || 0 }
      }
      if (route === '/fetch') {
        const projects = data.project_id ? [findProject(String(data.project_id))] : state.projects
        fetchJob = { ids: projects.map(p => p.id), due: Date.now() + 900 }
        fetchProgress = { total: projects.length, done: 0, failed: 0 }
        projects.forEach(p => { p.fetch_status = 'fetching' })
        return { ok: true }
      }
      if (route === '/reviews') {
        const mr = findMR(String(data.project_id), String(data.iid))
        if (mr.attempt && queue().includes(mr.attempt)) throw new ApiError('该 MR 已在检视队列中')
        if (sendJob?.report.project_id === mr.project_id && sendJob.report.iid === mr.iid) throw new ApiError('请等待演示意见发送完成')
        const attempt: Attempt = { id: id(), project_id: mr.project_id, iid: mr.iid, status: 'queued', step: 0, message: '排队中', created_at: now(), steps: [] }
        mr.attempt = attempt; detail(mr).attempts.unshift(attempt); promote()
        log('已加入演示检视队列', mr.project_id, mr.iid)
        return attempt
      }
      if ((match = route.match(/^\/reviews\/([^/]+)\/stop$/))) {
        const a = queue().find(a => a.id === match![1])
        if (!a) throw new ApiError('检视已结束')
        a.status = 'stopped'; a.message = '已停止'; a.ended_at = now(); jobs.delete(a.id); promote()
        return { ok: true }
      }
      if ((match = route.match(/^\/projects\/(\d+)\/(remove|clear-cache)$/))) {
        const p = findProject(match[1])
        if (match[2] === 'remove') {
          for (const mr of p.mrs) if (mr.attempt && queue().includes(mr.attempt)) {
            jobs.delete(mr.attempt.id); mr.attempt.status = 'stopped'; mr.attempt.ended_at = now(); mr.attempt.message = '已停止'
          }
          removed.set(p.id, p); state.projects = state.projects.filter(x => x !== p); promote()
        }
        log(match[2] === 'remove' ? '已移除演示项目' : '演示代码缓存已清除', p.id)
        return { ok: true }
      }
      if ((match = route.match(/^\/reports\/([^/]+)\/(?:findings\/([^/]+)\/action|dismiss)$/))) {
        const r = findReport(match[1])
        if (!r.latest) throw new ApiError('历史报告只读')
        if (!match[2]) {
          r.findings.filter(f => f.handling.state === 'pending').forEach(f => changeHandling(f, 'dismissed'))
          return { ok: true }
        }
        const f = r.findings.find(f => f.id === match![2])
        if (!f) throw new ApiError('演示意见不存在')
        const action = String(data.action)
        const allowed: Record<string, HandlingState[]> = { send: ['pending', 'failed'], dismiss: ['pending'], undo: ['dismissed'], 'confirm-published': ['unknown'], 'confirm-unpublished': ['unknown'] }
        if (!allowed[action]?.includes(f.handling.state)) throw new ApiError('该状态不支持此操作')
        if (action === 'send') {
          if (sendJob) throw new ApiError('请等待上一条演示意见发送完成')
          changeHandling(f, 'sending'); sendJob = { report: r, finding: f, due: Date.now() + 700 }
        } else changeHandling(f, action === 'dismiss' ? 'dismissed' : action === 'confirm-published' ? 'manual' : 'pending')
        return { ok: true }
      }
      if (route === '/rules' || (match = route.match(/^\/rules\/([^/]+)\/(save|delete)$/))) {
        const rid = match?.[1]
        if (match?.[2] === 'delete') { state.rules = state.rules.filter(r => r.id !== rid); return { ok: true } }
        if (!String(data.name || '').trim() || !String(data.points || '').trim()) throw new ApiError('请填写规则名称和检查要点')
        const existing = state.rules.find(r => r.id === rid)
        const rule = { ...data, id: rid || id(), stats: existing?.stats || { hits: 0, sent: 0, dismissed: 0 } } as unknown as Rule
        if (existing) state.rules[state.rules.indexOf(existing)] = rule
        else state.rules.push(rule)
        log('演示规则已保存')
        return rule
      }
    }
    throw new ApiError(`预览未实现此操作：${route}`)
  }
  return async (path, body, signal) => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return structuredClone(handle(path, body))
  }
}
