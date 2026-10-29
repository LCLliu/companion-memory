import type { Memory, MemoryKind, Message, OpenLoop, Session, SessionBrief } from '../core/types.ts'

export interface ApiConfig {
  chatModel: string
  extractModel: string
  keyConfigured: boolean
  dbPath: string
  phase: string
}

export interface Stats {
  sessions: number
  messages: number
  memories: number
  episodes: number
  facts: number
  openLoops: number
}

export interface DebugItem {
  id: string
  text: string
  kind: MemoryKind
  status: string
  pinned: boolean
  bm25: number
  norm: number
  recency: number
  salience: number
  final: number
  selected: boolean
}

export interface DebugResult {
  query: string
  mode: string
  items: DebugItem[]
}

export interface DetailResult {
  memory: Memory
  sourceMessages: Message[]
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  }
  // 没有 body 的 POST 不能带 content-type: application/json，否则 Fastify 会拒绝空 body。
  if (init.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json'
  }
  const response = await fetch(path, {
    ...init,
    headers,
  })
  const body = (await response.json().catch(() => ({}))) as any
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.message ?? `请求失败（${response.status}）`)
  }
  return body as T
}

export const get = <T>(path: string): Promise<T> => api<T>(path)

export const post = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const del = <T>(path: string): Promise<T> => api<T>(path, { method: 'DELETE' })

export interface SessionList {
  items: Session[]
}

export interface MemoryList {
  items: Memory[]
}

export interface OpenLoopList {
  items: OpenLoop[]
}

export interface SessionDetail {
  session: Session
  messages: Message[]
  brief: SessionBrief
  turnCount: number
}

export interface BriefResult {
  brief: SessionBrief
}

export interface RememberResult {
  duplicate: boolean
  memory: Memory
}

export interface ExtractResult {
  episodeId: string | null
  factIds: string[]
  openLoopIds: string[]
  closedLoopIds: string[]
  skipped: number
  model: string
  extractedMessages: number
}

export interface ExtractResponse {
  result: ExtractResult
}
