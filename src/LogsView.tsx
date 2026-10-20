import { useEffect, useMemo, useState } from 'react'
import { Download, FileText, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import { api } from './api'
import { Button, Empty } from './components'
import type { Log } from './types'

export function LogsView() {
  const [logs, setLogs] = useState<Log[]>([]), [error, setError] = useState(''), [level, setLevel] = useState('all')
  const [search, setSearch] = useState(''), [date, setDate] = useState(''), [refreshing, setRefreshing] = useState(false)
  const load = async () => { setRefreshing(true); try { const result = await api<{ logs: Log[] }>(`/logs${date ? `?date=${date}` : ''}`); setLogs(result.logs); setError('') } catch (e) { setError(e instanceof Error ? e.message : '读取失败') } finally { setRefreshing(false) } }
  useEffect(() => { void load() }, [date])
  const visible = useMemo(() => logs.filter(l => (level === 'all' || l.level === level) && JSON.stringify(l).toLowerCase().includes(search.toLowerCase())), [logs, level, search])
  const exportLogs = () => {
    const url = URL.createObjectURL(new Blob([visible.map(l => JSON.stringify(l)).join('\n')], { type: 'application/x-ndjson' }))
    const link = document.createElement('a'); link.href = url; link.download = `reviewx-${date || 'logs'}.jsonl`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <>
    <header className="page-header"><div><h1>会话日志</h1></div><div className="toolbar"><Button onClick={exportLogs} disabled={!visible.length}><Download />导出日志</Button><Button onClick={() => void load()} loading={refreshing}><RefreshCw />刷新</Button></div></header>
    <p className="page-description">查看检视、获取 MR 与意见发送记录，追溯每一步的运行情况。</p>
    <div className="log-toolbar"><div className="tabs" role="tablist" aria-label="日志级别">{[['all', '全部'], ['INFO', 'INFO'], ['WARN', 'WARN'], ['ERROR', 'ERROR']].map(([key, label]) => <button role="tab" aria-selected={level === key} key={key} onClick={() => setLevel(key)}>{label}<span>{logs.filter(l => key === 'all' || l.level === key).length}</span></button>)}</div><label className="search-field"><Search size={15} /><input aria-label="搜索日志" placeholder="搜索日志、MR 或项目…" value={search} onChange={e => setSearch(e.target.value)} /></label><input className="field date-field" type="date" aria-label="日志日期" value={date} onChange={e => setDate(e.target.value)} /></div>
    {error && <div className="notice danger" role="alert">{error}</div>}
    <div className="log-panel"><div className="log-panel-head"><span>运行记录</span><span>{visible.length} 条 · 最近记录在前</span></div>{visible.length ? visible.map((log, i) => {
      const extras = Object.entries(log).filter(([k]) => !['at', 'level', 'message', 'project_id', 'iid'].includes(k))
      return <div className={`log-row ${log.level.toLowerCase()}`} key={`${log.at}-${i}`}><time className="mono">{new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</time><span className="log-level">{log.level}</span><div><span>{log.message}</span>{log.project_id && <small>项目 #{String(log.project_id)}{log.iid ? ` · !${log.iid}` : ''}</small>}{extras.length > 0 && <details><summary>查看详细记录</summary><pre>{extras.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`).join('\n')}</pre></details>}</div></div>
    }) : <Empty compact icon={<FileText />} title={search || level !== 'all' ? '没有匹配的日志' : '暂无会话日志'}><p>运行记录会在操作后出现在这里。</p></Empty>}</div>
    <div className="page-note"><ShieldCheck />日志已脱敏，保留 30 天，总量不超过 100 MB。列表最多显示最近 1,000 条记录。</div>
  </>
}
