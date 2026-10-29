import { randomUUID } from 'node:crypto'
import { getDb } from './db.ts'
import type {
  Memory,
  MemoryKind,
  MemoryStatus,
  Message,
  OpenLoop,
  OpenLoopKind,
  OpenLoopStatus,
  Person,
  RelationshipEntry,
  Session,
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

function nextId(prefix: 'm' | 'ol'): string {
  const db = getDb()
  const table = prefix === 'm' ? 'memory' : 'open_loop'
  const key = prefix === 'm' ? 'memory_seq' : 'open_loop_seq'
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
}

export function createMemory(input: CreateMemoryInput): Memory {
  const text = input.text.trim()
  if (text === '') throw new Error('记忆内容不能为空')
  const id = nextId('m')
  const at = nowIso()
  getDb()
    .prepare(
      `INSERT INTO memory(
        id, person_id, kind, level, text, occurred_at, valid_from, valid_to,
        valence, arousal, salience, confidence, status, source_session_id,
        source_message_ids, pinned, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.personId ?? PERSON_ID,
      input.kind,
      input.level ?? 1,
      text,
      input.occurredAt ?? at,
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
      at,
    )
  return getMemory(id)!
}

export function getMemory(id: string): Memory | undefined {
  const row = getDb().prepare('SELECT * FROM memory WHERE id = ?').get(id) as any
  return row === undefined ? undefined : rowToMemory(row)
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

export function touchMemory(id: string): void {
  getDb()
    .prepare(
      'UPDATE memory SET access_count = access_count + 1, last_access = ? WHERE id = ?',
    )
    .run(nowIso(), id)
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
