import { z } from 'zod'
import { extractSession, type ExtractionResult } from '../core/extract.ts'
import { buildBrief } from '../core/inject.ts'
import { completeJson, extractModel, mindModel } from '../core/llm.ts'
import {
  bumpRelationshipNumber,
  createIntention,
  createReflection,
  getMindState,
  getRelationship,
  getRelationshipSnapshot,
  getSession,
  listRecentMessages,
  setRelationshipNumber,
  updateMindState,
  upsertRelationship,
} from '../core/store.ts'
import type { Intention, Reflection } from '../core/types.ts'

const ReflectionSchema = z.object({
  what_happened: z.string().min(1),
  user_state: z.object({
    label: z.string().min(1),
    needs: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(0.5),
    valence: z.number().min(-1).max(1).optional(),
  }),
  my_state: z.object({
    mood: z.string().default('平静'),
    mood_valence: z.number().min(-1).max(1).optional(),
    mood_arousal: z.number().min(0).max(1).optional(),
    concerns: z.array(z.string()).default([]),
  }),
  relationship_delta: z
    .object({
      tone: z.string().optional(),
      tension_delta: z.number().min(-0.3).max(0.3).optional(),
      trust_delta: z.number().min(-0.3).max(0.3).optional(),
    })
    .default({}),
  unresolved: z.array(z.object({ text: z.string().min(1) })).default([]),
  next_intention: z
    .object({
      text: z.string().min(1),
      due_at: z.string().optional().nullable(),
    })
    .nullable()
    .default(null),
})

export interface ReflectSessionResult {
  extraction: ExtractionResult
  reflection: Reflection | null
  intention: Intention | null
  reflectionError?: string
}

const SYSTEM = `你是这个 AI 伴侣的“反思层”。对话刚结束，你只输出 JSON，不要解释。

事实抽取已经由另一层完成；你不要重复罗列事实，只写这次相处对你意味着什么：
- what_happened：一到两句话，只写发生的事。
- user_state：用户当时的状态、需要、你的判断置信度。
- my_state：你自己的心情、心情坐标（可选）、你在担心什么。
- relationship_delta：关系基调的变化；可给 tone，也可给很小的 tension_delta / trust_delta（-0.3..0.3）。
- unresolved：还没解决、值得记住的事（不是待办清单）。
- next_intention：如果下次合适，你想主动做的一件事；没有就给 null。

规则：
- 不要编造对话里没有的事。
- 不要把用户的一次情绪当成永久人格。
- 关系变化要小；一次对话不可能从陌生到生死相依。
- 不要提“系统 / 反思层 / JSON / 记忆库”。

JSON 结构：
{
  "what_happened": "她说了工作上的挫败，我没有急着给建议。",
  "user_state": { "label": "挫败", "needs": ["被听见"], "confidence": 0.7 },
  "my_state": { "mood": "担心", "mood_valence": -0.1, "mood_arousal": 0.45, "concerns": ["她最近连续加班"] },
  "relationship_delta": { "tone": "更愿意先听她说", "tension_delta": -0.05, "trust_delta": 0.05 },
  "unresolved": [{ "text": "她还没说面试结果" }],
  "next_intention": { "text": "周三晚上问一句面试怎么样", "due_at": "2026-11-04" }
}`

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function normalizeDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

export async function reflectSession(sessionId: string): Promise<ReflectSessionResult> {
  const extraction = await extractSession(sessionId)
  const session = getSession(sessionId)
  if (session === undefined) throw new Error(`会话不存在：${sessionId}`)

  const recent = listRecentMessages(sessionId, 20)
  const transcript = recent
    .map((message) => `${message.role === 'user' ? '用户' : '我'}：${truncate(message.content, 300)}`)
    .join('\n')
  const mindState = getMindState(session.personId)
  const brief = buildBrief(session.personId)
  const relationship = getRelationship(session.personId)
    .map((entry) => `- ${entry.key}: ${truncate(entry.value, 100)}`)
    .join('\n')
  const extracted = [
    extraction.episodeId ? `事件 ${extraction.episodeId}` : '无事件',
    `事实 ${extraction.factIds.length} 条`,
    `未完成 ${extraction.openLoopIds.length} 条`,
  ].join(' · ')

  try {
    const result = await completeJson(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            `【会话】${session.title}`,
            `【最近对话】\n${transcript || '（无）'}`,
            `【已抽取】${extracted}`,
            `【记忆简报】\n${truncate(brief.text, 1200) || '（暂无）'}`,
            `【关系】\n${relationship || '（暂无）'}`,
            `【我此刻的状态】valence=${mindState.moodValence.toFixed(2)} arousal=${mindState.moodArousal.toFixed(2)} ` +
              `energy=${mindState.energy.toFixed(2)}；关注：${mindState.attention || '（无）'}；担心：${mindState.currentConcern || '（无）'}`,
          ].join('\n\n'),
        },
      ],
      { model: mindModel(), fallback: extractModel(), temperature: 0.35 },
    )
    const parsed = ReflectionSchema.parse(result.data)

    const reflection = createReflection({
      personId: session.personId,
      sessionId,
      whatHappened: parsed.what_happened,
      userState: parsed.user_state,
      myState: parsed.my_state,
      learned: [
        {
          episodeId: extraction.episodeId,
          factIds: extraction.factIds,
          openLoopIds: extraction.openLoopIds,
        },
      ],
      unresolved: parsed.unresolved,
      relationshipDelta: parsed.relationship_delta,
    })

    const nextConcern = parsed.my_state.concerns.find((item) => item.trim() !== '')
    updateMindState(session.personId, {
      moodValence: parsed.my_state.mood_valence ?? mindState.moodValence,
      moodArousal: parsed.my_state.mood_arousal ?? mindState.moodArousal,
      attention: truncate(parsed.what_happened, 80),
      currentConcern: nextConcern ?? mindState.currentConcern,
    })

    const tone = parsed.relationship_delta.tone?.trim()
    if (tone !== undefined && tone !== '') {
      upsertRelationship(session.personId, 'tone', tone)
    }

    // 关系是慢变量：一次会话只允许小幅变化。
    if (parsed.relationship_delta.trust_delta !== undefined) {
      bumpRelationshipNumber(session.personId, 'trust', parsed.relationship_delta.trust_delta, 0, 1)
    }
    if (parsed.relationship_delta.tension_delta !== undefined) {
      bumpRelationshipNumber(session.personId, 'tension', parsed.relationship_delta.tension_delta, 0, 1)
    }
    bumpRelationshipNumber(session.personId, 'familiarity', 0.02, 0, 1)
    const recentMood = parsed.user_state.valence ?? parsed.my_state.mood_valence
    if (recentMood !== undefined) {
      setRelationshipNumber(session.personId, 'recent_mood', recentMood, -1, 1)
    }
    // 读一次快照，确保关系变化落盘后再返回（也为将来的返回值留位置）。
    void getRelationshipSnapshot(session.personId)

    const intention = parsed.next_intention === null
      ? null
      : createIntention({
          personId: session.personId,
          text: parsed.next_intention.text,
          dueAt: normalizeDate(parsed.next_intention.due_at),
          sourceReflectionId: reflection.id,
        }) ?? null

    return { extraction, reflection, intention }
  } catch (error) {
    return {
      extraction,
      reflection: null,
      intention: null,
      reflectionError: error instanceof Error ? error.message : String(error),
    }
  }
}
