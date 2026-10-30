import { z } from 'zod'
import { completeJson, extractModel, mindModel } from '../core/llm.ts'
import {
  createMemory,
  latestChapter,
  listMemories,
  upsertRelationship,
} from '../core/store.ts'
import type { Memory } from '../core/types.ts'

const DAY = 86_400_000
const CHAPTER_MIN_EPISODES = 2
const CHAPTER_INTERVAL_HOURS = 24
const CHAPTER_WINDOW_DAYS = 7

export interface ChapterDue {
  episodes: Memory[]
  previous: Memory | undefined
}

export function chapterDue(personId = 'p-0001', now = new Date()): ChapterDue | null {
  const previous = latestChapter(personId)
  if (previous !== undefined) {
    const ageHours = (now.getTime() - Date.parse(previous.createdAt)) / 3_600_000
    if (Number.isFinite(ageHours) && ageHours < CHAPTER_INTERVAL_HOURS) return null
  }

  const since = previous?.createdAt ??
    new Date(now.getTime() - CHAPTER_WINDOW_DAYS * DAY).toISOString()
  const episodes = listMemories({
    personId,
    kind: 'episode',
    status: 'active',
    limit: 100,
    orderBy: 'occurred_at',
  })
    .filter((memory) => (memory.occurredAt ?? memory.createdAt) > since)
    .sort((a, b) => (a.occurredAt ?? a.createdAt).localeCompare(b.occurredAt ?? b.createdAt))

  if (episodes.length < CHAPTER_MIN_EPISODES) return null
  return { episodes, previous }
}

const ChapterSchema = z.object({
  chapter: z.string().min(1),
  self_narrative: z.string().min(1),
})

export interface ChapterResult {
  memory: Memory
  selfNarrative: string
}

export function saveChapter(input: {
  personId?: string
  chapter: string
  selfNarrative: string
  episodes: Memory[]
  now?: Date
}): ChapterResult {
  const personId = input.personId ?? 'p-0001'
  const now = input.now ?? new Date()
  const sourceMessageIds = [
    ...new Set(input.episodes.flatMap((episode) => episode.sourceMessageIds)),
  ]
  const memory = createMemory({
    personId,
    kind: 'chapter',
    level: 2,
    text: input.chapter.trim(),
    occurredAt: now.toISOString(),
    salience: 0.8,
    confidence: 0.8,
    sourceMessageIds,
  })
  upsertRelationship(personId, 'current_chapter', input.selfNarrative.trim())
  return { memory, selfNarrative: input.selfNarrative.trim() }
}

const SYSTEM = `你是这个 AI 伴侣的长期记忆巩固层。把最近的事件压成一段“阶段摘要”，并更新一句“我们最近”的自我叙事。
只输出 JSON，不要解释。

规则：
- chapter：2–4 句话，只写最近真正发生的事、变化和未解决的点；不要逐条罗列。
- self_narrative：1–2 句第一人称，写“我们最近处在什么阶段”；不要编造，也不要写成待办清单。
- 不把一次情绪当成永久人格；不确定的细节宁可省略。
- 不要提“系统 / 摘要层 / JSON / 记忆库”。

JSON 结构：
{ "chapter": "这两周她工作压力很大，周末去看了展，情绪比之前松了一些。", "self_narrative": "我们最近更像是在互相报平安，她愿意说累，我也学会了先听。" }`

let generating = false

export async function generateChapter(personId = 'p-0001', now = new Date()): Promise<ChapterResult | null> {
  if (generating) return null
  const due = chapterDue(personId, now)
  if (due === null) return null
  generating = true
  try {
    const episodeText = due.episodes
      .map((episode) => {
        const date = (episode.occurredAt ?? episode.createdAt).slice(0, 10)
        return `${date}：${episode.text}`
      })
      .join('\n')
    const previous = due.previous?.text ?? '（还没有上一阶段）'
    const result = await completeJson(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            `【上一阶段】\n${previous}`,
            `【最近事件】\n${episodeText}`,
            `【时间】${now.toISOString().slice(0, 10)}`,
          ].join('\n\n'),
        },
      ],
      { model: mindModel(), fallback: extractModel(), temperature: 0.3 },
    )
    const parsed = ChapterSchema.parse(result.data)
    return saveChapter({
      personId,
      chapter: parsed.chapter,
      selfNarrative: parsed.self_narrative,
      episodes: due.episodes,
      now,
    })
  } finally {
    generating = false
  }
}
