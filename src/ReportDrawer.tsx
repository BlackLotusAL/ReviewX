import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowRight, Check, CheckCheck, ChevronDown, Clock3, FileCheck2, FileCode2, GitBranch, History, Info, ListChecks, Plus, RefreshCw, ShieldCheck, Square, TriangleAlert, X } from 'lucide-react'
import { api, busy, duration, time, plainText } from './api'
import { Button, CodeBlock, Empty, External, Modal, Pill, Progress } from './components'
import type { Detail, Finding, MR, Project, Report, Rule, Snapshot } from './types'

type Props = {
  mr: MR; project: Project; snapshot: Snapshot; close: () => void
  act: (path: string, body?: unknown, success?: string) => Promise<unknown>; toast: (s: string) => void
  confirm: (value: { title: string; body: ReactNode; label: string; danger?: boolean; action: () => Promise<unknown> }) => void
  goLogs: () => void; makeRule: (rule: Partial<Rule>) => void
}
const labels = { pending: '待处理', sending: '发送中…', published: '已发布', manual: '已发布 · 人工确认', dismissed: '不发送', unknown: '结果未知', failed: '发布失败', superseded: '已被新报告取代' }
const tones = { pending: 'info', sending: 'info', published: 'success', manual: 'success', dismissed: 'muted', unknown: 'caution', failed: 'danger', superseded: 'muted' }
export function ReportDrawer(props: Props) {
  const { mr, project, snapshot, close, act, toast, confirm, goLogs, makeRule } = props
  const [detail, setDetail] = useState<Detail | null>(null), [error, setError] = useState('')
  const [tab, setTab] = useState<string>(busy(mr.attempt?.status) || ['failed', 'stopped'].includes(mr.attempt?.status || '') ? 'attempt' : 'latest')
  const [working, setWorking] = useState<string | null>(null)
  const [tick, setTick] = useState(Date.now())
  const [expanded, setExpanded] = useState(false)
  const header = useRef<HTMLElement>(null)
  useEffect(() => {
    const node = header.current
    if (!node) return
    const observer = new ResizeObserver(() => {
      node.closest<HTMLElement>('.drawer')?.style.setProperty('--drawer-header-height', `${node.offsetHeight}px`)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const load = async () => {
    const data = await api<Detail>(`/projects/${project.id}/mrs/${mr.iid}`)
    setDetail(data); setError('')
    return data
  }
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const data = await api<Detail>(`/projects/${project.id}/mrs/${mr.iid}`); if (!disposed) { setDetail(data); setError('') } }
      catch (e) { if (!disposed) setError(e instanceof Error ? e.message : '报告读取失败') }
      if (!disposed) { setTick(Date.now()); timer = setTimeout(poll, 1500) }
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [project.id, mr.iid])
  useEffect(() => { if (tab === 'attempt' && mr.attempt?.status === 'completed') setTab('latest') }, [mr.attempt?.status, tab])
  const report = tab === 'latest' ? detail?.reports[0] : detail?.reports.find(r => r.id === tab)
  const a = detail?.attempts[0] || mr.attempt
  const pending = report?.findings.filter(f => f.handling.state === 'pending') || []
  const check = report?.findings.filter(f => ['unknown', 'failed'].includes(f.handling.state)) || []
  const execute = async (key: string, path: string, body = {}) => {
    setWorking(key)
    try { await act(path, body); await load() }
    catch (e) { toast(e instanceof Error ? e.message : '操作失败') }
    finally { setWorking(null) }
  }
  const rerun = () => void execute('review', '/reviews', { project_id: project.id, iid: mr.iid }).then(() => setTab('attempt'))
  const nextPending = () => {
    const currentY = document.querySelector('.drawer')!.scrollTop
    const nodes = pending.map(f => document.getElementById(`finding-${f.id}`)).filter((n): n is HTMLElement => !!n)
    const next = nodes.find(n => n.offsetTop > currentY + 190) || nodes[0]
    next?.scrollIntoView({ behavior: 'smooth', block: 'start' }); next?.focus({ preventScroll: true })
  }
  return <Modal title={`MR !${mr.iid} 检视报告`} close={close} drawer>
    <header className="drawer-header" ref={header}>
      <div className="drawer-kicker"><span><GitPullRequestIcon />MR <span className="mono">!{mr.iid}</span></span><Button variant="q" className="close-drawer" aria-label="关闭报告" onClick={close}><X /></Button></div>
      <h2>{mr.title}</h2>
      <div className="drawer-subtitle"><span>{project.full_name}</span><span>·</span><External url={mr.web_url}>!{mr.iid}</External><span className="branch-line"><GitBranch size={13} /><span className="mono">{mr.source_branch}</span><ArrowRight size={12} /><span className="mono">{mr.target_branch}</span></span></div>
      <div className="drawer-tabs-row">
        {!!detail?.reports.length && <div className="tabs" role="tablist" aria-label="历次成功报告">{detail.reports.map((r, i) => <button role="tab" aria-selected={report?.id === r.id} key={r.id} onClick={() => setTab(i === 0 ? 'latest' : r.id)}>{i === 0 ? `最新报告 · ${time(r.created_at).split(' ')[1] || time(r.created_at)}` : `历史 ${i} · 已归档`}</button>)}</div>}
        {a && a.status !== 'completed' && <Button variant={tab === 'attempt' ? 's' : 'q'} onClick={() => setTab('attempt')}>{busy(a.status) ? '当前检视进度' : a.status === 'failed' ? '最近失败记录' : '最近停止记录'}</Button>}
      </div>
    </header>
    <div className="drawer-body">
      {error && <div className="notice danger" role="alert">{error}</div>}
      {!detail && !error && <div className="loading"><span className="spin" />读取报告…</div>}
      {detail && !report && (!a || tab === 'latest') && <Empty icon={<FileCode2 />} title="暂无检视记录" compact><p>对这个 MR 的整体代码变更发起一次 AI 检视。<br />完成后，你可以逐条决定是否发送意见。</p><Button variant="p" loading={working === 'review'} onClick={rerun}>开始检视<ArrowRight /></Button><div className="empty-steps">{snapshot.steps.map((s, i) => <span key={s}><b>{i + 1}</b>{s}</span>)}</div></Empty>}
      {detail && !report && a && tab === 'attempt' && <>
        <div className={`attempt-panel ${a.status === 'failed' ? 'failed-panel' : ''}`}>
          <div className="section-top"><Pill tone={a.status === 'failed' ? 'danger' : 'muted'} spin={busy(a.status) && a.status !== 'queued'}>{a.status === 'queued' ? '排队中' : a.status === 'running' ? `检视中 ${a.step}/7` : a.status === 'stopping' ? '停止中…' : a.status === 'failed' ? '检视失败' : '已停止'}</Pill><span className="mono muted">{a.started_at ? duration(((a.ended_at ? new Date(a.ended_at).getTime() : tick) - new Date(a.started_at).getTime()) / 1000) : '尚未开始'}</span></div>
          <h3>{a.status === 'failed' ? `步骤 ${a.step}/7 · ${snapshot.steps[a.step - 1]}` : a.status === 'queued' ? `排队中 · 第 ${snapshot.queue.filter(q => q.status === 'queued').findIndex(q => q.id === a.id) + 1}/${snapshot.queue.filter(q => q.status === 'queued').length} 位` : a.status === 'stopped' ? '检视已停止' : a.message}</h3>
          {a.status === 'failed' && <><p>{a.message}</p><p>本次未保存报告，没有可发布的意见。{detail.reports.length > 0 ? '上一次成功报告仍可查看和处理。' : ''}</p><div className="failure-next"><strong>{a.queue_stopped ? '队列已停止' : '队列继续执行'}</strong><span>请排除上述原因后重新检视，或到 CodeHub 人工核对代码。</span></div></>}
          {a.status === 'stopped' && <p>{a.message}{a.message.includes('不计为故障') ? '' : '。不计为故障，没有生成可发布的意见。'}</p>}
          {a.status === 'queued' && <p>同一时间只执行一个 MR，轮到时会自动开始。关闭浏览器不会中断队列。</p>}
          {a.status === 'running' && <><Progress step={a.step} />{a.ai_started_at && <p className="mono muted">OpenCode {duration((tick - new Date(a.ai_started_at).getTime()) / 1000)} / {duration(snapshot.timeout)}</p>}</>}
          <div className="inline-actions">{busy(a.status) ? <Button disabled={a.status === 'stopping'} loading={working === 'stop'} onClick={() => void execute('stop', `/reviews/${a.id}/stop`)}><Square />{a.status === 'queued' ? '取消排队' : a.status === 'stopping' ? '停止中…' : '停止检视'}</Button> : <Button variant="p" onClick={rerun} loading={working === 'review'}><RefreshCw />重新检视</Button>}<Button variant="q" onClick={goLogs}>查看会话日志</Button></div>
        </div>
        <div className="step-list">{snapshot.steps.map((s, i) => { const done = a.steps.find(x => x.number === i + 1), current = a.step === i + 1; return <div key={s} className={`${done ? 'step-done' : current ? 'step-current' : ''}`}><span className="step-marker">{done ? <Check size={14} /> : current && a.status === 'running' ? <span className="spin" /> : i + 1}</span><span>{s}</span><span className="mono">{done ? `${done.seconds}s` : current ? a.status === 'failed' ? '失败' : a.status === 'running' ? '进行中' : '已停止' : '未执行'}</span></div> })}</div>
        {detail.reports.length > 0 && <div className="notice info"><History /><div>已有成功保存的报告，仍可继续处理。<Button variant="q" onClick={() => setTab('latest')}>查看最新报告<ArrowRight /></Button></div></div>}
      </>}
      {report && <>
        {!report.latest && <div className="notice muted"><History /><div><strong>历史报告 · 只读</strong><p>新报告已保存。此报告中的待处理意见已被取代，原有处理记录保留。</p></div></div>}
        {report.mr_updated_at !== mr.updated_at && <div className="notice caution"><Info /><div><strong>报告基于旧版本</strong><p>MR 在这份报告生成后有更新。请结合当前代码判断，仍可发送最新报告中的意见。</p></div></div>}
        <div className="report-meta"><span><Clock3 />{time(report.created_at)}</span><span className="mono" title={report.source_commit}>{report.source_commit.slice(0, 10)}</span><span title={report.model}>{report.model}</span></div>
        {report.findings.length > 0 ? <>
          <div className="report-heading"><div><h2>检视意见 <span>{report.findings.length}</span></h2><p>{report.latest ? <>{pending.length} 条待处理<span className="separator">·</span>{check.length} 条需到 CodeHub 核对</> : '按严重程度、文件路径和行号排列'}</p></div><Button variant="q" disabled={busy(mr.attempt?.status)} onClick={rerun} loading={working === 'review'}><RefreshCw />重新检视</Button></div>
          <div className="finding-toolbar"><Button variant="s" disabled={!pending.length || !report.latest} onClick={nextPending}><ArrowDown />下一条待处理</Button><Button variant="q" onClick={() => setExpanded(!expanded)}>{expanded ? '收起修复建议' : '展开全部修复建议'}</Button>{report.latest && <Button variant="q" disabled={!pending.length || !!working} onClick={() => confirm({ title: '其余全部不发送', label: `确认不发送 ${pending.length} 条`, body: <p>将此报告剩余的 {pending.length} 条待处理意见标记为「不发送」。这是明确的处理决定，之后可逐条撤销。</p>, action: async () => { await act(`/reports/${report.id}/dismiss`, { confirmed: true }); await load() } })}>其余全部不发送</Button>}</div>
          <div className="finding-list">{report.findings.map(f => <FindingCard key={f.id} finding={f} report={report} mr={mr} disabled={!!working} sendDisabled={!!working || !!snapshot.sending} expanded={expanded} working={working} action={action => void execute(f.id, `/reports/${report.id}/findings/${f.id}/action`, { action })} makeRule={makeRule} />)}</div>
        </> : <div className="conclusion-panel"><div className="conclusion-icon"><CheckCheck /></div><Pill tone={report.conclusion === '未发现问题' ? 'success' : 'muted'}>检视完成</Pill><h2>{report.conclusion}</h2><p>{report.conclusion === '无可检视的变更' ? '排除文件后，没有可交给 AI 检视的变更。本次未调用 OpenCode。' : 'AI 已完成对本次变更的检视，没有发现经验证成立的问题。'}</p><span className="muted">报告已保存 · 0 条待处理意见</span><div><Button onClick={rerun} disabled={busy(mr.attempt?.status)}><RefreshCw />重新检视</Button><External url={mr.web_url}>在 CodeHub 查看</External></div></div>}
        <div className="report-appendix"><details><summary><ChevronDown size={14} />本次使用的规则<span>{report.rules.length}</span></summary>{report.rules.map(r => <div className="rule-snapshot" key={r.id}><strong>{r.name}</strong><span className="mono muted">{r.files.join(', ') || '全部文件'}</span><p className="pre-wrap">{r.points}</p>{r.good && <><b>正例</b><p className="pre-wrap">{r.good}</p></>}{r.bad && <><b>反例</b><p className="pre-wrap">{r.bad}</p></>}</div>)}{report.rules.length === 0 && <p className="muted">没有匹配本次变更的启用规则。</p>}{report.invalid_rules.map(r => <p className="danger-text" key={r.name}>已跳过格式错误规则：{r.name} · {r.reason}</p>)}</details><details><summary><ChevronDown size={14} />排除文件<span>{report.excluded.length}</span></summary>{report.excluded.map(f => <div className="excluded-file" key={f.path}><code>{f.path}</code><span>{f.reason}</span></div>)}{!report.excluded.length && <p className="muted">没有排除文件。</p>}</details></div>
        <div className="drawer-footer-note"><ShieldCheck />报告与处理记录只追加保存。AI 意见由你逐条确认。</div>
      </>}
    </div>
  </Modal>
}
function GitPullRequestIcon() { return <GitBranch size={13} aria-hidden="true" /> }
function FindingCard({ finding: f, report, mr, disabled, sendDisabled, expanded, working, action, makeRule }: { finding: Finding; report: Report; mr: MR; disabled: boolean; sendDisabled: boolean; expanded: boolean; working: string | null; action: (s: string) => void; makeRule: (r: Partial<Rule>) => void }) {
  const state = f.handling.state
  const handled = ['published', 'manual', 'dismissed', 'superseded'].includes(state)
  const location = `${f.location.path || '无法定位到具体文件'}${f.location.start_line ? `:${f.location.start_line}${f.location.end_line && f.location.end_line !== f.location.start_line ? `-${f.location.end_line}` : ''}` : ''}`
  return <article id={`finding-${f.id}`} tabIndex={-1} className={`finding-card ${handled ? 'handled' : ''}`}>
    <header className="finding-header"><div className="finding-title"><span className={`severity ${f.severity}`}>{f.severity[0].toUpperCase() + f.severity.slice(1)}</span><h3 title={f.title}>{f.title}</h3></div><div className="finding-actions"><Pill tone={tones[state]} spin={state === 'sending'}>{labels[state]}</Pill>{report.latest && <>
      {state === 'pending' && <><Button disabled={disabled} onClick={() => action('dismiss')}>不发送</Button><Button variant="p" disabled={sendDisabled} loading={working === f.id} onClick={() => action('send')}>发送到 CodeHub</Button></>}
      {state === 'failed' && <Button variant="p" disabled={sendDisabled} loading={working === f.id} onClick={() => action('send')}>重新发送</Button>}
      {state === 'dismissed' && <Button variant="q" disabled={disabled} onClick={() => action('undo')}>撤销</Button>}
    </>}</div></header>
    {['unknown', 'failed'].includes(state) && <div className={`finding-alert ${state === 'unknown' ? 'caution' : 'danger'}`}><TriangleAlert size={16} /><div><strong>{state === 'unknown' ? '发送结果未知，请先到 CodeHub 核对' : '发布失败，请排除原因后手动重新发送'}</strong><p>{f.handling.message}{f.handling.at ? `（${time(f.handling.at)}）` : ''}</p><div className="inline-actions"><External url={mr.web_url}>去核对</External>{state === 'unknown' && report.latest && <><Button disabled={disabled} onClick={() => action('confirm-published')}>标记已发布</Button><Button disabled={disabled} onClick={() => action('confirm-unpublished')}>确认未发布</Button></>}</div></div></div>}
    <div className="finding-body md">
      {f.rule && <span className="rule-tag">规则 · {f.rule}</span>}
      <h4>问题描述</h4><p className="pre-wrap">{plainText(f.summary)}</p>
      {!!f.tags?.length && <div className="tags">{f.tags.map(t => <code key={t}>#{t.replace(/^#/, '')}</code>)}</div>}
      <h4>问题位置</h4><code className="location">{location}</code>
      {f.related_code && <CodeBlock {...f.related_code} />}
      <h4>影响分析</h4><ul><li><strong>直接后果：</strong>{plainText(f.impact.consequence)}</li><li><strong>影响范围：</strong>{plainText(f.impact.scope)}</li><li><strong>触发条件：</strong>{plainText(f.impact.trigger)}</li></ul>
      <details className="solution" open={expanded || !handled}><summary><ChevronDown size={14} />查看修复建议</summary><h4>解决方案</h4>{f.solutions.map((s, i) => <div key={i}><p className="pre-wrap">{plainText(s.description)}</p>{s.code && <CodeBlock {...s.code} />}</div>)}{!!f.prevention?.length && <><h4>预防措施</h4><ul>{f.prevention.map((p, i) => <li key={i}>{plainText(p)}</li>)}</ul></>}</details>
      {(state === 'published' || state === 'manual') && <Button variant="q" className="derive-rule" onClick={() => makeRule({ name: `${f.title} · 规则`, scope: report.project_id, enabled: false, files: f.location.path ? [f.location.path] : [], points: f.summary, good: f.solutions.map(s => s.description + (s.code ? `\n${s.code.code}` : '')).join('\n'), bad: f.related_code?.code || f.summary })}><Plus size={14} />沉淀为规则草稿</Button>}
      {!!f.history.length && <details className="handling-history"><summary><History size={13} />处理记录 · {f.history.length}</summary>{f.history.map((h, i) => <div key={i}><span>{labels[h.state]}</span><time>{time(h.at)}</time>{h.message && <p>{h.message}</p>}</div>)}</details>}
    </div>
  </article>
}
