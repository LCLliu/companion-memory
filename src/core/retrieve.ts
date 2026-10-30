import { getDb } from './db.ts'
import { getMemory } from './store.ts'
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

  let candidates = ftsCandidates(personId, query)
  let mode: RetrievalResult['mode'] = 'fts'
  if (candidates === undefined || candidates.length === 0) {
    candidates = likeCandidates(personId, query)
    mode = 'like'
  }
  if (candidates.length === 0) {
    return { query, mode: 'empty', hits: [], selected: [] }
  }

  const hits = scoreCandidates(candidates, Date.now()).slice(0, options.candidateLimit ?? 20)
  return {
    query,
    mode,
    hits,
    selected: hits.slice(0, topK).map((hit) => hit.memory),
  }
}
