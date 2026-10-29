export type MemoryKind =
  | 'episode'
  | 'fact'
  | 'preference'
  | 'boundary'
  | 'promise'
  | 'relationship'
  | 'chapter'

export type MemoryStatus = 'active' | 'superseded' | 'archived' | 'pending_review'

export type OpenLoopKind = 'promise' | 'plan' | 'unresolved_topic' | 'question'
export type OpenLoopStatus = 'open' | 'closed' | 'stale'

export interface Person {
  id: string
  platform: string
  externalId: string
  name: string
  createdAt: string
}

export interface Session {
  id: string
  personId: string
  title: string
  startedAt: string
  endedAt: string | null
  status: 'active' | 'ended'
  extractedSeq: number
}

export interface Message {
  id: number
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  injectedMemoryIds: string[]
}

export interface Memory {
  id: string
  personId: string
  kind: MemoryKind
  level: number
  text: string
  occurredAt: string | null
  validFrom: string | null
  validTo: string | null
  valence: number
  arousal: number
  salience: number
  confidence: number
  status: MemoryStatus
  supersedes: string | null
  supersededBy: string | null
  sourceSessionId: string | null
  sourceMessageIds: number[]
  pinned: boolean
  accessCount: number
  lastAccess: string | null
  createdAt: string
}

export interface OpenLoop {
  id: string
  personId: string
  text: string
  kind: OpenLoopKind
  dueAt: string | null
  status: OpenLoopStatus
  sourceMemoryId: string | null
  sourceMessageIds: number[]
  createdAt: string
  closedAt: string | null
}

export interface RelationshipEntry {
  key: string
  value: string
  updatedAt: string
}

export interface RecallHit {
  memory: Memory
  bm25: number
  norm: number
  recency: number
  salience: number
  pinned: boolean
  final: number
}

export interface RetrievalResult {
  query: string
  mode: 'fts' | 'like' | 'empty'
  hits: RecallHit[]
  selected: Memory[]
}

export interface SessionBrief {
  relationship: RelationshipEntry[]
  openLoops: OpenLoop[]
  episodes: Memory[]
  pinned: Memory[]
  text: string
}
