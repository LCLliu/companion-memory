import 'dotenv/config'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getDbPath } from '../core/db.ts'
import { buildBrief, buildMemoryContext, buildSystemPrompt } from '../core/inject.ts'
import { extractSession } from '../core/extract.ts'
import {
  chatModel,
  extractModel,
  isKeyConfigured,
  streamChat,
  type ChatMsg,
} from '../core/llm.ts'
import { retrieve } from '../core/retrieve.ts'
import {
  addMessage,
  closeOpenLoop,
  countUserMessages,
  createMemory,
  createOpenLoop,
  createSession,
  deleteMemory,
  findExistingMemory,
  getLastUserMessageId,
  getMemory,
  getSession,
  listMemories,
  listMessages,
  listOpenLoops,
  listRecentMessages,
  listSessions,
  listSourceMessages,
  logRecall,
  setMemoryPinned,
  setMemoryStatus,
  stats,
  touchMemory,
} from '../core/store.ts'
import type { MemoryKind, MemoryStatus, OpenLoopKind } from '../core/types.ts'

const PORT = Number(process.env.PORT ?? 3210)
const HOST = '127.0.0.1'
const EXTRACT_EVERY = Math.max(1, Number(process.env.EXTRACT_EVERY_TURNS ?? 20))

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: 64 * 1024,
})

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function configView() {
  return {
    chatModel: chatModel(),
    extractModel: extractModel(),
    keyConfigured: isKeyConfigured(),
    dbPath: getDbPath(),
    phase: 'Phase 0 · 白板记忆',
  }
}

app.get('/api/health', async () => ({ ok: true, at: new Date().toISOString() }))

app.get('/api/config', async () => configView())

app.get('/api/state', async () => ({
  ok: true,
  stats: stats(),
  config: configView(),
}))

// ── 会话 ─────────────────────────────────────────────────────

app.get('/api/sessions', async () => ({ items: listSessions() }))

app.post('/api/sessions', async (request) => {
  const body = (request.body ?? {}) as { title?: string }
  const session = createSession(undefined, body.title)
  return { ok: true, session, brief: buildBrief(session.personId) }
})

app.get('/api/sessions/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const session = getSession(id)
  if (session === undefined) return reply.code(404).send({ ok: false, message: '会话不存在' })
  return {
    ok: true,
    session,
    messages: listMessages(id),
    brief: buildBrief(session.personId),
    turnCount: countUserMessages(id),
  }
})

app.get('/api/sessions/:id/brief', async (request, reply) => {
  const { id } = request.params as { id: string }
  const session = getSession(id)
  if (session === undefined) return reply.code(404).send({ ok: false, message: '会话不存在' })
  return { ok: true, brief: buildBrief(session.personId) }
})

app.post('/api/sessions/:id/extract', async (request, reply) => {
  const { id } = request.params as { id: string }
  if (getSession(id) === undefined) return reply.code(404).send({ ok: false, message: '会话不存在' })
  try {
    const result = await extractSession(id)
    return { ok: true, result }
  } catch (error) {
    return reply.code(400).send({ ok: false, message: messageOf(error) })
  }
})

app.post('/api/sessions/:id/chat', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { message?: string }
  const text = (body.message ?? '').trim()
  const session = getSession(id)
  if (session === undefined) return reply.code(404).send({ ok: false, message: '会话不存在' })
  if (text === '') return reply.code(400).send({ ok: false, message: '消息不能为空' })
  if (text.length > 4000) return reply.code(400).send({ ok: false, message: '消息过长（上限 4000 字）' })
  if (!isKeyConfigured()) {
    return reply.code(400).send({
      ok: false,
      message: '未配置 LLM_API_KEY：请复制 .env.example 为 .env 并填入智谱 API Key',
    })
  }

  const userMessage = addMessage(id, 'user', text)
  const brief = buildBrief(session.personId)
  const topK = Math.max(1, Number(process.env.RECALL_TOP_K ?? 3))
  // 多取几条再剔除“简报里已经有的”，避免置顶记忆占掉 topK 的名额。
  const retrieval = retrieve(session.personId, text, { topK: topK + 5 })
  const briefIds = new Set([...brief.pinned, ...brief.episodes].map((memory) => memory.id))
  const selectedHits = retrieval.hits
    .filter((hit) => !briefIds.has(hit.memory.id))
    .slice(0, topK)
  const memoryBlock = buildMemoryContext(brief, selectedHits)
  const system = buildSystemPrompt(memoryBlock.text)

  for (const hit of selectedHits) {
    logRecall({
      personId: session.personId,
      memoryId: hit.memory.id,
      query: retrieval.query,
      score: hit.final,
      injected: true,
    })
    touchMemory(hit.memory.id)
  }

  const history = listRecentMessages(id, 12)
  const messages: ChatMsg[] = [
    { role: 'system', content: system },
    ...history.map((message) => ({
      role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: message.content,
    })),
  ]

  reply.hijack()
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const send = (event: string, data: unknown): void => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  send('meta', {
    sessionId: id,
    userMessage,
    injected: selectedHits.map((hit) => ({
      id: hit.memory.id,
      kind: hit.memory.kind,
      text: hit.memory.text,
      score: Number(hit.final.toFixed(4)),
    })),
    retrieval: {
      mode: retrieval.mode,
      query: retrieval.query,
      hits: retrieval.hits.slice(0, 10).map((hit) => ({
        id: hit.memory.id,
        text: hit.memory.text,
        kind: hit.memory.kind,
        bm25: Number(hit.bm25.toFixed(4)),
        norm: Number(hit.norm.toFixed(4)),
        recency: Number(hit.recency.toFixed(4)),
        salience: Number(hit.salience.toFixed(4)),
        final: Number(hit.final.toFixed(4)),
      })),
    },
    brief: brief.text,
    memoryBlock: memoryBlock.text,
  })

  try {
    let streamed = ''
    const full = await streamChat(messages, (delta) => {
      streamed += delta
      send('delta', { text: delta })
    })
    void streamed
    const assistant = addMessage(id, 'assistant', full, memoryBlock.injectedIds)
    const turnCount = countUserMessages(id)
    const autoExtract = turnCount % EXTRACT_EVERY === 0
    send('done', {
      assistant,
      turnCount,
      autoExtract,
      injectedIds: memoryBlock.injectedIds,
    })
    reply.raw.end()
    if (autoExtract) {
      void extractSession(id).catch((error) => {
        app.log.warn({ err: messageOf(error), sessionId: id }, 'auto extract failed')
      })
    }
  } catch (error) {
    send('error', { message: messageOf(error) })
    reply.raw.end()
  }
})

// ── 记忆 ─────────────────────────────────────────────────────

app.get('/api/memories', async (request) => {
  const query = request.query as Record<string, string | undefined>
  const status = (query.status ?? 'active') as MemoryStatus | 'all'
  const kind = (query.kind ?? 'all') as MemoryKind | 'all'
  const items = listMemories({
    status,
    kind,
    q: query.q,
    pinned: query.pinned === 'true' ? true : undefined,
    limit: Number(query.limit ?? 100),
  })
  return { ok: true, items }
})

app.get('/api/memories/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const memory = getMemory(id)
  if (memory === undefined) return reply.code(404).send({ ok: false, message: '记忆不存在' })
  return {
    ok: true,
    memory,
    sourceMessages: listSourceMessages(memory.sourceMessageIds),
  }
})

app.post('/api/memories', async (request, reply) => {
  const body = (request.body ?? {}) as {
    text?: string
    kind?: MemoryKind
    pinned?: boolean
    sessionId?: string
  }
  const text = (body.text ?? '').trim()
  if (text === '') return reply.code(400).send({ ok: false, message: '记忆内容不能为空' })
  const personId = 'p-0001'
  const existing = findExistingMemory(personId, text)
  if (existing !== undefined) {
    return { ok: true, duplicate: true, memory: existing }
  }
  const sourceMessageId =
    body.sessionId === undefined ? undefined : getLastUserMessageId(body.sessionId)
  const memory = createMemory({
    personId,
    kind: body.kind ?? 'fact',
    text,
    pinned: body.pinned === true,
    salience: body.pinned === true ? 0.9 : 0.7,
    sourceSessionId: body.sessionId ?? null,
    sourceMessageIds: sourceMessageId === undefined ? [] : [sourceMessageId],
  })
  return { ok: true, duplicate: false, memory }
})

app.post('/api/memories/:id/pin', async (request, reply) => {
  const { id } = request.params as { id: string }
  const body = (request.body ?? {}) as { pinned?: boolean }
  const ok = setMemoryPinned(id, body.pinned === true)
  if (!ok) return reply.code(404).send({ ok: false, message: '记忆不存在' })
  return { ok: true }
})

app.post('/api/memories/:id/archive', async (request, reply) => {
  const { id } = request.params as { id: string }
  const ok = setMemoryStatus(id, 'archived')
  if (!ok) return reply.code(404).send({ ok: false, message: '记忆不存在' })
  return { ok: true }
})

app.post('/api/memories/:id/restore', async (request, reply) => {
  const { id } = request.params as { id: string }
  const ok = setMemoryStatus(id, 'active')
  if (!ok) return reply.code(404).send({ ok: false, message: '记忆不存在' })
  return { ok: true }
})

app.delete('/api/memories/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const ok = deleteMemory(id)
  if (!ok) return reply.code(404).send({ ok: false, message: '记忆不存在' })
  return { ok: true }
})

// ── 未完成事项 ───────────────────────────────────────────────

app.get('/api/open-loops', async (request) => {
  const query = request.query as Record<string, string | undefined>
  const status = (query.status ?? 'open') as 'open' | 'closed' | 'stale' | 'all'
  return { ok: true, items: listOpenLoops('p-0001', status, 100) }
})

app.post('/api/open-loops', async (request, reply) => {
  const body = (request.body ?? {}) as { text?: string; kind?: OpenLoopKind; dueAt?: string }
  const text = (body.text ?? '').trim()
  if (text === '') return reply.code(400).send({ ok: false, message: '内容不能为空' })
  const loop = createOpenLoop({
    personId: 'p-0001',
    text,
    kind: body.kind ?? 'plan',
    dueAt: body.dueAt ?? null,
  })
  return { ok: true, loop }
})

app.post('/api/open-loops/:id/close', async (request, reply) => {
  const { id } = request.params as { id: string }
  const ok = closeOpenLoop(id)
  if (!ok) return reply.code(404).send({ ok: false, message: '未完成事项不存在或已关闭' })
  return { ok: true }
})

// ── 检索调试 ─────────────────────────────────────────────────

app.get('/api/debug/recall', async (request) => {
  const query = request.query as Record<string, string | undefined>
  const q = (query.q ?? '').trim()
  const topK = Number(query.topK ?? 20)
  const result = retrieve('p-0001', q, { topK, candidateLimit: 50 })
  return {
    ok: true,
    query: result.query,
    mode: result.mode,
    items: result.hits.map((hit) => ({
      id: hit.memory.id,
      text: hit.memory.text,
      kind: hit.memory.kind,
      status: hit.memory.status,
      pinned: hit.pinned,
      bm25: Number(hit.bm25.toFixed(4)),
      norm: Number(hit.norm.toFixed(4)),
      recency: Number(hit.recency.toFixed(4)),
      salience: Number(hit.salience.toFixed(4)),
      final: Number(hit.final.toFixed(4)),
      selected: result.selected.some((memory) => memory.id === hit.memory.id),
      sourceMessageIds: hit.memory.sourceMessageIds,
    })),
  }
})

app.get('/api/debug/injection', async (request) => {
  const query = request.query as Record<string, string | undefined>
  const q = (query.q ?? '').trim()
  const brief = buildBrief('p-0001')
  const topK = Math.max(1, Number(process.env.RECALL_TOP_K ?? 3))
  const retrieval = retrieve('p-0001', q, { topK })
  const context = buildMemoryContext(brief, retrieval.hits.slice(0, topK))
  return {
    ok: true,
    brief: brief.text,
    memoryBlock: context.text,
    injectedIds: context.injectedIds,
    retrieval,
  }
})

// ── 静态资源（生产构建）──────────────────────────────────────

const distDir = fileURLToPath(new URL('../../dist/web', import.meta.url))
const hasWebBuild = existsSync(distDir)
if (hasWebBuild) {
  await app.register(fastifyStatic, { root: distDir, prefix: '/' })
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ ok: false, message: 'Not found' })
    }
    return reply.sendFile('index.html')
  })
}

app.setErrorHandler((error: any, _request, reply) => {
  app.log.error({ err: error }, 'request failed')
  const status = typeof error?.statusCode === 'number' ? error.statusCode : 500
  const message = error instanceof Error ? error.message : String(error)
  reply.code(status).send({ ok: false, message })
})

await app.listen({ port: PORT, host: HOST })
app.log.info(
  `companion-memory ready: http://${HOST}:${PORT} · model=${chatModel()} · key=${isKeyConfigured() ? 'configured' : 'MISSING'}`,
)
