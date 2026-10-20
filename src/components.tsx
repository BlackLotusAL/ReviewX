import { useEffect, useRef, type ReactNode, type ButtonHTMLAttributes } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { safeUrl } from './api'

export function Button({ variant = 's', children, loading, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'p' | 's' | 'q' | 'd'; loading?: boolean }) {
  return <button type="button" {...props} className={`btn btn-${variant} ${props.className || ''}`} disabled={props.disabled || loading}>{loading && <span className="spin" aria-hidden="true" />}{children}</button>
}
export function Pill({ tone = 'muted', children, spin = false }: { tone?: string; children: ReactNode; spin?: boolean }) {
  return <span className={`pill ${tone}`}>{spin ? <span className="spin" aria-hidden="true" /> : <span className="dot" aria-hidden="true" />}{children}</span>
}
export function External({ url, children, className = '' }: { url: string; children?: ReactNode; className?: string }) {
  const safe = safeUrl(url)
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer" className={`external ${className}`} onClick={e => e.stopPropagation()}>{children}<ExternalLink size={12} aria-hidden="true" /></a> : <span className="muted">{children}</span>
}
export function Progress({ step }: { step: number }) {
  return <div className="progress" role="img" aria-label={`检视进度 ${step}/7`}>{Array.from({ length: 7 }, (_, n) => <i key={n} className={n + 1 < step ? 'done' : n + 1 === step ? 'current' : ''} />)}</div>
}
export function Modal({ title, children, close, drawer = false }: { title: string; children: ReactNode; close: () => void; drawer?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(close); closeRef.current = close
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const old = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ref.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      // Only the topmost dialog should handle a key.
      if (document.querySelectorAll('[aria-modal="true"]')[document.querySelectorAll('[aria-modal="true"]').length - 1] !== ref.current) return
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current() }
      if (event.key === 'Tab') {
        const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select, textarea, summary, [tabindex="0"]') || [])].filter(e => e.getClientRects().length)
        const first = nodes[0], last = nodes[nodes.length - 1]
        if (!first) { event.preventDefault(); return }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = old; before?.focus() }
  }, [])
  return <div className={`scrim ${drawer ? 'drawer-scrim' : 'modal-scrim'}`} onMouseDown={e => { if (e.target === e.currentTarget) close() }}>
    <div role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={drawer ? 'drawer' : 'modal'} ref={ref}>
      {!drawer && <div className="modal-title"><h3>{title}</h3><Button variant="q" className="icon-btn" aria-label="关闭对话框" onClick={close}><X /></Button></div>}
      {children}
    </div>
  </div>
}
export function Empty({ icon, title, children, compact = false }: { icon: ReactNode; title: string; children?: ReactNode; compact?: boolean }) {
  return <div className={`empty ${compact ? 'compact-empty' : ''}`}><div className="empty-symbol">{icon}</div><h2>{title}</h2>{children}</div>
}
export function CodeBlock({ code, language }: { code: string; language?: string }) {
  // React text nodes only: even HTML, links and remote images remain inert.
  const tokens = code.split(/(\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|return|if|else|async|await|function|def|class|import|from|throw|new|public|private|void|try|catch|true|false|null)\b|\b\d+\b)/g)
  return <div className="code-wrap">{language && <div className="code-language">{language}</div>}<pre className="code"><code>{tokens.map((token, i) => <span key={i} className={token.startsWith('//') ? 'syntax-comment' : /^["']/.test(token) ? 'syntax-string' : /^\d+$/.test(token) ? 'syntax-number' : /^(const|let|return|if|else|async|await|function|def|class|import|from|throw|new|public|private|void|try|catch|true|false|null)$/.test(token) ? 'syntax-keyword' : ''}>{token}</span>)}</code></pre></div>
}
