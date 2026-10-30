import 'dotenv/config'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getDbPath } from '../core/db.ts'
import { buildBrief, buildMemoryContext, buildSystemPrompt } from '../core/inject.ts'
import {
  chatModel,
  completeChat,
  extractModel,
  isKeyConfigured,
  mindMode,
  mindModel,
  type ChatMsg,
} from '../core/llm.ts'
import { retrieve } from '../core/retrieve.ts'
import {
  addMessage,
  claimIntentionSurface,
  closeOpenLoop,
  completeIntention,
  countUserMessages,
  createMemory,
  createOpenLoop,
  createSession,
  deleteMemory,
  dismissContradiction,
  expireIntentions,
  findExistingMemory,
  getLastUserMessageId,
  getMemory,
  getMindState,
  getRelationship,
  getRelationshipSnapshot,
  getSession,
  lastMaintenance,
  latestChapter,
  listContradictions,
  listDueIntentions,
  listIntentions,
  listMemories,
  listMessages,
  listOpenLoops,
  listRecentMessages,
  listReflections,
  listSessions,
  listSourceMessages,
  listThoughts,
  logRecall,
  reinforceMemory,
  setMemoryPinned,
  setMemoryStatus,
  stats,
  updateMindState,
} from '../core/store.ts'
import { runMaintenance } from '../core/maintenance.ts'
import { generateChapter } from '../mind/chapter.ts'
import { splitBubbles } from '../mind/chat-format.ts'
import type { MemoryKind, MemoryStatus, Message, OpenLoopKind } from '../core/types.ts'
import { appraiseTurn, blendMindState } from '../mind/appraise.ts'
import { deliberatePlan, type DeliberationPlan } from '../mind/deliberate.ts'
import { buildFollowUpExtra, buildMindSystemPrompt } from '../mind/express.ts'
import { generateOpening } from '../mind/opening.ts'
import { routeMessage } from '../mind/perceive.ts'
import { reflectSession } from '../mind/reflect.ts'
import { recordAppraisalThought, recordPlanThought } from '../mind/thoughts.ts'

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
    phase: 'Phase 4 · 阶段摘要与评测',
    mindMode: mindMode(),
    mindModel: mindModel(),
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
  return {
    ok: true,
    session,
    brief: buildBrief(session.personId),
    followUp: listDueIntentions(session.personId)[0] ?? null,
  }
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
    followUp: listDueIntentions(session.personId)[0] ?? null,
  }
})

app.post('/api/sessions/:id/opening', async (request, reply) => {
  const { id } = request.params as { id: string }
  if (getSession(id) === undefined) return reply.code(404).send({ ok: false, message: '会话不存在' })
  if (!isKeyConfigured()) return { ok: true, skipped: true, reason: '未配置模型 Key' }
  try {
    const result = await generateOpening(id)
    if (result === null) return { ok: true, skipped: true }
    return { ok: true, skipped: false, messages: result.messages, kind: result.kind }
  } catch (error) {
    return reply.code(400).send({ ok: false, message: messageOf(error) })
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
    const data = await reflectSession(id)
    return {
      ok: true,
      result: data.extraction,
      reflection: data.reflection,
      intention: data.intention,
      reflectionError: data.reflectionError,
    }
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
      message: '未配置 LLM_API_KEY：请复制 .env.example 为 .env 并填入 DeepSeek API Key',
    })
  }

  const priorUserMessages = countUserMessages(id)
  const followUp = priorUserMessages === 0 ? (listDueIntentions(session.personId)[0] ?? null) : null
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

  for (const hit of selectedHits) {
    // 检索只读：不再 touchMemory。强化只由显式确认/反思触发。
    logRecall({
      personId: session.personId,
      memoryId: hit.memory.id,
      query: retrieval.query,
      score: hit.final,
      injected: true,
    })
  }

  const history = listRecentMessages(id, 12)
  const mode = mindMode()
  const mindState = getMindState(session.personId)
  const route = routeMessage(text, mindState)
  const deliberationInput = {
    percept: route.percept,
    recent: history.map((message) => ({
      role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: message.content,
    })),
    memoryBlock: memoryBlock.text,
    briefText: brief.text,
    mindState,
    relationship: brief.relationship,
  }

  let plan: DeliberationPlan | null = null
  let shadowPromise: Promise<void> | null = null
  if (mode === 'on' && route.slow) {
    try {
      plan = (await deliberatePlan(deliberationInput)).plan
    } catch (error) {
      app.log.warn({ err: messageOf(error), sessionId: id }, 'slow deliberation failed; fallback to fast')
    }
  } else if (mode === 'shadow' && route.slow) {
    shadowPromise = deliberatePlan(deliberationInput)
      .then(({ plan: shadowPlan }) => {
        recordPlanThought({ sessionId: id, turnMessageId: userMessage.id, plan: shadowPlan })
      })
      .catch((error) => {
        app.log.warn({ err: messageOf(error), sessionId: id }, 'shadow deliberation failed')
      })
  }

  const appraisal = mode !== 'off' && route.slow
    ? appraiseTurn(route.percept, plan)
    : null

  const baseSystem = mode === 'off'
    ? buildSystemPrompt(memoryBlock.text)
    : buildMindSystemPrompt(memoryBlock.text, mindState, plan)
  const system = followUp === null ? baseSystem : `${baseSystem}\n\n${buildFollowUpExtra(followUp)}`
  const messages: ChatMsg[] = [
    { role: 'system', content: system },
    ...history.map((message) => ({
      role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: message.content,
    })),
  ]

  const mindMeta = {
    mode,
    slow: route.slow,
    reasons: route.reasons,
    plan: plan === null
      ? null
      : {
          chosen: plan.chosen,
          tone: plan.tone,
          thoughtSummary: plan.thoughtSummary,
          confidence: plan.confidence,
        },
    appraisal: appraisal === null
      ? null
      : {
          label: appraisal.label,
          valence: Number(appraisal.valence.toFixed(3)),
          arousal: Number(appraisal.arousal.toFixed(3)),
          needs: appraisal.needs,
          summary: appraisal.summary,
        },
    followUp: followUp === null
      ? null
      : { id: followUp.id, text: followUp.text, dueAt: followUp.dueAt },
    state: {
      moodValence: mindState.moodValence,
      moodArousal: mindState.moodArousal,
      energy: mindState.energy,
      attention: mindState.attention,
      currentConcern: mindState.currentConcern,
    },
  }

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
        emotion: Number(hit.emotion.toFixed(4)),
        reinforcement: Number(hit.reinforcement.toFixed(4)),
        unresolved: Number(hit.unresolved.toFixed(4)),
        final: Number(hit.final.toFixed(4)),
        via: hit.via,
      })),
    },
    brief: brief.text,
    memoryBlock: memoryBlock.text,
    mind: mindMeta,
  })

  try {
    send('typing', {})
    const full = await completeChat(messages, { model: chatModel(), temperature: 0.85 })
    const bubbles = splitBubbles(full)
    const assistants: Message[] = []
    for (const [index, bubble] of bubbles.entries()) {
      const assistantMessage = addMessage(
        id,
        'assistant',
        bubble,
        index === 0 ? memoryBlock.injectedIds : [],
      )
      assistants.push(assistantMessage)
      send('bubble', { text: bubble, index, id: assistantMessage.id })
      if (index < bubbles.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 220))
      }
    }
    const assistant = assistants[assistants.length - 1]!
    const turnCount = countUserMessages(id)
    const autoExtract = turnCount % EXTRACT_EVERY === 0
    send('done', {
      assistant,
      assistants,
      turnCount,
      autoExtract,
      autoReflect: autoExtract,
      injectedIds: memoryBlock.injectedIds,
      followUp: followUp === null
        ? null
        : { id: followUp.id, text: followUp.text, dueAt: followUp.dueAt },
      mind: {
        mode,
        slow: route.slow,
        thoughtRecorded: mode === 'on' && plan !== null,
      },
    })
    reply.raw.end()

    if (mode === 'on' && plan !== null) {
      try {
        recordPlanThought({ sessionId: id, turnMessageId: userMessage.id, plan })
      } catch (error) {
        app.log.warn({ err: messageOf(error), sessionId: id }, 'record thought failed')
      }
    }
    if (appraisal !== null) {
      try {
        recordAppraisalThought({ sessionId: id, turnMessageId: userMessage.id, appraisal })
        updateMindState(session.personId, blendMindState(mindState, appraisal))
      } catch (error) {
        app.log.warn({ err: messageOf(error), sessionId: id }, 'record appraisal failed')
      }
    }
    if (followUp !== null) {
      try {
        claimIntentionSurface(followUp.id)
      } catch (error) {
        app.log.warn({ err: messageOf(error), sessionId: id }, 'claim follow-up failed')
      }
    }
    if (shadowPromise !== null) void shadowPromise
    if (autoExtract) {
      void reflectSession(id).catch((error) => {
        app.log.warn({ err: messageOf(error), sessionId: id }, 'auto reflect failed')
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

app.post('/api/memories/:id/reinforce', async (request, reply) => {
  const { id } = request.params as { id: string }
  const ok = reinforceMemory(id)
  if (!ok) return reply.code(404).send({ ok: false, message: '记忆不存在' })
  return { ok: true, memory: getMemory(id) }
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

// ── 内心 ─────────────────────────────────────────────────────

app.get('/api/mind', async () => {
  expireIntentions()
  const contradictions = listContradictions('p-0001', 'pending', 20).map((item) => ({
    ...item,
    aText: getMemory(item.aMemoryId)?.text ?? '（已不存在）',
    bText: getMemory(item.bMemoryId)?.text ?? '（已不存在）',
  }))
  return {
    ok: true,
    mode: mindMode(),
    model: mindModel(),
    state: getMindState(),
    thoughts: listThoughts(undefined, 20),
    reflections: listReflections(undefined, 5),
    intentions: listIntentions(undefined, 'active', 20),
    followUps: listDueIntentions(),
    relationship: getRelationship(),
    relationshipSnapshot: getRelationshipSnapshot(),
    contradictions,
    maintenance: lastMaintenance() ?? null,
    chapter: latestChapter() ?? null,
  }
})

app.post('/api/chapter/generate', async (_request, reply) => {
  try {
    const result = await generateChapter()
    if (result === null) {
      return { ok: true, skipped: true, reason: '没有足够的新事件，或距上次阶段摘要不足 24 小时' }
    }
    return { ok: true, skipped: false, chapter: result.memory, selfNarrative: result.selfNarrative }
  } catch (error) {
    return reply.code(400).send({ ok: false, message: messageOf(error) })
  }
})

app.post('/api/contradictions/:id/dismiss', async (request, reply) => {
  const id = Number((request.params as { id: string }).id)
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, message: '无效 id' })
  const ok = dismissContradiction(id)
  if (!ok) return reply.code(404).send({ ok: false, message: '矛盾不存在或已处理' })
  return { ok: true }
})

app.post('/api/maintenance/run', async () => {
  const run = runMaintenance({ trigger: 'manual' })
  return { ok: true, run }
})

app.post('/api/intentions/:id/done', async (request, reply) => {
  const { id } = request.params as { id: string }
  const ok = completeIntention(id)
  if (!ok) return reply.code(404).send({ ok: false, message: '意图不存在或已完成' })
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
      emotion: Number(hit.emotion.toFixed(4)),
      reinforcement: Number(hit.reinforcement.toFixed(4)),
      unresolved: Number(hit.unresolved.toFixed(4)),
      final: Number(hit.final.toFixed(4)),
      via: hit.via,
      selected: result.selected.some((memory) => memory.id === hit.memory.id),
      sourceMessageIds: hit.memory.sourceMessageIds,
    })),
  }
})

app.get('/api/debug/mind', async (request) => {
  const query = request.query as Record<string, string | undefined>
  const q = (query.q ?? '').trim()
  const state = getMindState()
  const route = routeMessage(q, state)
  return {
    ok: true,
    mode: mindMode(),
    state,
    percept: route.percept,
    slow: route.slow,
    reasons: route.reasons,
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

function maybeRunMaintenance(trigger: 'startup' | 'scheduled'): void {
  try {
    const last = lastMaintenance()
    if (last !== undefined && Date.now() - Date.parse(last.at) < 86_400_000) return
    const run = runMaintenance({ trigger })
    app.log.info(
      { trigger, scanned: run.scanned, archived: run.archived, edges: run.edges },
      'maintenance complete',
    )
  } catch (error) {
    app.log.warn({ err: messageOf(error), trigger }, 'maintenance failed')
  }
}

await app.listen({ port: PORT, host: HOST })
app.log.info(
  `companion-memory ready: http://${HOST}:${PORT} · model=${chatModel()} · mind=${mindMode()} · key=${isKeyConfigured() ? 'configured' : 'MISSING'}`,
)
async function maybeGenerateChapter(): Promise<void> {
  if (!isKeyConfigured()) return
  try {
    const result = await generateChapter()
    if (result !== null) {
      app.log.info({ chapter: result.memory.id }, 'chapter generated')
    }
  } catch (error) {
    app.log.warn({ err: messageOf(error) }, 'chapter generation failed')
  }
}

void maybeRunMaintenance('startup')
const maintenanceTimer = setInterval(() => maybeRunMaintenance('scheduled'), 3_600_000)
maintenanceTimer.unref()
void maybeGenerateChapter()
const chapterTimer = setInterval(() => void maybeGenerateChapter(), 3_600_000)
chapterTimer.unref()
