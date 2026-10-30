import type {
  Contradiction,
  Intention,
  MaintenanceRun,
  Memory,
  MemoryKind,
  Message,
  MindState,
  OpenLoop,
  Reflection,
  RelationshipSnapshot,
  Session,
  SessionBrief,
  Thought,
} from '../core/types.ts'

export interface ApiConfig {
  chatModel: string
  extractModel: string
  keyConfigured: boolean
  dbPath: string
  phase: string
  mindMode: 'off' | 'shadow' | 'on'
  mindModel: string
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
  emotion: number
  reinforcement: number
  unresolved: number
  final: number
  selected: boolean
  via: 'search' | 'edge'
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
  followUp: Intention | null
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
  reflection: Reflection | null
  intention: Intention | null
  reflectionError?: string
}

export interface MindPayload {
  mode: 'off' | 'shadow' | 'on'
  model: string
  state: MindState
  thoughts: Thought[]
  reflections: Reflection[]
  intentions: Intention[]
  followUps: Intention[]
  relationship: Array<{ key: string; value: string; updatedAt: string }>
  relationshipSnapshot: RelationshipSnapshot
  contradictions: Array<Contradiction & { aText: string; bText: string }>
  maintenance: MaintenanceRun | null
}

export interface MindMeta {
  mode: 'off' | 'shadow' | 'on'
  slow: boolean
  reasons: string[]
  plan: {
    chosen: string
    tone: string
    thoughtSummary: string
    confidence: number
  } | null
  appraisal: {
    label: string
    valence: number
    arousal: number
    needs: string[]
    summary: string
  } | null
  followUp: { id: string; text: string; dueAt: string | null } | null
  state: {
    moodValence: number
    moodArousal: number
    energy: number
    attention: string
    currentConcern: string
  }
}

export interface MaintenanceResponse {
  run: MaintenanceRun
}

export interface MindPreview {
  mode: 'off' | 'shadow' | 'on'
  state: MindState
  percept: {
    intent: string
    emotion: { label: string; valence: number; arousal: number; confidence: number }
    urgency: number
    relationshipCue: boolean
    ambiguity: number
    needs: string[]
    risk: string
    attachments: unknown[]
    modalityNotes: string[]
  }
  slow: boolean
  reasons: string[]
}
