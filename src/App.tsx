import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ArrowRight, Check, ChevronDown, CircleHelp, Clock3, FileText, Folder, GitPullRequest, Layers3, ListChecks, MoreHorizontal, Plus, RefreshCw, Settings2, ShieldCheck, Trash2, X } from 'lucide-react'
import { api, ApiError, busy, time } from './api'
import type { MR, Project, Snapshot, Rule } from './types'
import { Button, Empty, External, Modal, Pill, Progress } from './components'
import { ReportDrawer } from './ReportDrawer'
import { RulesView } from './RulesView'
import { LogsView } from './LogsView'

type Confirmation = { title: string; body: ReactNode; label: string; danger?: boolean; action: () => Promise<unknown> }
export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [connection, setConnection] = useState('')
  const [view, setView] = useState('queue')
  const [pid, setPid] = useState(''), [pidMessage, setPidMessage] = useState('')
  const [adding, setAdding] = useState(false), [menu, setMenu] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ pid: string; iid: string } | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const [toast, setToast] = useState(''), [confirm, setConfirm] = useState<Confirmation | null>(null), [confirmBusy, setConfirmBusy] = useState(false)
  const [draft, setDraft] = useState<Partial<Rule> | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try { const data = await api<Snapshot>('/state'); setSnapshot(data); setConnection('') }
    catch (e) { setConnection(e instanceof Error ? e.message : '服务连接中断') }
  }, [])
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>
    const tick = async () => { if (disposed) return; await refresh(); if (!disposed) timer = setTimeout(tick, 1500) }
    void tick()
    return () => { disposed = true; clearTimeout(timer) }
  }, [refresh])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 5000); return () => clearTimeout(t) }, [toast])
  useEffect(() => { if (!highlight) return; const t = setTimeout(() => setHighlight(null), 5000); return () => clearTimeout(t) }, [highlight])
  const act = useCallback(async (path: string, body: unknown = {}, success?: string) => {
    const value = await api(path, body); await refresh(); if (success) setToast(success); return value
  }, [refresh])
  const run = async (key: string, action: () => Promise<unknown>) => {
    setWorking(key)
    try { await action() } catch (e) { setToast(e instanceof Error ? e.message : '操作失败') } finally { setWorking(null) }
  }
  const projects = snapshot?.projects || []
  const allMRs = projects.flatMap(p => p.mrs)
  const pendingMRs = allMRs.filter(m => m.pending > 0)
  const checkCount = allMRs.reduce((s, m) => s + m.check, 0)
  const open = (mr: MR) => setSelected({ pid: mr.project_id, iid: mr.iid })
  const add = async () => {
    if (!/^[1-9]\d*$/.test(pid)) { setPidMessage('Project ID 应为正整数'); return }
    const existing = projects.find(p => p.id === pid)
    if (existing) { setPidMessage(`该项目已在关注列表中：${existing.full_name}（${pid}）`); setHighlight(pid); return }
    setAdding(true); setPidMessage('')
    try {
      const value = await api<{ restored: number }>('/projects', { id: pid })
      setHighlight(pid); setPid(''); await refresh()
      setToast(value.restored ? `项目已关注，已恢复 ${value.restored} 份历史报告` : '已添加关注项目，点击「获取 MR」开始')
    } catch (e) { setPidMessage(e instanceof Error ? e.message : '添加失败') }
    finally { setAdding(false) }
  }
  const startReview = (mr: MR) => run(`review-${mr.project_id}-${mr.iid}`, () => act('/reviews', { project_id: mr.project_id, iid: mr.iid }, '已加入检视队列'))
  const stop = (mr: MR) => mr.attempt && run(mr.attempt.id, () => act(`/reviews/${mr.attempt!.id}/stop`, {}, '已请求停止'))
  const remove = (p: Project) => {
    setMenu(null)
    const affected = snapshot?.queue.filter(a => a.project_id === p.id) || []
    setConfirm({ title: '移除关注项目', label: '移除项目', danger: true,
      body: <><p>移除 <strong>{p.full_name}</strong> 后会清除代码缓存。报告和处理记录保留，重新添加项目后可见。</p>{affected.length > 0 && <div className="notice warning"><p>以下检视将停止：</p>{affected.map(a => <p key={a.id}>!{a.iid} · {a.status === 'queued' ? '排队中' : '检视中'}</p>)}</div>}</>,
      action: () => act(`/projects/${p.id}/remove`, { confirmed: true }, '已移除项目，历史记录已保留') })
  }
  if (!snapshot) return <div className="boot"><span className="logo-mark">rx<i /></span><h2>ReviewX</h2>{connection ? <><p role="alert">无法连接本地服务。请运行 <code>python -m reviewx</code> 后重试。</p><Button onClick={refresh}><RefreshCw />重新连接</Button></> : <p><span className="spin" /> 正在读取本地工作台…</p>}</div>
  return <>
    <div className="app-shell">
      <aside className="sidebar" aria-label="导航与项目">
        <div className="brand"><span className="logo-mark" aria-hidden="true">rx<i /></span><span>ReviewX</span></div>
        <nav aria-label="主导航">
          {[['queue', '检视队列', GitPullRequest], ['rules', '规则配置', Settings2], ['logs', '会话日志', FileText]].map(([id, label, Icon]) => {
            const I = Icon as typeof GitPullRequest
            return <button key={id as string} className="navlink" aria-current={view === id ? 'page' : undefined} onClick={() => { setView(id as string); setMenu(null) }}><I aria-hidden="true" />{label as string}{id === 'queue' && pendingMRs.length > 0 && <span className="nav-badge">{pendingMRs.length}</span>}</button>
          })}
        </nav>
        <section className="project-section"><h2>关注项目 <span>{projects.length || ''}</span></h2>
          <form onSubmit={e => { e.preventDefault(); void add() }} className="project-form">
            <label className="sr-only" htmlFor="project-id">Project ID</label>
            <input id="project-id" className="field" inputMode="numeric" placeholder="Project ID，例如 512" value={pid} onChange={e => { setPid(e.target.value); setPidMessage('') }} aria-invalid={!!pidMessage} aria-describedby="project-feedback" />
            <Button type="submit" loading={adding} disabled={adding || !pid.trim()} className="add-btn">{!adding && <Plus />}添加</Button>
          </form>
          {pidMessage && <p id="project-feedback" className="field-error" role="status">{pidMessage}</p>}
          {projects.length === 0 && <div className="sidebar-empty"><Folder /><p>还没有关注项目</p><span>输入仓库的数字 Project ID</span></div>}
          <ul className="project-list">{projects.map(p => <li key={p.id} className={highlight === p.id ? 'highlight' : ''}>
            <div className="project-folder"><Folder size={12} />{p.full_name.includes('/') ? p.full_name.slice(0, p.full_name.lastIndexOf('/')) : 'CodeHub'}</div>
            <div className="project-side-row">
              <span className={`project-dot ${p.fetch_status}`} title={p.fetch_status === 'failed' ? '获取失败' : p.fetch_status === 'updated' ? '已更新' : p.fetch_status === 'fetching' ? '获取中' : '尚未获取'} />
              <button className="text-button ellipsis" title={p.full_name} onClick={() => { setView('queue'); setTimeout(() => document.getElementById(`project-${p.id}`)?.scrollIntoView({ behavior: 'smooth' }), 0) }}>{p.full_name.split('/').pop()}</button>
              <span className="mono subtle">#{p.id}</span><Button variant="q" className="menu-trigger" aria-label={`${p.full_name} 项目菜单`} aria-expanded={menu === p.id} onClick={() => setMenu(menu === p.id ? null : p.id)}><MoreHorizontal /></Button>
            </div>
            {menu === p.id && <div className="project-menu" role="menu">
              <External url={p.web_url}>在 CodeHub 打开</External>
              <Button variant="q" role="menuitem" onClick={() => { setMenu(null); setConfirm({ title: '清除代码缓存', label: '清除缓存', body: <p>将清除 {p.full_name} 的本地代码缓存，下次检视会重新拉取。报告和处理记录保留。</p>, action: () => act(`/projects/${p.id}/clear-cache`, {}, '代码缓存已清除') }) }}>清除代码缓存</Button>
              <Button variant="q" role="menuitem" disabled={snapshot.sending?.project_id === p.id} className="danger-text" onClick={() => remove(p)}><Trash2 size={14} />移除项目…</Button>
            </div>}
          </li>)}</ul>
        </section>
        <div className="sidebar-foot"><span className="local-dot" />本机运行 · 数据保存在本地<div>AI 发现问题，你决定什么发出去。</div><span className="version">ReviewX 0.1.0</span></div>
      </aside>
      <main>
        {connection && <div className="notice danger" role="alert">与本地服务的连接中断，当前显示的是上次状态。{connection}<Button variant="q" onClick={refresh}>重新连接</Button></div>}
        {view === 'queue' && <>
          <header className="page-header"><div><h1>检视队列</h1></div>
            <div className="toolbar">
              <div className="popover-anchor"><Button onClick={() => setQueueOpen(!queueOpen)} aria-expanded={queueOpen}>{snapshot.queue.some(a => a.status !== 'queued') ? <span className="spin" /> : <Layers3 />}检视队列{snapshot.queue.length ? ` · ${snapshot.queue.length}` : ''}<ChevronDown size={12} /></Button>
                {queueOpen && <div className="queue-popover"><h3>当前检视队列</h3><p className="muted">全局串行执行，按加入顺序检视</p>{snapshot.queue.length === 0 ? <p className="muted">当前没有进行中或排队中的检视</p> : snapshot.queue.map((a, i) => <div className="queue-row" key={a.id}><span className="mono">!{a.iid}</span><div><strong>{projects.find(p => p.id === a.project_id)?.full_name}</strong><small>{a.status === 'queued' ? `排队中 · 第 ${snapshot.queue.filter(q => q.status === 'queued').findIndex(q => q.id === a.id) + 1}/${snapshot.queue.filter(q => q.status === 'queued').length} 位` : `步骤 ${a.step}/7 · ${a.message}`}</small></div><Button variant="q" disabled={a.status === 'stopping'} onClick={() => void run(a.id, () => act(`/reviews/${a.id}/stop`))}>{a.status === 'queued' ? '取消排队' : '停止'}</Button></div>)}</div>}
              </div>
              <Button disabled={!projects.length || snapshot.fetching || !!connection} loading={snapshot.fetching} onClick={() => void run('fetch', () => act('/fetch'))}>{!snapshot.fetching && <RefreshCw />}获取 MR</Button>
              <Button disabled={!pendingMRs.length} onClick={() => open(pendingMRs[0])}>下一个待处理 MR<ArrowRight /></Button>
            </div>
          </header>
          <div className="queue-summary"><span>{projects.length} 个关注项目<span className="separator">/</span>{allMRs.length} 个开放 MR</span><span className="summary-right">{snapshot.fetching ? <><span className="spin" />项目 {snapshot.fetch_progress.done}/{snapshot.fetch_progress.total} 完成 · {snapshot.fetch_progress.failed} 个失败</> : snapshot.fetch_progress.total > 0 ? `已更新 ${snapshot.fetch_progress.done - snapshot.fetch_progress.failed}/${snapshot.fetch_progress.total} 个项目${snapshot.fetch_progress.failed ? `，${snapshot.fetch_progress.failed} 个失败` : ''}` : '手动获取，按需检视'}</span></div>
          {pendingMRs.length > 0 && <div className="notice info review-notice"><ListChecks /><div><strong>{allMRs.reduce((s, m) => s + m.pending, 0)} 条意见等待你的决定</strong><span>来自 {pendingMRs.length} 个 MR。只有你点击发送，意见才会发布到 CodeHub。</span></div>{checkCount > 0 && <Pill tone="warning">{checkCount} 条需核对</Pill>}</div>}
          {projects.length === 0 ? <Empty icon={<GitPullRequest />} title="从一个项目开始检视"><p>添加你关注的 CodeHub 项目，手动获取开放 MR。<br />让 AI 发现问题，由你决定哪些意见值得发送。</p><Button variant="p" onClick={() => document.getElementById('project-id')?.focus()}><Plus />添加第一个项目</Button><div className="onboarding"><span><span>01</span>添加项目</span><ArrowRight /><span><span>02</span>获取并检视 MR</span><ArrowRight /><span><span>03</span>处理检视意见</span></div><div className="setup-note"><ShieldCheck />开始前，请在终端登录 CodeHub CLI，并配置 Git 与 OpenCode。</div></Empty>
          : projects.map(p => <section key={p.id} id={`project-${p.id}`} className="project-group">
            <div className="group-header"><div className="group-title"><Folder /><h2>{p.full_name}</h2><span className="count">{p.mrs.length}</span></div><div className="group-meta"><span>{p.fetched_at ? `获取于 ${time(p.fetched_at)}` : '尚未获取'}</span>{p.fetch_status === 'fetching' ? <Pill spin>获取中</Pill> : p.fetch_status === 'updated' ? <Pill tone="success">已更新</Pill> : p.fetch_status === 'failed' ? <Pill tone="danger">获取失败</Pill> : null}</div></div>
            {p.fetch_status === 'failed' && <div className="notice danger">{p.error}。保留上次成功的结果。<Button variant="q" disabled={snapshot.fetching} onClick={() => void run('fetch', () => act('/fetch', { project_id: p.id }))}><RefreshCw />重新获取</Button></div>}
            {p.mrs.length === 0 ? <div className="project-empty"><GitPullRequest /><span>{p.fetch_status === 'updated' ? '当前没有开放的 MR' : '获取项目的开放 MR，开始一次新的检视'}</span><Button onClick={() => void run('fetch', () => act('/fetch', { project_id: p.id }))} disabled={snapshot.fetching}>获取 MR</Button></div> : <>
              <div className={`mr-grid ${p.fetch_status === 'failed' ? 'stale-group' : ''}`}>{p.mrs.filter(m => !isCompact(m)).map(m => <MRCard key={m.iid} mr={m} highlighted={pendingMRs[0] === m} snapshot={snapshot} open={() => open(m)} start={() => void startReview(m)} stop={() => void stop(m)} working={working} />)}</div>
              {p.mrs.some(isCompact) && <details className="completed-list" open><summary><ChevronDown size={14} /><span>已完成 / 无需处理</span><span className="muted">{p.mrs.filter(isCompact).length}</span></summary><div>{p.mrs.filter(isCompact).map(m => <div className="compact-mr" key={m.iid}><span className="mono subtle">!{m.iid}</span><button className="text-button ellipsis" onClick={() => open(m)}>{m.title}</button>{m.stale && <Pill tone="caution">旧版本</Pill>}<span className="success-text"><Check size={13} />{m.conclusion === '发现问题' ? '已处理完' : m.conclusion}</span><External url={m.web_url}><span className="sr-only">打开 MR</span></External></div>)}</div></details>}
            </>}
          </section>)}
          {projects.length > 0 && <div className="page-note"><ShieldCheck />检视由你发起，意见由你确认。报告和处理记录始终保留。</div>}
        </>}
        {view === 'rules' && <RulesView projects={projects} act={act} toast={setToast} draft={draft} clearDraft={() => setDraft(null)} confirm={setConfirm} />}
        {view === 'logs' && <LogsView />}
      </main>
    </div>
    {selected && (() => {
      const project = projects.find(p => p.id === selected.pid), mr = project?.mrs.find(m => m.iid === selected.iid)
      return project && mr ? <ReportDrawer mr={mr} project={project} snapshot={snapshot} close={() => setSelected(null)} act={act} toast={setToast} confirm={setConfirm} goLogs={() => { setSelected(null); setView('logs') }} makeRule={rule => { setDraft(rule); setSelected(null); setView('rules') }} /> : <Modal title="MR 已离开开放列表" close={() => setSelected(null)}><p>该 MR 已不在最近获取的开放列表中。历史报告和处理记录已保留。</p><Button onClick={() => setSelected(null)}>关闭</Button></Modal>
    })()}
    {confirm && <Modal title={confirm.title} close={() => { if (!confirmBusy) setConfirm(null) }}><div className="modal-body">{confirm.body}</div><div className="modal-actions"><Button disabled={confirmBusy} onClick={() => setConfirm(null)}>取消</Button><Button variant={confirm.danger ? 'd' : 'p'} loading={confirmBusy} onClick={async () => { setConfirmBusy(true); try { await confirm.action(); setConfirm(null) } catch (e) { setToast(e instanceof Error ? e.message : '操作失败') } finally { setConfirmBusy(false) } }}>{confirm.label}</Button></div></Modal>}
    {toast && <div className="toast" role="status">{toast}<button aria-label="关闭提示" onClick={() => setToast('')}><X size={14} /></button></div>}
  </>
}
function isCompact(mr: MR) { return !!mr.report_id && !mr.pending && !mr.check && !busy(mr.attempt?.status) && mr.attempt?.status !== 'failed' }
function MRCard({ mr, highlighted, snapshot, open, start, stop, working }: { mr: MR; highlighted: boolean; snapshot: Snapshot; open: () => void; start: () => void; stop: () => void; working: string | null }) {
  const a = mr.attempt, active = busy(a?.status), failed = a?.status === 'failed'
  const queue = snapshot.queue.filter(q => q.status === 'queued')
  return <article className={`mr-card ${highlighted ? 'next-card' : ''} ${failed ? 'failed-card' : ''}`}>
    <div className="mr-top"><span className="mono">!{mr.iid}</span>{mr.stale && <Pill tone="caution">报告基于旧版本</Pill>}{highlighted && !mr.stale && <span className="next-label">下一个待处理</span>}<External url={mr.web_url}><span className="sr-only">在 CodeHub 打开 MR !{mr.iid}</span></External></div>
    <h3><button className="text-button" onClick={open}>{mr.title}</button></h3>
    <div className="mr-meta" title={`${mr.source_branch} → ${mr.target_branch}`}>更新于 {time(mr.updated_at)}<span>·</span><span className="mono">{mr.source_branch}</span></div>
    {active && <Progress step={a!.step} />}
    <div className="mr-footer"><div className={`mr-state ${failed ? 'danger-text' : mr.pending ? 'info-text' : ''}`}><span className={a?.status === 'running' ? 'spin' : 'dot'} /><span>{a?.status === 'queued' ? `排队中 · 第 ${queue.findIndex(q => q.id === a.id) + 1}/${queue.length} 位` : a?.status === 'running' ? `检视中 · 步骤 ${a.step}/7` : a?.status === 'stopping' ? '停止中…' : failed ? `检视失败 · 步骤 ${a.step}/7` : mr.pending ? `${mr.pending} 条待处理` : mr.check ? `${mr.check} 条需核对` : a?.status === 'stopped' ? '已停止' : '暂无检视记录'}</span>{mr.check > 0 && mr.pending > 0 && <small className="warning-text">{mr.check} 条需核对</small>}</div>
      {active ? <Button disabled={a!.status === 'stopping' || working === a!.id} onClick={stop}>{a!.status === 'queued' ? '取消排队' : a!.status === 'stopping' ? '停止中…' : '停止检视'}</Button> : mr.report_id || failed ? <Button variant={highlighted ? 'p' : 's'} onClick={open}>{failed ? '查看原因' : '查看报告'}<ArrowRight size={14} /></Button> : <Button variant="p" disabled={working === `review-${mr.project_id}-${mr.iid}`} onClick={start}>开始检视<ArrowRight size={14} /></Button>}
    </div>
    {a?.status === 'running' && <div className="card-progress-label">{a.message}</div>}
  </article>
}
