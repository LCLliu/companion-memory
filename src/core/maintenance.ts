import {
  clearEdges,
  expireIntentions,
  insertContradiction,
  insertEdge,
  listContradictions,
  listMemories,
  pruneThoughts,
  recordMaintenance,
  setMemoryStatus,
} from './store.ts'
import type { MaintenanceRun, Memory } from './types.ts'

const DAY = 86_400_000
const EDGE_SIMILARITY = 0.35
const CONTRADICTION_SIMILARITY = 0.55
const MAX_EDGES_PER_MEMORY = 3
const MAX_SCAN = 500

const NEGATIVE_MARKERS = /(不喜欢|讨厌|不要|别再|不想|禁止|不许|不再|不能|受不了|反感)/
const FACT_KINDS = new Set(['fact', 'preference', 'decision', 'correction'])

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function tokenSet(text: string): Set<string> {
  const normalized = text.toLowerCase()
  const tokens = new Set<string>()
  for (const match of normalized.matchAll(/[a-z0-9]{2,}/g)) tokens.add(match[0])
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]+/g)) {
    const chars = [...match[0]]
    if (chars.length === 1) {
      tokens.add(chars[0]!)
      continue
    }
    for (let i = 0; i < chars.length - 1; i++) {
      tokens.add(`${chars[i]}${chars[i + 1]}`)
    }
  }
  return tokens
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  return (2 * intersection) / (a.size + b.size)
}

function polarity(text: string): number {
  return NEGATIVE_MARKERS.test(text) ? -1 : 1
}

function anchorOf(memory: Memory): string {
  return memory.lastReinforced ?? memory.lastAccess ?? memory.createdAt
}

export function decayScore(memory: Memory, now = new Date()): number {
  const anchor = Date.parse(anchorOf(memory))
  const days = Number.isFinite(anchor) ? Math.max(0, (now.getTime() - anchor) / DAY) : 0
  const halfLife = memory.kind === 'episode' ? 14 : 90
  const recency = Math.pow(0.5, days / halfLife)
  const reinforcement = 1 + 0.15 * Math.log1p(memory.accessCount)
  const salience = 0.6 + 0.4 * clamp(memory.salience, 0, 1)
  const emotion = 1 + 0.2 * clamp(memory.emotionalCharge, 0, 1)
  const unresolved = memory.unresolved ? 1.1 : 1
  return recency * reinforcement * salience * emotion * unresolved
}

export function isArchivable(memory: Memory, now = new Date()): boolean {
  if (memory.pinned) return false
  if (memory.kind !== 'episode') return false
  const anchor = Date.parse(anchorOf(memory))
  const days = Number.isFinite(anchor) ? (now.getTime() - anchor) / DAY : 0
  if (days < 14) return false
  return decayScore(memory, now) < 0.18
}

function rebuildEdges(memories: Memory[]): number {
  clearEdges()
  const pairs: Array<{ a: string; b: string; score: number }> = []
  const tokens = new Map(memories.map((memory) => [memory.id, tokenSet(memory.text)]))
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i]!
      const b = memories[j]!
      const score = dice(tokens.get(a.id)!, tokens.get(b.id)!)
      if (score >= EDGE_SIMILARITY) {
        pairs.push({ a: a.id, b: b.id, score })
      }
    }
  }

  const byMemory = new Map<string, Array<{ other: string; score: number }>>()
  for (const pair of pairs) {
    const listA = byMemory.get(pair.a) ?? []
    listA.push({ other: pair.b, score: pair.score })
    byMemory.set(pair.a, listA)
    const listB = byMemory.get(pair.b) ?? []
    listB.push({ other: pair.a, score: pair.score })
    byMemory.set(pair.b, listB)
  }

  let inserted = 0
  const seen = new Set<string>()
  for (const [id, list] of byMemory) {
    list.sort((x, y) => y.score - x.score)
    for (const item of list.slice(0, MAX_EDGES_PER_MEMORY)) {
      const [src, dst] = [id, item.other].sort()
      const key = `${src}|${dst}`
      if (seen.has(key)) continue
      seen.add(key)
      if (insertEdge({ srcMemoryId: src, dstMemoryId: dst, relation: 'same_topic', weight: item.score })) {
        inserted += 1
      }
    }
  }
  return inserted
}

function detectContradictions(memories: Memory[]): number {
  const facts = memories.filter((memory) => FACT_KINDS.has(memory.kind))
  const tokens = new Map(facts.map((memory) => [memory.id, tokenSet(memory.text)]))
  let inserted = 0
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const a = facts[i]!
      const b = facts[j]!
      const score = dice(tokens.get(a.id)!, tokens.get(b.id)!)
      if (score < CONTRADICTION_SIMILARITY) continue
      if (polarity(a.text) === polarity(b.text)) continue
      if (insertContradiction({
        aMemoryId: a.id,
        bMemoryId: b.id,
        reason: `文本相似度 ${score.toFixed(2)}，但极性相反`,
      })) {
        inserted += 1
      }
    }
  }
  return inserted
}

export interface MaintenanceInput {
  personId?: string
  trigger?: 'startup' | 'manual' | 'scheduled' | 'test'
  now?: Date
}

export function runMaintenance(input: MaintenanceInput = {}): MaintenanceRun {
  const now = input.now ?? new Date()
  const personId = input.personId ?? 'p-0001'
  const at = now.toISOString()

  const before = listMemories({ personId, status: 'active', limit: MAX_SCAN })
  let archived = 0
  for (const memory of before) {
    if (!isArchivable(memory, now)) continue
    if (setMemoryStatus(memory.id, 'archived')) archived += 1
  }

  const active = listMemories({ personId, status: 'active', limit: MAX_SCAN })
  const edges = rebuildEdges(active)
  const contradictions = detectContradictions(active)
  const expiredIntentions = expireIntentions(now)
  const thoughtsPruned = pruneThoughts(now)
  const pending = listContradictions(personId, 'pending', 20).length

  const report = [
    `扫描 ${before.length} 条记忆`,
    `归档 ${archived} 条（仅 episode 且超过 14 天、权重低于阈值）`,
    `重建 ${edges} 条联想边`,
    `新增 ${contradictions} 条矛盾，待核对 ${pending} 条`,
    `过期意图 ${expiredIntentions} 条，清理想法 ${thoughtsPruned} 条`,
  ].join('\n')

  return recordMaintenance({
    personId,
    at,
    trigger: input.trigger ?? 'manual',
    scanned: before.length,
    archived,
    edges,
    contradictions,
    expiredIntentions,
    thoughtsPruned,
    report,
  })
}

