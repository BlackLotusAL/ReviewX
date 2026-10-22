import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, Copy, FileCode2, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { api } from './api'
import { Button, Empty, Pill } from './components'
import type { Project, Rule } from './types'

type Props = {
  projects: Project[]; act: (path: string, body?: unknown, success?: string) => Promise<unknown>; toast: (s: string) => void
  draft: Partial<Rule> | null; clearDraft: () => void
  confirm: (c: { title: string; body: ReactNode; label: string; danger?: boolean; action: () => Promise<unknown> }) => void
}
const blank: Rule = { id: '', name: '', scope: 'global', enabled: false, files: [], points: '', good: '', bad: '' }
export function RulesView({ projects, act, toast, draft, clearDraft, confirm }: Props) {
  const [rules, setRules] = useState<Rule[]>([]), [unassigned, setUnassigned] = useState({ hits: 0, sent: 0, dismissed: 0 })
  const [selected, setSelected] = useState<Rule | null>(draft ? { ...blank, ...draft } : null)
  const [scope, setScope] = useState('all'), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const [fileText, setFileText] = useState(draft?.files?.join(', ') || '')
  const load = async () => { const result = await api<{ rules: Rule[]; unassigned: typeof unassigned }>('/rules'); setRules(result.rules); setUnassigned(result.unassigned) }
  useEffect(() => { void load().catch(e => setError(e.message)); if (draft) clearDraft() }, [])
  const edit = (rule: Rule) => { setSelected({ ...rule }); setFileText(rule.files.join(', ')); setError('') }
  const save = async () => {
    if (!selected) return
    if (!selected.name.trim() || !selected.points.trim()) { setError('请填写规则名称和检查要点'); return }
    setLoading(true)
    try { await act(selected.id ? `/rules/${selected.id}/save` : '/rules', { ...selected, files: fileText.split(/[,，\n]/).map(s => s.trim()).filter(Boolean) }); await load(); setSelected(null); toast('规则已保存，下次检视开始时生效') }
    catch (e) { setError(e instanceof Error ? e.message : '保存失败') }
    finally { setLoading(false) }
  }
  const toggle = async (r: Rule) => {
    try { await act(`/rules/${r.id}/save`, { ...r, enabled: !r.enabled }); await load() }
    catch (e) { toast(e instanceof Error ? e.message : '更新失败') }
  }
  const visible = rules.filter(r => scope === 'all' || r.scope === scope)
  return <>
    <header className="page-header"><div><h1>规则配置</h1></div><div className="toolbar"><Button onClick={() => void load().catch(e => setError(e.message))}><RefreshCw />刷新</Button><Button variant="p" onClick={() => edit({ ...blank })}><Plus />新建规则</Button></div></header>
    <div className="rules-toolbar"><div className="tabs" role="tablist" aria-label="规则范围"><button role="tab" aria-selected={scope === 'all'} onClick={() => setScope('all')}>全部规则 <span>{rules.length}</span></button><button role="tab" aria-selected={scope === 'global'} onClick={() => setScope('global')}>全局</button></div><label className="scope-select">项目范围<select className="field" value={scope === 'global' || scope === 'all' ? '' : scope} onChange={e => setScope(e.target.value || 'all')}><option value="">全部项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></label><span className="muted">效果统计 · 近 30 天</span></div>
    {error && !selected && <div className="notice danger" role="alert">{error}</div>}
    <div className={`rules-layout ${selected ? 'editing' : ''}`}>
      <div><div className="table-scroll"><table className="rules-table"><thead><tr><th>规则名称 / 适用范围</th><th>状态</th><th>命中</th><th>发送</th><th>不发送</th><th>采纳率</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{visible.map(r => { const stats = r.stats || { hits: 0, sent: 0, dismissed: 0 }, rate = stats.sent + stats.dismissed ? `${Math.round(stats.sent / (stats.sent + stats.dismissed) * 100)}%` : '—'; return <tr key={r.id} className={selected?.id === r.id ? 'selected' : ''}><td><button className="text-button rule-name" onClick={() => edit(r)}>{r.name}{r.builtin && <span>内置</span>}</button><div className="rule-scope">{r.scope === 'global' ? '全局' : projects.find(p => p.id === r.scope)?.full_name || `项目 #${r.scope}`}<span>·</span><code>{r.files.join(', ') || '全部文件'}</code></div>{r.error && <p className="field-error">{r.error}</p>}</td><td>{r.error ? <Pill tone="danger">格式错误</Pill> : <button className="switch" role="switch" aria-checked={r.enabled} aria-label={`${r.name}规则${r.enabled ? '已启用' : '已停用'}`} onClick={() => void toggle(r)}><i /></button>}</td><td>{stats.hits}</td><td>{stats.sent}</td><td>{stats.dismissed}</td><td>{rate}</td><td><Button variant="q" className="icon-btn" aria-label={`复制${r.name}规则`} onClick={() => edit({ ...r, id: '', name: `${r.name}（副本）`, builtin: false, enabled: false })}><Copy size={15} /></Button><Button variant="q" className="icon-btn" aria-label={`删除${r.name}规则`} onClick={() => confirm({ title: '删除规则', label: '删除规则', danger: true, body: <p>删除「{r.name}」后，它将不再用于后续检视。旧报告中的规则快照保留。</p>, action: async () => { await act(`/rules/${r.id}/delete`); if (selected?.id === r.id) setSelected(null); await load() } })}><Trash2 size={15} /></Button></td></tr> })}</tbody></table></div>
        {!visible.length && <Empty compact icon={<FileCode2 />} title="这个范围还没有规则"><Button onClick={() => edit({ ...blank, scope: scope === 'all' ? 'global' : scope })}><Plus />新建规则</Button></Empty>}
        <div className="rule-unassigned"><span>未归属规则</span><span>{unassigned.hits} 次命中</span><span>{unassigned.sent} 次发送</span><span>{unassigned.dismissed} 次不发送</span></div>
        <details className="table-note"><summary><ChevronDown size={13} />统计口径</summary><p>采纳率 = 发送 ÷（发送 + 不发送）。发送包含发布失败和结果未知；待处理意见不计入。</p></details>
      </div>
      {selected && <section className="rule-editor" aria-label="规则编辑器"><div className="editor-head"><h3>{selected.id ? '编辑规则' : '新规则草稿'}</h3><Button variant="q" className="icon-btn" onClick={() => setSelected(null)} aria-label="关闭规则编辑器"><X /></Button></div>
        <form onSubmit={e => { e.preventDefault(); void save() }}>
          <label>规则名称<input className="field" value={selected.name} onChange={e => setSelected({ ...selected, name: e.target.value })} placeholder="例如：数据库事务一致性" required /></label>
          <label>作用范围<select className="field" value={selected.scope} onChange={e => setSelected({ ...selected, scope: e.target.value })}><option value="global">全局</option>{projects.map(p => <option value={p.id} key={p.id}>{p.full_name}</option>)}</select></label>
          <label>适用文件<input className="field mono" aria-label="适用文件" aria-describedby="rule-files-help" value={fileText} onChange={e => setFileText(e.target.value)} placeholder="*.java, src/db/**" /><small id="rule-files-help">逗号分隔，留空表示全部文件</small></label>
          <label>检查要点<textarea className="field" rows={6} value={selected.points} onChange={e => setSelected({ ...selected, points: e.target.value })} placeholder="描述需要重点检查的内容与判断依据…" required /></label>
          <label>正例<textarea className="field mono" rows={3} value={selected.good} onChange={e => setSelected({ ...selected, good: e.target.value })} placeholder="推荐的实现方式" /></label>
          <label>反例<textarea className="field mono" rows={3} value={selected.bad} onChange={e => setSelected({ ...selected, bad: e.target.value })} placeholder="应当避免的代码或模式" /></label>
          <div className="editor-enable"><span>保存后启用</span><button type="button" className="switch" role="switch" aria-label="保存后启用" aria-checked={selected.enabled} onClick={() => setSelected({ ...selected, enabled: !selected.enabled })}><i /></button></div>
          {error && <p className="field-error" role="alert">{error}</p>}
          <div className="editor-actions"><Button onClick={() => setSelected(null)}>取消</Button><Button type="submit" variant="p" loading={loading}><Save size={15} />保存规则</Button></div>
        </form>
      </section>}
    </div>
  </>
}
