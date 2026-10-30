import { randomUUID } from 'node:crypto'
import { getDb } from './db.ts'
import type {
  Contradiction,
  Edge,
  Intention,
  IntentionKind,
  IntentionStatus,
  MaintenanceRun,
  Memory,
  MemoryKind,
  MemoryStatus,
  Message,
  MindState,
  OpenLoop,
  OpenLoopKind,
  OpenLoopStatus,
  Person,
  Reflection,
  RelationshipEntry,
  RelationshipSnapshot,
  Session,
  Thought,
  ThoughtKind,
} from './types.ts'

const PERSON_ID = 'p-0001'

function nowIso(): string {
  return new Date().toISOString()
}

function parseIds(raw: unknown): number[] {
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : []
  } catch {
    return []
  }
}

function parseStringIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

function rowToMemory(row: any): Memory {
  return {
    id: String(row.id),
    personId: String(row.person_id),
    kind: String(row.kind) as MemoryKind,
    level: Number(row.level),
    text: String(row.text),
    occurredAt: row.occurred_at ? String(row.occurred_at) : null,
    validFrom: row.valid_from ? String(row.valid_from) : null,
    validTo: row.valid_to ? String(row.valid_to) : null,
    valence: Number(row.valence),
    arousal: Number(row.arousal),
    salience: Number(row.salience),
    confidence: Number(row.confidence),
    status: String(row.status) as MemoryStatus,
    supersedes: row.supersedes ? String(row.supersedes) : null,
    supersededBy: row.superseded_by ? String(row.superseded_by) : null,
    sourceSessionId: row.source_session_id ? String(row.source_session_id) : null,
    sourceMessageIds: parseIds(row.source_message_ids),
    pinned: Number(row.pinned) === 1,
    accessCount: Number(row.access_count),
    lastAccess: row.last_access ? String(row.last_access) : null,
    unresolved: Number(row.unresolved ?? 0) === 1,
    emotionalCharge: Number(row.emotional_charge ?? 0),
    lastReinforced: row.last_reinforced ? String(row.last_reinforced) : null,
    sourceThoughtId: row.source_thought_id ? String(row.source_thought_id) : null,
    createdAt: String(row.created_at),
  }
}

function rowToSession(row: any): Session {
  return {
    id: String(row.id),
    personId: String(row.person_id),
    title: String(row.title),
    startedAt: String(row.started_at),
    endedAt: row.ended_at ? String(row.ended_at) : null,
    status: String(row.status) as 'active' | 'ended',
    extractedSeq: Number(row.extracted_seq),
  }
}

function rowToMessage(row: any): Message {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    role: String(row.role) as Message['role'],
    content: String(row.content),
    createdAt: String(row.created_at),
    injectedMemoryIds: parseStringIds(row.injected_memory_ids),
  }
}

function rowToOpenLoop(row: any): OpenLoop {
  return {
    id: String(row.id),
    personId: String(row.person_id),
    text: String(row.text),
    kind: String(row.kind) as OpenLoopKind,
    dueAt: row.due_at ? String(row.due_at) : null,
    status: String(row.status) as OpenLoopStatus,
    sourceMemoryId: row.source_memory_id ? String(row.source_memory_id) : null,
    sourceMessageIds: parseIds(row.source_message_ids),
    createdAt: String(row.created_at),
    closedAt: row.closed_at ? String(row.closed_at) : null,
  }
}

const ID_TABLES = {
  m: 'memory',
  ol: 'open_loop',
  t: 'thought',
  r: 'reflection',
  i: 'intention',
} as const

const ID_KEYS = {
  m: 'memory_seq',
  ol: 'open_loop_seq',
  t: 'thought_seq',
  r: 'reflection_seq',
  i: 'intention_seq',
} as const

function nextId(prefix: keyof typeof ID_TABLES): string {
  const db = getDb()
  const table = ID_TABLES[prefix]
  const key = ID_KEYS[prefix]
  const stored = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  let next: number
  if (stored === undefined) {
    // 兼容已有数据：第一次分配时从现有最大 id 起步，避免与旧条目撞号。
    const row = db
      .prepare(`SELECT COALESCE(MAX(CAST(SUBSTR(id, 3) AS INTEGER)), 0) AS n FROM ${table} WHERE id LIKE ?`)
      .get(`${prefix}-%`) as { n: number } | undefined
    next = Number(row?.n ?? 0) + 1
  } else {
    next = Number(stored.value) + 1
  }
  db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(next))
  return `${prefix}-${String(next).padStart(4, '0')}`
}

export function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[，。；：、！？,.;:!?"'`（）()\[\]【】「」《》<>]/g, '')
    .toLowerCase()
}

export function getPerson(personId = PERSON_ID): Person | undefined {
  const row = getDb().prepare('SELECT * FROM person WHERE id = ?').get(personId) as any
  if (row === undefined) return undefined
  return {
    id: String(row.id),
    platform: String(row.platform),
    externalId: String(row.external_id),
    name: String(row.name),
    createdAt: String(row.created_at),
  }
}

export function createSession(personId = PERSON_ID, title?: string): Session {
  const id = `s-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`
  const at = nowIso()
  const finalTitle = title?.trim() || `新会话 ${at.slice(0, 16).replace('T', ' ')}`
  getDb()
    .prepare(
      `INSERT INTO chat_session(id, person_id, title, started_at, status, extracted_seq)
       VALUES (?, ?, ?, ?, 'active', 0)`,
    )
    .run(id, personId, finalTitle, at)
  return getSession(id)!
}

export function getSession(id: string): Session | undefined {
  const row = getDb().prepare('SELECT * FROM chat_session WHERE id = ?').get(id) as any
  return row === undefined ? undefined : rowToSession(row)
}

export function listSessions(personId = PERSON_ID, limit = 50): Session[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_session WHERE person_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(personId, limit) as any[]
  return rows.map(rowToSession)
}

export function addMessage(
  sessionId: string,
  role: Message['role'],
  content: string,
  injectedMemoryIds: string[] = [],
): Message {
  const at = nowIso()
  const result = getDb()
    .prepare(
      `INSERT INTO message(session_id, role, content, created_at, injected_memory_ids)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sessionId, role, content, at, JSON.stringify(injectedMemoryIds))
  const id = Number(result.lastInsertRowid)
  const row = getDb().prepare('SELECT * FROM message WHERE id = ?').get(id) as any
  return rowToMessage(row)
}

export function listMessages(sessionId: string, limit = 500): Message[] {
  const rows = getDb()
    .prepare('SELECT * FROM message WHERE session_id = ? ORDER BY id ASC LIMIT ?')
    .all(sessionId, limit) as any[]
  return rows.map(rowToMessage)
}

export function listRecentMessages(sessionId: string, limit = 12): Message[] {
  const rows = getDb()
    .prepare('SELECT * FROM message WHERE session_id = ? ORDER BY id DESC LIMIT ?')
    .all(sessionId, limit) as any[]
  return rows.reverse().map(rowToMessage)
}

export function getMessagesAfter(sessionId: string, afterId: number, limit = 200): Message[] {
  const rows = getDb()
    .prepare('SELECT * FROM message WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
    .all(sessionId, afterId, limit) as any[]
  return rows.map(rowToMessage)
}

export function countUserMessages(sessionId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM message WHERE session_id = ? AND role = 'user'")
    .get(sessionId) as { n: number } | undefined
  return Number(row?.n ?? 0)
}

export function markExtracted(sessionId: string, seq: number): void {
  getDb().prepare('UPDATE chat_session SET extracted_seq = ? WHERE id = ?').run(seq, sessionId)
}

export function getLastUserMessageId(sessionId: string): number | undefined {
  const row = getDb()
    .prepare("SELECT id FROM message WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
    .get(sessionId) as { id: number } | undefined
  return row === undefined ? undefined : Number(row.id)
}

export interface CreateMemoryInput {
  personId?: string
  kind: MemoryKind
  text: string
  level?: number
  occurredAt?: string
  validFrom?: string | null
  validTo?: string | null
  valence?: number
  arousal?: number
  salience?: number
  confidence?: number
  status?: MemoryStatus
  sourceSessionId?: string | null
  sourceMessageIds?: number[]
  pinned?: boolean
  unresolved?: boolean
  emotionalCharge?: number
  sourceThoughtId?: string | null
  /** 仅导入/测试用；正常写入使用当前时间。 */
  createdAt?: string
}

export function createMemory(input: CreateMemoryInput): Memory {
  const text = input.text.trim()
  if (text === '') throw new Error('记忆内容不能为空')
  const id = nextId('m')
  const at = nowIso()
  const createdAt = input.createdAt ?? at
  getDb()
    .prepare(
      `INSERT INTO memory(
        id, person_id, kind, level, text, occurred_at, valid_from, valid_to,
        valence, arousal, salience, confidence, status, source_session_id,
        source_message_ids, pinned, unresolved, emotional_charge, source_thought_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.personId ?? PERSON_ID,
      input.kind,
      input.level ?? 1,
      text,
      input.occurredAt ?? createdAt,
      input.validFrom ?? null,
      input.validTo ?? null,
      input.valence ?? 0,
      input.arousal ?? 0,
      input.salience ?? (input.pinned === true ? 0.9 : 0.5),
      input.confidence ?? 0.8,
      input.status ?? 'active',
      input.sourceSessionId ?? null,
      JSON.stringify(input.sourceMessageIds ?? []),
      input.pinned === true ? 1 : 0,
      input.unresolved === true ? 1 : 0,
      input.emotionalCharge ?? 0,
      input.sourceThoughtId ?? null,
      createdAt,
    )
  return getMemory(id)!
}

export function getMemory(id: string): Memory | undefined {
  const row = getDb().prepare('SELECT * FROM memory WHERE id = ?').get(id) as any
  return row === undefined ? undefined : rowToMemory(row)
}

export function latestChapter(personId = PERSON_ID): Memory | undefined {
  return listMemories({
    personId,
    kind: 'chapter',
    status: 'active',
    limit: 1,
    orderBy: 'created_at',
  })[0]
}

export function listMemories(opts: {
  personId?: string
  status?: MemoryStatus | 'all'
  kind?: MemoryKind | 'all'
  q?: string
  pinned?: boolean
  limit?: number
  offset?: number
  orderBy?: 'created_at' | 'occurred_at' | 'salience'
} = {}): Memory[] {
  const personId = opts.personId ?? PERSON_ID
  const status = opts.status ?? 'active'
  const clauses: string[] = ['person_id = ?']
  const params: any[] = [personId]
  if (status !== 'all') {
    clauses.push('status = ?')
    params.push(status)
  }
  if (opts.kind !== undefined && opts.kind !== 'all') {
    clauses.push('kind = ?')
    params.push(opts.kind)
  }
  if (opts.q !== undefined && opts.q.trim() !== '') {
    clauses.push('text LIKE ?')
    params.push(`%${opts.q.trim()}%`)
  }
  if (opts.pinned !== undefined) {
    clauses.push('pinned = ?')
    params.push(opts.pinned ? 1 : 0)
  }
  const order = opts.orderBy ?? 'created_at'
  const orderSql =
    order === 'salience'
      ? 'salience'
      : order === 'occurred_at'
        ? 'COALESCE(occurred_at, created_at)'
        : 'created_at'
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory WHERE ${clauses.join(' AND ')}
       ORDER BY pinned DESC, ${orderSql} DESC, rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as any[]
  return rows.map(rowToMemory)
}

export function findExistingMemory(personId: string, text: string): Memory | undefined {
  const key = normalizeText(text)
  if (key.length < 4) return undefined
  const candidates = listMemories({ personId, status: 'active', limit: 500 })
  for (const memory of candidates) {
    const body = normalizeText(memory.text)
    if (body.length < 4) continue
    if (body.includes(key) || key.includes(body)) return memory
  }
  return undefined
}

export function setMemoryPinned(id: string, pinned: boolean): boolean {
  const result = getDb().prepare('UPDATE memory SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
  return Number(result.changes) > 0
}

export function setMemoryStatus(id: string, status: MemoryStatus): boolean {
  const result = getDb().prepare('UPDATE memory SET status = ? WHERE id = ?').run(status, id)
  return Number(result.changes) > 0
}

export function deleteMemory(id: string): boolean {
  const result = getDb().prepare('DELETE FROM memory WHERE id = ?').run(id)
  return Number(result.changes) > 0
}

export function reinforceMemory(id: string): boolean {
  const at = nowIso()
  const result = getDb()
    .prepare(
      `UPDATE memory
       SET access_count = access_count + 1, last_access = ?, last_reinforced = ?
       WHERE id = ?`,
    )
    .run(at, at, id)
  return Number(result.changes) > 0
}

export function logRecall(input: {
  personId?: string
  memoryId: string
  query: string
  score: number
  injected: boolean
}): void {
  getDb()
    .prepare(
      `INSERT INTO recall_log(person_id, memory_id, query, score, injected, used, at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      input.personId ?? PERSON_ID,
      input.memoryId,
      input.query,
      input.score,
      input.injected ? 1 : 0,
      nowIso(),
    )
}

export function createOpenLoop(input: {
  personId?: string
  text: string
  kind?: OpenLoopKind
  dueAt?: string | null
  sourceMemoryId?: string | null
  sourceMessageIds?: number[]
}): OpenLoop {
  const text = input.text.trim()
  if (text === '') throw new Error('未完成事项内容不能为空')
  const id = nextId('ol')
  const at = nowIso()
  getDb()
    .prepare(
      `INSERT INTO open_loop(
        id, person_id, text, kind, due_at, status, source_memory_id,
        source_message_ids, created_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    )
    .run(
      id,
      input.personId ?? PERSON_ID,
      text,
      input.kind ?? 'plan',
      input.dueAt ?? null,
      input.sourceMemoryId ?? null,
      JSON.stringify(input.sourceMessageIds ?? []),
      at,
    )
  return getOpenLoop(id)!
}

export function getOpenLoop(id: string): OpenLoop | undefined {
  const row = getDb().prepare('SELECT * FROM open_loop WHERE id = ?').get(id) as any
  return row === undefined ? undefined : rowToOpenLoop(row)
}

export function listOpenLoops(
  personId = PERSON_ID,
  status: OpenLoopStatus | 'all' = 'open',
  limit = 20,
): OpenLoop[] {
  const rows =
    status === 'all'
      ? (getDb()
          .prepare('SELECT * FROM open_loop WHERE person_id = ? ORDER BY created_at ASC LIMIT ?')
          .all(personId, limit) as any[])
      : (getDb()
          .prepare(
            'SELECT * FROM open_loop WHERE person_id = ? AND status = ? ORDER BY created_at ASC LIMIT ?',
          )
          .all(personId, status, limit) as any[])
  return rows.map(rowToOpenLoop)
}

export function closeOpenLoop(id: string): boolean {
  const result = getDb()
    .prepare("UPDATE open_loop SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'")
    .run(nowIso(), id)
  return Number(result.changes) > 0
}

export function upsertRelationship(personId: string, key: string, value: string): void {
  const at = nowIso()
  getDb()
    .prepare(
      `INSERT INTO relationship(person_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(person_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(personId, key, value, at)
}

export function getRelationship(personId = PERSON_ID): RelationshipEntry[] {
  const rows = getDb()
    .prepare('SELECT key, value, updated_at FROM relationship WHERE person_id = ? ORDER BY key')
    .all(personId) as any[]
  return rows.map((row) => ({
    key: String(row.key),
    value: String(row.value),
    updatedAt: String(row.updated_at),
  }))
}

function relationshipNumber(
  entries: RelationshipEntry[],
  key: string,
  fallback: number,
): number {
  const raw = entries.find((entry) => entry.key === key)?.value
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function trustLabel(value: number): string {
  if (value >= 0.75) return '高'
  if (value >= 0.5) return '中'
  if (value >= 0.25) return '偏低'
  return '低'
}

function familiarityLabel(value: number): string {
  if (value >= 0.75) return '很熟'
  if (value >= 0.5) return '熟悉'
  if (value >= 0.25) return '开始熟悉'
  return '刚认识'
}

function tensionLabel(value: number): string {
  if (value >= 0.6) return '紧张'
  if (value >= 0.3) return '有点紧'
  return '平静'
}

function recentMoodLabel(value: number): string {
  if (value <= -0.25) return '最近低落'
  if (value >= 0.25) return '最近不错'
  return '平静'
}

export function getRelationshipSnapshot(personId = PERSON_ID): RelationshipSnapshot {
  const entries = getRelationship(personId)
  const trust = relationshipNumber(entries, 'trust', 0.5)
  const familiarity = relationshipNumber(entries, 'familiarity', 0.3)
  const tension = relationshipNumber(entries, 'tension', 0.1)
  const recentMood = relationshipNumber(entries, 'recent_mood', 0)
  return {
    trust,
    familiarity,
    tension,
    recentMood,
    tone: entries.find((entry) => entry.key === 'tone')?.value ?? '',
    labels: {
      trust: trustLabel(trust),
      familiarity: familiarityLabel(familiarity),
      tension: tensionLabel(tension),
      recentMood: recentMoodLabel(recentMood),
    },
    entries,
  }
}

export function setRelationshipNumber(
  personId: string,
  key: 'trust' | 'familiarity' | 'tension' | 'recent_mood',
  value: number,
  min: number,
  max: number,
): void {
  upsertRelationship(personId, key, clamp(value, min, max).toFixed(3))
}

export function bumpRelationshipNumber(
  personId: string,
  key: 'trust' | 'familiarity' | 'tension' | 'recent_mood',
  delta: number,
  min: number,
  max: number,
): number {
  const entries = getRelationship(personId)
  const current = relationshipNumber(entries, key, 0)
  const next = clamp(current + delta, min, max)
  upsertRelationship(personId, key, next.toFixed(3))
  return next
}

export function listSourceMessages(ids: number[]): Message[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT * FROM message WHERE id IN (${placeholders})`)
    .all(...ids) as any[]
  const byId = new Map(rows.map((row) => [Number(row.id), rowToMessage(row)]))
  return ids.map((id) => byId.get(id)).filter((m): m is Message => m !== undefined)
}

export function stats(personId = PERSON_ID): {
  sessions: number
  messages: number
  memories: number
  episodes: number
  facts: number
  openLoops: number
} {
  const one = (sql: string): number => {
    const row = getDb().prepare(sql).get(personId) as { n: number } | undefined
    return Number(row?.n ?? 0)
  }
  return {
    sessions: one('SELECT COUNT(*) AS n FROM chat_session WHERE person_id = ?'),
    messages: one(
      'SELECT COUNT(*) AS n FROM message m JOIN chat_session s ON s.id = m.session_id WHERE s.person_id = ?',
    ),
    memories: one("SELECT COUNT(*) AS n FROM memory WHERE person_id = ? AND status = 'active'"),
    episodes: one("SELECT COUNT(*) AS n FROM memory WHERE person_id = ? AND kind = 'episode' AND status = 'active'"),
    facts: one(
      "SELECT COUNT(*) AS n FROM memory WHERE person_id = ? AND kind != 'episode' AND status = 'active'",
    ),
    openLoops: one("SELECT COUNT(*) AS n FROM open_loop WHERE person_id = ? AND status = 'open'"),
  }
}

// ── 心智层：mind_state / thought / reflection / intention ───────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function getMindState(personId = PERSON_ID): MindState {
  const db = getDb()
  let row = db.prepare('SELECT * FROM mind_state WHERE person_id = ?').get(personId) as any
  if (row === undefined) {
    const at = nowIso()
    db.prepare(
      `INSERT INTO mind_state(person_id, mood_valence, mood_arousal, energy, attention, current_concern, updated_at)
       VALUES (?, 0, 0.4, 0.6, '', '', ?)`,
    ).run(personId, at)
    row = db.prepare('SELECT * FROM mind_state WHERE person_id = ?').get(personId) as any
  }
  return {
    personId: String(row.person_id),
    moodValence: Number(row.mood_valence),
    moodArousal: Number(row.mood_arousal),
    energy: Number(row.energy),
    attention: String(row.attention),
    currentConcern: String(row.current_concern),
    updatedAt: String(row.updated_at),
  }
}

export function updateMindState(
  personId: string,
  patch: Partial<Omit<MindState, 'personId' | 'updatedAt'>>,
): MindState {
  const current = getMindState(personId)
  const next: MindState = {
    ...current,
    moodValence: clamp(patch.moodValence ?? current.moodValence, -1, 1),
    moodArousal: clamp(patch.moodArousal ?? current.moodArousal, 0, 1),
    energy: clamp(patch.energy ?? current.energy, 0, 1),
    attention: patch.attention ?? current.attention,
    currentConcern: patch.currentConcern ?? current.currentConcern,
    updatedAt: nowIso(),
  }
  getDb()
    .prepare(
      `UPDATE mind_state
       SET mood_valence = ?, mood_arousal = ?, energy = ?, attention = ?,
           current_concern = ?, updated_at = ?
       WHERE person_id = ?`,
    )
    .run(
      next.moodValence,
      next.moodArousal,
      next.energy,
      next.attention,
      next.currentConcern,
      next.updatedAt,
      personId,
    )
  return next
}

function rowToThought(row: any): Thought {
  return {
    id: String(row.id),
    personId: String(row.person_id),
    sessionId: row.session_id ? String(row.session_id) : null,
    turnMessageId: row.turn_message_id === null ? null : Number(row.turn_message_id),
    kind: String(row.kind) as ThoughtKind,
    content: String(row.content),
    confidence: Number(row.confidence),
    selected: Number(row.selected) === 1,
    visible: Number(row.visible) === 1,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    createdAt: String(row.created_at),
  }
}

export function pruneThoughts(now = new Date()): number {
  const result = getDb().prepare('DELETE FROM thought WHERE expires_at IS NOT NULL AND expires_at < ?').run(now.toISOString())
  return Number(result.changes)
}

export function createThought(input: {
  personId?: string
  sessionId?: string | null
  turnMessageId?: number | null
  kind: ThoughtKind
  content: string
  confidence?: number
  selected?: boolean
  visible?: boolean
  ttlDays?: number
}): Thought {
  const content = input.content.trim()
  if (content === '') throw new Error('思考内容不能为空')
  pruneThoughts()
  const at = new Date()
  const expiresAt = new Date(at.getTime() + (input.ttlDays ?? 7) * 86_400_000).toISOString()
  const id = nextId('t')
  getDb()
    .prepare(
      `INSERT INTO thought(
        id, person_id, session_id, turn_message_id, kind, content,
        confidence, selected, visible, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.personId ?? PERSON_ID,
      input.sessionId ?? null,
      input.turnMessageId ?? null,
      input.kind,
      content,
      clamp(input.confidence ?? 0.5, 0, 1),
      input.selected === true ? 1 : 0,
      input.visible === true ? 1 : 0,
      expiresAt,
      at.toISOString(),
    )
  const row = getDb().prepare('SELECT * FROM thought WHERE id = ?').get(id) as any
  return rowToThought(row)
}

export function listThoughts(personId = PERSON_ID, limit = 20): Thought[] {
  const rows = getDb()
    .prepare('SELECT * FROM thought WHERE person_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(personId, Math.min(Math.max(limit, 1), 200)) as any[]
  return rows.map(rowToThought)
}

function rowToReflection(row: any): Reflection {
  return {
    id: String(row.id),
    personId: String(row.person_id),
    sessionId: String(row.session_id),
    whatHappened: String(row.what_happened),
    userState: parseJsonObject(row.user_state),
    myState: parseJsonObject(row.my_state),
    learned: parseJsonArray(row.learned),
    unresolved: parseJsonArray(row.unresolved),
    relationshipDelta: parseJsonObject(row.relationship_delta),
    createdAt: String(row.created_at),
  }
}

export function createReflection(input: {
  personId?: string
  sessionId: string
  whatHappened: string
  userState?: Record<string, unknown>
  myState?: Record<string, unknown>
  learned?: unknown[]
  unresolved?: unknown[]
  relationshipDelta?: Record<string, unknown>
}): Reflection {
  const id = nextId('r')
  const at = nowIso()
  getDb()
    .prepare(
      `INSERT INTO reflection(
        id, person_id, session_id, what_happened, user_state, my_state,
        learned, unresolved, relationship_delta, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.personId ?? PERSON_ID,
      input.sessionId,
      input.whatHappened.trim(),
      JSON.stringify(input.userState ?? {}),
      JSON.stringify(input.myState ?? {}),
      JSON.stringify(input.learned ?? []),
      JSON.stringify(input.unresolved ?? []),
      JSON.stringify(input.relationshipDelta ?? {}),
      at,
    )
  const row = getDb().prepare('SELECT * FROM reflection WHERE id = ?').get(id) as any
  return rowToReflection(row)
}

export function listReflections(personId = PERSON_ID, limit = 10): Reflection[] {
  const rows = getDb()
    .prepare('SELECT * FROM reflection WHERE person_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(personId, Math.min(Math.max(limit, 1), 100)) as any[]
  return rows.map(rowToReflection)
}

function rowToIntention(row: any): Intention {
  return {
    id: String(row.id),
    personId: String(row.person_id),
    text: String(row.text),
    kind: String(row.kind) as IntentionKind,
    dueAt: row.due_at ? String(row.due_at) : null,
    status: String(row.status) as IntentionStatus,
    sourceReflectionId: row.source_reflection_id ? String(row.source_reflection_id) : null,
    lastSurfacedAt: row.last_surfaced_at ? String(row.last_surfaced_at) : null,
    surfaceCount: Number(row.surface_count ?? 0),
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  }
}

export const MAX_ACTIVE_INTENTIONS = 3

export function createIntention(input: {
  personId?: string
  text: string
  kind?: IntentionKind
  dueAt?: string | null
  sourceReflectionId?: string | null
}): Intention | undefined {
  const text = input.text.trim()
  if (text === '') return undefined
  const personId = input.personId ?? PERSON_ID
  const active = getDb()
    .prepare("SELECT COUNT(*) AS n FROM intention WHERE person_id = ? AND status = 'active'")
    .get(personId) as { n: number }
  if (Number(active.n) >= MAX_ACTIVE_INTENTIONS) return undefined
  const id = nextId('i')
  const at = nowIso()
  getDb()
    .prepare(
      `INSERT INTO intention(
        id, person_id, text, kind, due_at, status, source_reflection_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      id,
      personId,
      text,
      input.kind ?? 'follow_up',
      input.dueAt ?? null,
      input.sourceReflectionId ?? null,
      at,
    )
  const row = getDb().prepare('SELECT * FROM intention WHERE id = ?').get(id) as any
  return rowToIntention(row)
}

export function listIntentions(
  personId = PERSON_ID,
  status: IntentionStatus | 'all' = 'active',
  limit = 20,
): Intention[] {
  const rows =
    status === 'all'
      ? (getDb()
          .prepare('SELECT * FROM intention WHERE person_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(personId, limit) as any[])
      : (getDb()
          .prepare(
            `SELECT * FROM intention
             WHERE person_id = ? AND status = ?
             ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at DESC
             LIMIT ?`,
          )
          .all(personId, status, limit) as any[])
  return rows.map(rowToIntention)
}

export function getIntention(id: string): Intention | undefined {
  const row = getDb().prepare('SELECT * FROM intention WHERE id = ?').get(id) as any
  return row === undefined ? undefined : rowToIntention(row)
}

export function listDueIntentions(personId = PERSON_ID, now = new Date()): Intention[] {
  const at = now.toISOString()
  const day = at.slice(0, 10)
  const rows = getDb()
    .prepare(
      `SELECT * FROM intention
       WHERE person_id = ?
         AND status = 'active'
         AND due_at IS NOT NULL
         AND due_at <= ?
         AND (last_surfaced_at IS NULL OR substr(last_surfaced_at, 1, 10) <> ?)
       ORDER BY due_at ASC, created_at ASC
       LIMIT 5`,
    )
    .all(personId, at, day) as any[]
  return rows.map(rowToIntention)
}

export function claimIntentionSurface(id: string, now = new Date()): Intention | undefined {
  const at = now.toISOString()
  const day = at.slice(0, 10)
  const result = getDb()
    .prepare(
      `UPDATE intention
       SET last_surfaced_at = ?, surface_count = surface_count + 1
       WHERE id = ? AND status = 'active'
         AND (last_surfaced_at IS NULL OR substr(last_surfaced_at, 1, 10) <> ?)`,
    )
    .run(at, id, day)
  if (Number(result.changes) === 0) return undefined
  return getIntention(id)
}

export function completeIntention(id: string): boolean {
  const result = getDb()
    .prepare("UPDATE intention SET status = 'done', completed_at = ? WHERE id = ? AND status = 'active'")
    .run(nowIso(), id)
  return Number(result.changes) > 0
}

export function expireIntentions(now = new Date(), graceDays = 14): number {
  // due_at 是“该提起的时间”，不是“过期时间”；给它一段宽限期再标记 expired。
  const cutoff = new Date(now.getTime() - graceDays * 86_400_000).toISOString()
  const result = getDb()
    .prepare(
      "UPDATE intention SET status = 'expired' WHERE status = 'active' AND due_at IS NOT NULL AND due_at < ?",
    )
    .run(cutoff)
  return Number(result.changes)
}

// ── 联想边 / 矛盾 / 维护 ─────────────────────────────────────

function rowToEdge(row: any): Edge {
  return {
    srcMemoryId: String(row.src_memory_id),
    dstMemoryId: String(row.dst_memory_id),
    relation: String(row.relation),
    weight: Number(row.weight),
    createdAt: String(row.created_at),
  }
}

export function clearEdges(personId = PERSON_ID): void {
  getDb().prepare('DELETE FROM edge WHERE person_id = ?').run(personId)
}

export function insertEdge(input: {
  personId?: string
  srcMemoryId: string
  dstMemoryId: string
  relation: string
  weight: number
}): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO edge(person_id, src_memory_id, dst_memory_id, relation, weight, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.personId ?? PERSON_ID,
      input.srcMemoryId,
      input.dstMemoryId,
      input.relation,
      clamp(input.weight, 0, 1),
      nowIso(),
    )
  return Number(result.changes) > 0
}

export function listEdges(personId = PERSON_ID, limit = 1000): Edge[] {
  const rows = getDb()
    .prepare('SELECT * FROM edge WHERE person_id = ? ORDER BY weight DESC LIMIT ?')
    .all(personId, limit) as any[]
  return rows.map(rowToEdge)
}

export interface MemoryNeighbor {
  memory: Memory
  relation: string
  weight: number
}

export function neighborsOf(memoryId: string, limit = 5): MemoryNeighbor[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM edge
       WHERE src_memory_id = ? OR dst_memory_id = ?
       ORDER BY weight DESC LIMIT ?`,
    )
    .all(memoryId, memoryId, Math.max(1, Math.min(limit, 20))) as any[]
  const out: MemoryNeighbor[] = []
  for (const row of rows) {
    const otherId = String(row.src_memory_id) === memoryId
      ? String(row.dst_memory_id)
      : String(row.src_memory_id)
    const memory = getMemory(otherId)
    if (memory === undefined || memory.status !== 'active') continue
    out.push({ memory, relation: String(row.relation), weight: Number(row.weight) })
  }
  return out
}

function rowToContradiction(row: any): Contradiction {
  return {
    id: Number(row.id),
    personId: String(row.person_id),
    aMemoryId: String(row.a_memory_id),
    bMemoryId: String(row.b_memory_id),
    reason: String(row.reason),
    status: String(row.status) as Contradiction['status'],
    createdAt: String(row.created_at),
  }
}

export function clearContradictions(personId = PERSON_ID): void {
  getDb().prepare('DELETE FROM contradiction WHERE person_id = ?').run(personId)
}

export function insertContradiction(input: {
  personId?: string
  aMemoryId: string
  bMemoryId: string
  reason: string
}): boolean {
  const [a, b] = [input.aMemoryId, input.bMemoryId].sort()
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO contradiction(person_id, a_memory_id, b_memory_id, reason, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .run(input.personId ?? PERSON_ID, a, b, input.reason, nowIso())
  return Number(result.changes) > 0
}

export function listContradictions(
  personId = PERSON_ID,
  status: Contradiction['status'] | 'all' = 'pending',
  limit = 20,
): Contradiction[] {
  const rows =
    status === 'all'
      ? (getDb()
          .prepare('SELECT * FROM contradiction WHERE person_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(personId, limit) as any[])
      : (getDb()
          .prepare(
            'SELECT * FROM contradiction WHERE person_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
          )
          .all(personId, status, limit) as any[])
  return rows.map(rowToContradiction)
}

export function dismissContradiction(id: number): boolean {
  const result = getDb()
    .prepare("UPDATE contradiction SET status = 'dismissed' WHERE id = ? AND status = 'pending'")
    .run(id)
  return Number(result.changes) > 0
}

function rowToMaintenance(row: any): MaintenanceRun {
  return {
    id: Number(row.id),
    personId: String(row.person_id),
    at: String(row.at),
    trigger: String(row.trigger),
    scanned: Number(row.scanned),
    archived: Number(row.archived),
    edges: Number(row.edges),
    contradictions: Number(row.contradictions),
    expiredIntentions: Number(row.expired_intentions),
    thoughtsPruned: Number(row.thoughts_pruned),
    report: String(row.report),
  }
}

export function recordMaintenance(input: Omit<MaintenanceRun, 'id'>): MaintenanceRun {
  const result = getDb()
    .prepare(
      `INSERT INTO maintenance_run(
        person_id, at, trigger, scanned, archived, edges, contradictions,
        expired_intentions, thoughts_pruned, report
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.personId,
      input.at,
      input.trigger,
      input.scanned,
      input.archived,
      input.edges,
      input.contradictions,
      input.expiredIntentions,
      input.thoughtsPruned,
      input.report,
    )
  const row = getDb()
    .prepare('SELECT * FROM maintenance_run WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as any
  return rowToMaintenance(row)
}

export function lastMaintenance(personId = PERSON_ID): MaintenanceRun | undefined {
  const row = getDb()
    .prepare('SELECT * FROM maintenance_run WHERE person_id = ? ORDER BY at DESC, id DESC LIMIT 1')
    .get(personId) as any
  return row === undefined ? undefined : rowToMaintenance(row)
}
