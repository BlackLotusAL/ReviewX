export type Severity = 'fatal' | 'major' | 'minor' | 'suggestion'
export type HandlingState = 'pending' | 'sending' | 'published' | 'manual' | 'dismissed' | 'unknown' | 'failed' | 'superseded'
export interface Handling { state: HandlingState; at?: string; message?: string; manual?: boolean; comment_id?: string }
export interface Finding {
  id: string; severity: Severity; title: string; summary: string; tags?: string[]; rule?: string
  location: { path: string; start_line?: number; end_line?: number }
  related_code?: Code; impact: { consequence: string; scope: string; trigger: string }
  solutions: { description: string; code?: Code }[]; prevention?: string[]
  handling: Handling; history: Handling[]
}
export interface Code { code: string; language?: string }
export interface Attempt {
  id: string; project_id: string; iid: string; status: 'queued' | 'running' | 'stopping' | 'stopped' | 'failed' | 'completed'
  step: number; message: string; created_at: string; started_at?: string; ended_at?: string; step_started_at?: string
  ai_started_at?: string; current?: number; total?: number; queue_stopped?: boolean
  steps: { number: number; seconds: number }[]
}
export interface MR {
  iid: string; project_id: string; title: string; source_branch: string; target_branch: string; updated_at: string
  web_url: string; attempt: Attempt | null; report_id: string | null; conclusion: string | null
  pending: number; check: number; stale: boolean; report_at: string | null
}
export interface Project {
  id: string; full_name: string; web_url: string; fetch_status: 'idle' | 'fetching' | 'updated' | 'failed'
  fetched_at: string | null; error: string | null; mrs: MR[]
}
export interface Rule {
  id: string; name: string; scope: string; enabled: boolean; files: string[]; points: string; good: string; bad: string
  error?: string | null; builtin?: boolean; stats?: { hits: number; sent: number; dismissed: number }
}
export interface Report {
  id: string; project_id: string; iid: string; project_name: string; mr_title: string; mr_updated_at: string
  source_commit: string; target_commit: string; model: string; created_at: string; latest: boolean
  rules: Rule[]; invalid_rules: { name: string; reason: string }[]; excluded: { path: string; reason: string }[]
  conclusion: string; findings: Finding[]
}
export interface Snapshot {
  csrf: string; projects: Project[]; queue: Attempt[]; fetching: boolean
  fetch_progress: { total: number; done: number; failed: number }
  sending: { report_id: string; finding_id: string; project_id: string } | null
  steps: string[]; timeout: number
}
export interface Detail { reports: Report[]; attempts: Attempt[] }
export interface Log { at: string; level: 'INFO' | 'WARN' | 'ERROR'; message: string; owner?: string; project_id?: string; iid?: string; [key: string]: unknown }
