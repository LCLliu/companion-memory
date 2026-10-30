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
  unresolved: boolean
  emotionalCharge: number
  lastReinforced: string | null
  sourceThoughtId: string | null
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

export type MindMode = 'off' | 'shadow' | 'on'
export type ThoughtKind =
  | 'appraisal'
  | 'option'
  | 'critique'
  | 'reflection'
  | 'intention_candidate'
  | 'summary'

export type IntentionKind = 'follow_up' | 'repair' | 'share' | 'ask'
export type IntentionStatus = 'active' | 'done' | 'dropped' | 'expired'

export interface MindState {
  personId: string
  moodValence: number
  moodArousal: number
  energy: number
  attention: string
  currentConcern: string
  updatedAt: string
}

export interface Thought {
  id: string
  personId: string
  sessionId: string | null
  turnMessageId: number | null
  kind: ThoughtKind
  content: string
  confidence: number
  selected: boolean
  visible: boolean
  expiresAt: string | null
  createdAt: string
}

export interface Reflection {
  id: string
  personId: string
  sessionId: string
  whatHappened: string
  userState: Record<string, unknown>
  myState: Record<string, unknown>
  learned: unknown[]
  unresolved: unknown[]
  relationshipDelta: Record<string, unknown>
  createdAt: string
}

export interface Intention {
  id: string
  personId: string
  text: string
  kind: IntentionKind
  dueAt: string | null
  status: IntentionStatus
  sourceReflectionId: string | null
  createdAt: string
  completedAt: string | null
}

export interface RecallHit {
  memory: Memory
  bm25: number
  norm: number
  recency: number
  salience: number
  emotion: number
  reinforcement: number
  unresolved: number
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
