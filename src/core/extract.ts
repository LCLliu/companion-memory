import { z } from 'zod'
import { transaction } from './db.ts'
import { completeJson, extractModel, type ChatMsg } from './llm.ts'
import {
  closeOpenLoop,
  createMemory,
  createOpenLoop,
  findExistingMemory,
  getMessagesAfter,
  getRelationship,
  getSession,
  listOpenLoops,
  markExtracted,
  normalizeText,
  upsertRelationship,
} from './store.ts'
import type { MemoryKind, OpenLoopKind } from './types.ts'

const SourceIds = z.array(z.number().int()).min(1)

const EpisodeSchema = z
  .object({
    summary: z.string().min(1),
    occurred_at: z.string().optional().nullable(),
    valence: z.number().min(-1).max(1).default(0),
    arousal: z.number().min(0).max(1).default(0.5),
    salience: z.number().min(0).max(1).default(0.5),
  })
  .nullable()

const FactSchema = z.object({
  kind: z.enum(['fact', 'preference', 'boundary', 'promise', 'relationship']).default('fact'),
  text: z.string().min(2),
  confidence: z.number().min(0).max(1).default(0.8),
  valid_from: z.string().optional().nullable(),
  valid_to: z.string().optional().nullable(),
  source_message_ids: SourceIds,
})

const OpenLoopSchema = z.object({
  text: z.string().min(2),
  kind: z.enum(['promise', 'plan', 'unresolved_topic', 'question']).default('plan'),
  due_at: z.string().optional().nullable(),
  source_message_ids: SourceIds,
})

const ExtractionSchema = z.object({
  episode: EpisodeSchema.default(null),
  facts: z.array(FactSchema).default([]),
  open_loops: z.array(OpenLoopSchema).default([]),
  closed_loop_ids: z.array(z.string()).default([]),
  relationship_updates: z.record(z.string(), z.string()).default({}),
})

export type Extraction = z.infer<typeof ExtractionSchema>

export interface ExtractionResult {
  episodeId: string | null
  factIds: string[]
  openLoopIds: string[]
  closedLoopIds: string[]
  skipped: number
  model: string
  extractedMessages: number
}

const EXTRACT_SYSTEM = `你是长期陪伴记忆系统的抽取器。只输出 JSON，不要解释、不要 markdown 代码块。

任务：从对话中抽取值得长期记住的内容。

规则：
1. 只抽用户明确表达的事实、偏好、边界、承诺；不要抽 AI 自己的话，不要推测。
2. 每条 fact / open_loop 必须带 source_message_ids，值是对话里 [#id] 的数字。
3. 没有值得记的就返回 "episode": null 和空数组。
4. episode.summary 一到三句话，只写发生了什么；valence -1..1，arousal 0..1，salience 0..1。
5. 不记寒暄、一次性情绪、临时任务状态、模型自己的推测。
6. 事实可能变化：职位、住址、关系状态可带 valid_from；不确定就不填。
7. relationship_updates 只允许这些键：nickname、tone、boundaries、rituals、current_chapter、trust_notes。

输出结构：
{
  "episode": {
    "summary": "一到三句话",
    "occurred_at": "2026-10-29T21:00:00+08:00",
    "valence": -0.2,
    "arousal": 0.5,
    "salience": 0.7
  },
  "facts": [
    {
      "kind": "fact | preference | boundary | promise | relationship",
      "text": "一句话",
      "confidence": 0.9,
      "valid_from": null,
      "valid_to": null,
      "source_message_ids": [12, 13]
    }
  ],
  "open_loops": [
    {
      "text": "答应过 / 没做完的事",
      "kind": "promise | plan | unresolved_topic | question",
      "due_at": null,
      "source_message_ids": [13]
    }
  ],
  "closed_loop_ids": ["ol-0001"],
  "relationship_updates": { "tone": "最近压力大，需要先接情绪" }
}`

function validDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}

function buildTranscript(messages: { id: number; role: string; content: string }[]): string {
  return messages
    .map((message) => `[#${message.id}] ${message.role}: ${message.content}`)
    .join('\n')
    .slice(-12_000)
}

const extracting = new Set<string>()

export async function extractSession(sessionId: string): Promise<ExtractionResult> {
  if (extracting.has(sessionId)) throw new Error('该会话正在抽取中，请稍候')
  extracting.add(sessionId)
  try {
    return await extractSessionInner(sessionId)
  } finally {
    extracting.delete(sessionId)
  }
}

async function extractSessionInner(sessionId: string): Promise<ExtractionResult> {
  const session = getSession(sessionId)
  if (session === undefined) throw new Error(`会话不存在：${sessionId}`)

  const pending = getMessagesAfter(sessionId, session.extractedSeq, 200)
  if (pending.length === 0) throw new Error('没有新的对话可抽取')

  const batch = pending.slice(-40)
  const transcript = buildTranscript(batch)
  const validIds = new Set(batch.map((message) => message.id))
  const lastId = batch[batch.length - 1]!.id

  const messages: ChatMsg[] = [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: `对话记录：\n${transcript}` },
  ]

  let parsed: Extraction
  let usedModel = extractModel()
  try {
    const result = await completeJson(messages)
    usedModel = result.model
    parsed = ExtractionSchema.parse(result.data)
  } catch (firstError) {
    // 一次修复尝试：把 schema 再强调一遍，避免因格式问题整轮失败
    const repair: ChatMsg[] = [
      ...messages,
      {
        role: 'user',
        content: `上一次抽取失败：${firstError instanceof Error ? firstError.message : String(firstError)}
请只输出符合前面结构的 JSON，不要解释。`,
      },
    ]
    const result = await completeJson(repair)
    usedModel = result.model
    parsed = ExtractionSchema.parse(result.data)
  }

  const facts = parsed.facts.filter((fact) =>
    fact.source_message_ids.some((id) => validIds.has(id)),
  )
  const openLoops = parsed.open_loops.filter((loop) =>
    loop.source_message_ids.some((id) => validIds.has(id)),
  )
  const allowedRelationshipKeys = new Set([
    'nickname',
    'tone',
    'boundaries',
    'rituals',
    'current_chapter',
    'trust_notes',
  ])

  const result = transaction<ExtractionResult>(() => {
    let episodeId: string | null = null
    if (parsed.episode !== null) {
      const episode = createMemory({
        personId: session.personId,
        kind: 'episode',
        level: 1,
        text: parsed.episode.summary.trim(),
        occurredAt: validDate(parsed.episode.occurred_at) ?? new Date().toISOString(),
        valence: parsed.episode.valence,
        arousal: parsed.episode.arousal,
        salience: parsed.episode.salience,
        confidence: 0.9,
        sourceSessionId: session.id,
        sourceMessageIds: batch.map((message) => message.id),
      })
      episodeId = episode.id
    }

    const factIds: string[] = []
    let skipped = 0
    const seenInBatch = new Set<string>()
    for (const fact of facts) {
      const key = normalizeText(fact.text)
      if (key.length < 4) {
        skipped += 1
        continue
      }
      if (seenInBatch.has(key) || findExistingMemory(session.personId, fact.text) !== undefined) {
        skipped += 1
        continue
      }
      seenInBatch.add(key)
      const kind = fact.kind as MemoryKind
      const memory = createMemory({
        personId: session.personId,
        kind,
        level: 1,
        text: fact.text.trim(),
        validFrom: validDate(fact.valid_from),
        validTo: validDate(fact.valid_to),
        salience: kind === 'boundary' || kind === 'promise' ? 0.85 : 0.55,
        confidence: fact.confidence,
        sourceSessionId: session.id,
        sourceMessageIds: fact.source_message_ids.filter((id) => validIds.has(id)),
      })
      factIds.push(memory.id)
    }

    const openLoopIds: string[] = []
    const existingLoops = listOpenLoops(session.personId, 'open', 200)
    const loopKeys = new Set(existingLoops.map((loop) => normalizeText(loop.text)))
    for (const loop of openLoops) {
      const key = normalizeText(loop.text)
      if (key.length < 4 || loopKeys.has(key)) {
        skipped += 1
        continue
      }
      loopKeys.add(key)
      const created = createOpenLoop({
        personId: session.personId,
        text: loop.text.trim(),
        kind: loop.kind as OpenLoopKind,
        dueAt: validDate(loop.due_at),
        sourceMessageIds: loop.source_message_ids.filter((id) => validIds.has(id)),
      })
      openLoopIds.push(created.id)
    }

    const closedLoopIds: string[] = []
    for (const loopId of parsed.closed_loop_ids) {
      if (closeOpenLoop(loopId)) closedLoopIds.push(loopId)
    }

    for (const [key, value] of Object.entries(parsed.relationship_updates)) {
      if (!allowedRelationshipKeys.has(key)) continue
      const trimmed = value.trim()
      if (trimmed === '') continue
      const existing = getRelationship(session.personId).find((entry) => entry.key === key)
      if (existing?.value === trimmed) continue
      upsertRelationship(session.personId, key, trimmed)
    }

    markExtracted(session.id, lastId)

    return {
      episodeId,
      factIds,
      openLoopIds,
      closedLoopIds,
      skipped,
      model: usedModel,
      extractedMessages: batch.length,
    }
  })

  return result
}
