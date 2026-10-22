import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { ArrowUpRight, RotateCcw } from 'lucide-react'
import App from '../App'
import { setApiTransport } from '../api'
import { scenarios, type Scenario } from './fixtures'
import { createPreviewTransport } from './store'
import '../styles.css'
import './preview.css'

const readScenario = (): Scenario => scenarios.find(s => s.id === window.location.hash.slice(1))?.id || 'workspace'
const initial = readScenario()
// Install before mounting App so even its first request stays in the preview.
setApiTransport(createPreviewTransport(initial))

function Preview() {
  const [selection, setSelection] = useState({ scenario: initial, revision: 0 })
  const toolbar = useRef<HTMLElement>(null)
  const scenario = scenarios.find(s => s.id === selection.scenario)!
  const show = (next: Scenario) => {
    setApiTransport(createPreviewTransport(next))
    window.history.replaceState(null, '', `#${next}`)
    setSelection(current => ({ scenario: next, revision: current.revision + 1 }))
    window.scrollTo(0, 0)
  }
  useEffect(() => {
    const onHashChange = () => show(readScenario())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  useEffect(() => {
    const node = toolbar.current!
    const observer = new ResizeObserver(() => document.documentElement.style.setProperty('--preview-height', `${node.offsetHeight}px`))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return <>
    <header className="preview-toolbar" ref={toolbar} aria-label="预览控制栏">
      <div className="preview-identity"><span className="preview-badge">PREVIEW</span><span>演示数据</span></div>
      <label className="preview-scenario">场景<select className="field" value={selection.scenario} onChange={e => show(e.target.value as Scenario)}>{scenarios.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
      <button className="btn btn-s" onClick={() => show(selection.scenario)}><RotateCcw />重置演示</button>
      <a className="preview-exit" href="/">返回应用<ArrowUpRight size={14} /></a>
    </header>
    <App key={selection.revision} initialView={scenario.view} initialSelection={'iid' in scenario ? { pid: '101', iid: scenario.iid } : undefined} />
  </>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Preview /></React.StrictMode>)
