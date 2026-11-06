import { getDb } from './db.ts'
import {
  listContradictions,
  listEdges,
  listIntentions,
  listMemories,
  listReflections,
  listThoughts,
  stats,
} from './store.ts'
import { decayScore } from './maintenance.ts'

export interface BrainRegion {
  id: string
  label: string
  description: string
  x: number
  y: number
}

export interface BrainNode {
  id: string
  type: 'region' | 'memory' | 'message' | 'reflection' | 'intention' | 'thought'
  label: string
  description?: string
  kind?: string
  status?: string
  text?: string
  salience?: number
  confidence?: number
  pinned?: boolean
  unresolved?: boolean
  createdAt?: string
  strength?: number
  accessCount?: number
  lastReinforced?: string | null
  ageDays?: number
  halfLifeDays?: number
  curve?: number[]
  x?: number
  y?: number
}

export interface BrainLink {
  source: string
  target: string
  kind: 'region' | 'edge' | 'recall' | 'contradiction' | 'message' | 'inner'
  weight: number
}

export interface BrainGraph {
  regions: BrainRegion[]
  nodes: BrainNode[]
  links: BrainLink[]
  stats: {
    nodes: number
    links: number
    sessions: number
    messages: number
    activeMemories: number
    archivedMemories: number
    edges: number
    recallLinks: number
    contradictions: number
    reflections: number
    intentions: number
    thoughts: number
  }
}

export interface BrainOptions {
  includeMessages?: boolean
  includeInner?: boolean
}

const PERSON_ID = 'p-0001'
const DAY = 86_400_000
const CURVE_DAYS = [0, 7, 14, 30, 60, 90]

const REGIONS: BrainRegion[] = [
  { id: 'input', label: '语言输入', description: '用户消息进入系统的位置', x: 0.12, y: 0.18 },
  { id: 'working', label: '工作记忆', description: '当前会话最近消息和当前问题', x: 0.28, y: 0.31 },
  { id: 'retrieval', label: '大脑中枢 · 检索', description: 'FTS、bigram、同义词、联想边和打分', x: 0.48, y: 0.25 },
  { id: 'expression', label: '语言中枢 · 表达', description: '把记忆、情绪和慢想结论组织成回复', x: 0.72, y: 0.18 },
  { id: 'emotion', label: '边缘系统 · 情绪', description: '情绪评估、心情、能量和关注点', x: 0.32, y: 0.62 },
  { id: 'hippocampus', label: '海马体 · 写入', description: '抽取、反思和长期记忆巩固', x: 0.52, y: 0.55 },
  { id: 'longterm', label: '长期记忆库', description: '事实、偏好、边界、承诺和阶段记忆', x: 0.64, y: 0.74 },
  { id: 'introspection', label: '内省 · 反馈', description: '想法、反思、意图和 follow-up', x: 0.84, y: 0.58 },
  { id: 'metabolism', label: '代谢 · 治理', description: '衰减、归档、矛盾检查和清理', x: 0.18, y: 0.82 },
]

const REGION_BY_KIND: Record<string, string> = {
  episode: 'hippocampus',
  fact: 'longterm',
  preference: 'emotion',
  boundary: 'metabolism',
  promise: 'introspection',
  relationship: 'introspection',
  chapter: 'introspection',
  self_fact: 'hippocampus',
}

function shortLabel(text: string, fallback: string): string {
  const first = text.replace(/\s+/g, ' ').trim().split(/[。！？!?；;]/)[0].trim()
  const withoutSpeaker = first
    .replace(/^用户(?:的)?(?:说|提到|希望|喜欢|想要|需要)?\s*/, '')
    .replace(/^我说(?:自己)?\s*/, '')
    .trim()
  return (withoutSpeaker || first || fallback).slice(0, 18)
}

export function buildBrainGraph(options: BrainOptions = {}): BrainGraph {
  const includeMessages = options.includeMessages ?? false
  const includeInner = options.includeInner ?? true
  const memories = listMemories({ personId: PERSON_ID, status: 'all', limit: 500 })
  const edges = listEdges(PERSON_ID, 2000)
  const contradictions = listContradictions(PERSON_ID, 'pending', 200)
  const reflections = listReflections(PERSON_ID, 100)
  const intentions = listIntentions(PERSON_ID, 'active', 100)
  const thoughts = listThoughts(PERSON_ID, 100)
  const baseStats = stats(PERSON_ID)

  const recallRows = getDb()
    .prepare(
      `SELECT memory_id, MAX(score) AS score
       FROM recall_log
       WHERE person_id = ? AND injected = 1
       GROUP BY memory_id
       ORDER BY MAX(rowid) DESC
       LIMIT 160`,
    )
    .all(PERSON_ID) as Array<{ memory_id: string; score: number | null }>

  const memoryIds = new Set(memories.map((memory) => memory.id))
  const nodes: BrainNode[] = []
  const links: BrainLink[] = []

  for (const region of REGIONS) {
    nodes.push({
      id: region.id,
      type: 'region',
      label: region.label,
      description: region.description,
      x: region.x,
      y: region.y,
    })
  }

  const now = new Date()
  for (const memory of memories) {
    const anchor = Date.parse(memory.lastReinforced ?? memory.lastAccess ?? memory.createdAt)
    const ageDays = Number.isFinite(anchor) ? Math.max(0, (now.getTime() - anchor) / DAY) : 0
    const halfLifeDays = memory.kind === 'episode' ? 14 : 90
    const curve = CURVE_DAYS.map((offset) =>
      Number(decayScore(memory, new Date(now.getTime() + offset * DAY)).toFixed(4)),
    )
    nodes.push({
      id: memory.id,
      type: 'memory',
      label: shortLabel(memory.text, memory.kind),
      description: memory.text,
      kind: memory.kind,
      status: memory.status,
      text: memory.text,
      salience: Number(memory.salience.toFixed(4)),
      confidence: Number(memory.confidence.toFixed(4)),
      pinned: memory.pinned,
      unresolved: memory.unresolved,
      createdAt: memory.createdAt,
      strength: curve[0]!,
      accessCount: memory.accessCount,
      lastReinforced: memory.lastReinforced,
      ageDays: Number(ageDays.toFixed(1)),
      halfLifeDays,
      curve,
    })

    const regionId = REGION_BY_KIND[memory.kind] ?? 'longterm'
    links.push({ source: regionId, target: memory.id, kind: 'region', weight: 0.35 })
  }

  for (const edge of edges) {
    if (!memoryIds.has(edge.srcMemoryId) || !memoryIds.has(edge.dstMemoryId)) continue
    links.push({
      source: edge.srcMemoryId,
      target: edge.dstMemoryId,
      kind: 'edge',
      weight: Math.max(0.15, Math.min(1, edge.weight)),
    })
  }

  let recallLinks = 0
  for (const row of recallRows) {
    if (!memoryIds.has(row.memory_id)) continue
    const weight = Math.max(0.08, Math.min(1, Number(row.score ?? 0.2)))
    links.push({ source: 'retrieval', target: row.memory_id, kind: 'recall', weight })
    recallLinks += 1
  }

  for (const contradiction of contradictions) {
    if (!memoryIds.has(contradiction.aMemoryId) || !memoryIds.has(contradiction.bMemoryId)) continue
    links.push({
      source: contradiction.aMemoryId,
      target: contradiction.bMemoryId,
      kind: 'contradiction',
      weight: 0.9,
    })
  }

  if (includeMessages) {
    const messageRows = getDb()
      .prepare(
        `SELECT m.id, m.session_id, m.role, m.content, m.created_at
         FROM message m
         JOIN chat_session s ON s.id = m.session_id
         WHERE s.person_id = ?
         ORDER BY m.id DESC
         LIMIT 20`,
      )
      .all(PERSON_ID) as Array<{ id: number; session_id: string; role: string; content: string; created_at: string }>

    for (const message of messageRows) {
      const id = `msg-${message.id}`
      nodes.push({
        id,
        type: 'message',
        label: shortLabel(message.content, message.role === 'user' ? '用户消息' : 'AI 回复'),
        description: message.content,
        kind: message.role,
        status: message.role,
        text: message.content,
        createdAt: message.created_at,
      })
      links.push({
        source: message.role === 'user' ? 'input' : 'expression',
        target: id,
        kind: 'message',
        weight: 0.28,
      })
    }
  }

  if (includeInner) {
    for (const reflection of reflections) {
      nodes.push({
        id: reflection.id,
        type: 'reflection',
        label: shortLabel(reflection.whatHappened, '反思'),
        description: reflection.whatHappened,
        kind: 'reflection',
        status: 'active',
        text: reflection.whatHappened,
        createdAt: reflection.createdAt,
      })
      links.push({ source: 'hippocampus', target: reflection.id, kind: 'inner', weight: 0.4 })
      links.push({ source: 'introspection', target: reflection.id, kind: 'inner', weight: 0.32 })
    }

    for (const intention of intentions) {
      nodes.push({
        id: intention.id,
        type: 'intention',
        label: shortLabel(intention.text, '意图'),
        description: intention.text,
        kind: intention.kind,
        status: intention.status,
        text: intention.text,
        createdAt: intention.createdAt,
      })
      links.push({ source: 'introspection', target: intention.id, kind: 'inner', weight: 0.46 })
    }

    for (const thought of thoughts) {
      nodes.push({
        id: thought.id,
        type: 'thought',
        label: shortLabel(thought.content, '想法'),
        description: thought.content,
        kind: thought.kind,
        status: 'active',
        text: thought.content,
        confidence: Number(thought.confidence.toFixed(4)),
        createdAt: thought.createdAt,
      })
      links.push({ source: 'introspection', target: thought.id, kind: 'inner', weight: 0.34 })
      links.push({ source: 'emotion', target: thought.id, kind: 'inner', weight: 0.2 })
    }
  }

  return {
    regions: REGIONS,
    nodes,
    links,
    stats: {
      nodes: nodes.length,
      links: links.length,
      sessions: baseStats.sessions,
      messages: baseStats.messages,
      activeMemories: memories.filter((memory) => memory.status === 'active').length,
      archivedMemories: memories.filter((memory) => memory.status === 'archived').length,
      edges: edges.length,
      recallLinks,
      contradictions: contradictions.length,
      reflections: reflections.length,
      intentions: intentions.length,
      thoughts: thoughts.length,
    },
  }
}
