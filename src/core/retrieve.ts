import { getDb } from './db.ts'
import { getMemory, neighborsOf } from './store.ts'
import type { Memory, RecallHit, RetrievalResult } from './types.ts'

const CANDIDATE_LIMIT = 60

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeQuery(text: string): string {
  return text.trim().replace(/[^\p{L}\p{N}]+/gu, '')
}

function trigrams(text: string): string[] {
  const chars = [...text]
  if (chars.length < 3) return []
  const out = new Set<string>()
  for (let i = 0; i <= chars.length - 3; i++) {
    out.add(chars.slice(i, i + 3).join(''))
  }
  return [...out].slice(0, 24)
}

interface Candidate {
  memory: Memory
  bm25: number
}

function ftsCandidates(personId: string, query: string): Candidate[] | undefined {
  const grams = trigrams(query)
  if (grams.length === 0) return undefined
  const ftsQuery = grams.map((gram) => `"${gram.replace(/"/g, '""')}"`).join(' OR ')
  try {
    const rows = getDb()
      .prepare(
        `SELECT m.id, bm25(memory_fts) AS bm25
         FROM memory_fts
         JOIN memory m ON m.rowid = memory_fts.rowid
         WHERE memory_fts MATCH ? AND m.person_id = ? AND m.status = 'active'
         ORDER BY bm25
         LIMIT ?`,
      )
      .all(ftsQuery, personId, CANDIDATE_LIMIT) as any[]
    return rows
      .map((row) => {
        const memory = getMemory(String(row.id))
        return memory === undefined ? undefined : { memory, bm25: -Number(row.bm25) }
      })
      .filter((item): item is Candidate => item !== undefined)
  } catch {
    return undefined
  }
}

const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['称呼', '名字', '全名', '叫我'],
  ['口味', '吃辣', '吃甜', '饮食'],
  ['饮食', '忌口', '不吃', '香菜', '过敏'],
  ['住处', '住址', '住在', '搬家'],
  ['生日', '出生', '几号'],
]

function expandQuery(query: string): string {
  const extras: string[] = []
  for (const group of SYNONYM_GROUPS) {
    if (group.some((word) => query.includes(word))) extras.push(...group)
  }
  return extras.length === 0 ? query : `${query}${extras.join('')}`
}

function bigramCandidates(personId: string, rawQuery: string): Candidate[] {
  const query = expandQuery(rawQuery)
  const chars = [...query]
  if (chars.length < 2) return []
  const grams = new Set<string>()
  for (let i = 0; i < chars.length - 1; i++) grams.add(`${chars[i]}${chars[i + 1]}`)
  if (grams.size === 0) return []

  const rows = getDb()
    .prepare(
      `SELECT id, text FROM memory
       WHERE person_id = ? AND status = 'active'
       ORDER BY COALESCE(occurred_at, created_at) DESC
       LIMIT 500`,
    )
    .all(personId) as any[]

  const scored = rows
    .map((row) => {
      const text = String(row.text)
      let matched = 0
      for (const gram of grams) if (text.includes(gram)) matched += 1
      return { id: String(row.id), score: matched / grams.size }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_LIMIT)

  return scored
    .map((item) => {
      const memory = getMemory(item.id)
      return memory === undefined ? undefined : { memory, bm25: item.score }
    })
    .filter((item): item is Candidate => item !== undefined)
}

function likeCandidates(personId: string, query: string): Candidate[] {
  const rows = getDb()
    .prepare(
      `SELECT id FROM memory
       WHERE person_id = ? AND status = 'active' AND text LIKE ?
       ORDER BY COALESCE(occurred_at, created_at) DESC
       LIMIT ?`,
    )
    .all(personId, `%${query}%`, CANDIDATE_LIMIT) as any[]
  return rows
    .map((row) => {
      const memory = getMemory(String(row.id))
      return memory === undefined ? undefined : { memory, bm25: 1 }
    })
    .filter((item): item is Candidate => item !== undefined)
}

function scoreCandidates(candidates: Candidate[], nowMs: number): RecallHit[] {
  const maxBm25 = Math.max(...candidates.map((item) => item.bm25), 0)
  return candidates
    .map(({ memory, bm25 }) => {
      const norm = maxBm25 > 0 ? bm25 / maxBm25 : 0
      const anchor = Date.parse(memory.occurredAt ?? memory.createdAt)
      const days = Number.isFinite(anchor) ? Math.max(0, (nowMs - anchor) / 86_400_000) : 0
      const recency = Math.exp(-days / 90)
      const salience = clamp(memory.salience, 0, 1)
      const emotion = clamp(
        Math.abs(memory.valence) * 0.4 + memory.arousal * 0.4 + memory.emotionalCharge * 0.2,
        0,
        1,
      )
      const reinforcement = clamp(Math.log1p(memory.accessCount) / Math.log1p(10), 0, 1)
      const unresolved = memory.pinned ? 0 : memory.unresolved ? 0.05 : 0
      const pinnedBonus = memory.pinned ? 0.08 : 0
      const final =
        0.5 * norm + 0.2 * recency + 0.12 * salience + 0.08 * emotion +
        0.05 * reinforcement + unresolved + pinnedBonus
      return {
        memory,
        bm25,
        norm,
        recency,
        salience,
        emotion,
        reinforcement,
        unresolved,
        pinned: memory.pinned,
        final,
        via: 'search' as const,
      }
    })
    .sort((a, b) => b.final - a.final || b.memory.accessCount - a.memory.accessCount)
}

export function retrieve(
  personId: string,
  rawQuery: string,
  options: { topK?: number; candidateLimit?: number } = {},
): RetrievalResult {
  const topK = Math.max(1, options.topK ?? Number(process.env.RECALL_TOP_K ?? 3))
  const query = normalizeQuery(rawQuery)
  if (query === '') {
    return { query: '', mode: 'empty', hits: [], selected: [] }
  }

  let candidates = ftsCandidates(personId, query) ?? []
  let mode: RetrievalResult['mode'] = 'fts'

  // trigram 需要连续 3 字，中文问句经常对不上；用问句 bigram 补召回。
  if (candidates.length < topK) {
    const extra = bigramCandidates(personId, query)
    if (extra.length > 0) {
      const known = new Set(candidates.map((item) => item.memory.id))
      candidates = [...candidates, ...extra.filter((item) => !known.has(item.memory.id))]
    }
  }

  if (candidates.length === 0) {
    candidates = likeCandidates(personId, query)
    mode = 'like'
  }
  if (candidates.length === 0) {
    return { query, mode: 'empty', hits: [], selected: [] }
  }

  const hits = scoreCandidates(candidates, Date.now()).slice(0, options.candidateLimit ?? 20)

  // 1 跳联想：从最强的几个种子出发，带出弱相关的邻居；权重减半，不能压过直接命中。
  const known = new Set(hits.map((hit) => hit.memory.id))
  for (const seed of hits.slice(0, 3)) {
    for (const neighbor of neighborsOf(seed.memory.id, 3)) {
      if (known.has(neighbor.memory.id)) continue
      known.add(neighbor.memory.id)
      hits.push({
        memory: neighbor.memory,
        bm25: 0,
        norm: 0,
        recency: 0,
        salience: neighbor.memory.salience,
        emotion: 0,
        reinforcement: 0,
        unresolved: 0,
        pinned: neighbor.memory.pinned,
        final: seed.final * 0.5 * neighbor.weight,
        via: 'edge',
      })
    }
  }
  hits.sort((a, b) => b.final - a.final)

  return {
    query,
    mode,
    hits,
    selected: hits.slice(0, topK).map((hit) => hit.memory),
  }
}
