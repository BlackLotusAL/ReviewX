let csrf = ''
export type ApiTransport = (path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>
let transport: ApiTransport | undefined
export function setApiTransport(value: ApiTransport) { transport = value }
export class ApiError extends Error {
  constructor(message: string, public code?: string) { super(message) }
}
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (transport) return await transport(path, body, signal) as T
  const response = await fetch('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-ReviewX-CSRF': csrf },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  })
  const result = await response.json()
  if (!response.ok) throw new ApiError(result.error || '操作失败，请重试', result.code)
  if (result.csrf) csrf = result.csrf
  return result as T
}
export const time = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚未获取'
export const duration = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
export const busy = (status?: string) => ['queued', 'running', 'stopping'].includes(status || '')
export const safeUrl = (url: string) => { try { const u = new URL(url); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? url : '' } catch { return '' } }
export const plainText = (text: string) => text.replace(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '[图片] $1')
