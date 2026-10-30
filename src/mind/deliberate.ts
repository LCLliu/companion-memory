import { z } from 'zod'
import { completeJson, extractModel, mindModel } from '../core/llm.ts'
import type { MindState, RelationshipEntry } from '../core/types.ts'
import type { Percept } from './perceive.ts'

const PlanSchema = z.object({
  user_state: z.object({
    label: z.string().min(1),
    needs: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(0.5),
  }),
  stakes: z.number().min(0).max(1).default(0.5),
  interpretations: z
    .array(
      z.object({
        reading: z.string().min(1),
        confidence: z.number().min(0).max(1).default(0.5),
      }),
    )
    .default([]),
  options: z
    .array(
      z.object({
        stance: z.string().min(1),
        reply_goal: z.string().default(''),
        risk: z.string().default(''),
      }),
    )
    .default([]),
  chosen: z.string().min(1),
  tone: z.string().min(1).default('自然'),
  should_ask: z.boolean().default(false),
  question: z.string().optional().nullable(),
  thought_summary: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1).default(0.6),
})

export interface DeliberationPlan {
  userState: { label: string; needs: string[]; confidence: number }
  stakes: number
  interpretations: Array<{ reading: string; confidence: number }>
  options: Array<{ stance: string; replyGoal: string; risk: string }>
  chosen: string
  tone: string
  shouldAsk: boolean
  question: string | null
  thoughtSummary: string
  confidence: number
  model: string
}

export interface DeliberationInput {
  percept: Percept
  recent: Array<{ role: 'user' | 'assistant'; content: string }>
  memoryBlock: string
  briefText: string
  mindState: MindState
  relationship: RelationshipEntry[]
}

const SYSTEM = `你是这个 AI 伴侣的“内在思考层”。你的输出不会直接给用户看，只用于决定怎么回应。
用第一人称想，但只输出 JSON，不要解释，不要写完整回复。

任务：
1. 判断用户这句话可能是什么意思（给 2–3 种解释，标置信度）。
2. 判断这件事的 stakes（0–1）：对情绪、关系、承诺的影响有多大。
3. 给出 2–3 种回应策略，分别说明目标与风险。
4. 选择一种策略；如果信息不足，选择“先问一句”。
5. 写一句 thought_summary（不超过 80 字），只写结论，不写推理过程。

硬规则：
- 只使用 <memory> 里出现过的记忆；没有证据就不要声称记得。
- 不推测用户没说过的事实；不确定就降低 confidence 或选择提问。
- 不讨好、不说教、不表演深刻。
- tone 要符合关系状态；紧张时先修复，不抖机灵。

JSON 结构：
{
  "user_state": { "label": "疲惫", "needs": ["被听见"], "confidence": 0.7 },
  "stakes": 0.6,
  "interpretations": [
    { "reading": "她在倾诉，不想听建议", "confidence": 0.7 },
    { "reading": "她在试探我是否记得", "confidence": 0.2 }
  ],
  "options": [
    { "stance": "先接情绪，再问一句", "reply_goal": "让她感到被听见", "risk": "低" },
    { "stance": "直接给方案", "reply_goal": "解决问题", "risk": "可能让她觉得被敷衍" }
  ],
  "chosen": "先接情绪，再问一句她想要建议还是想说说",
  "tone": "温和、简短",
  "should_ask": true,
  "question": "你是想让我听着，还是一起想想办法？",
  "thought_summary": "她可能只是想被听见，先别急着给方案。",
  "confidence": 0.75
}`

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function formatRecent(recent: DeliberationInput['recent']): string {
  if (recent.length === 0) return '（无）'
  return recent
    .slice(-6)
    .map((message) => `${message.role === 'user' ? '用户' : '我'}：${truncate(message.content, 240)}`)
    .join('\n')
}

function formatRelationship(relationship: RelationshipEntry[]): string {
  if (relationship.length === 0) return '（暂无）'
  return relationship.map((entry) => `- ${entry.key}: ${truncate(entry.value, 120)}`).join('\n')
}

export async function deliberatePlan(
  input: DeliberationInput,
): Promise<{ plan: DeliberationPlan; model: string }> {
  const userContent = [
    `【用户这句话】\n${input.percept.text}`,
    `【感知】\n意图=${input.percept.intent} · 情绪=${input.percept.emotion.label} ` +
      `(valence=${input.percept.emotion.valence.toFixed(2)}, arousal=${input.percept.emotion.arousal.toFixed(2)}) ` +
      `· 歧义=${input.percept.ambiguity.toFixed(2)} · 需求=${input.percept.needs.join('/')}`,
    `【我此刻的状态】\n心情 valence=${input.mindState.moodValence.toFixed(2)} ` +
      `arousal=${input.mindState.moodArousal.toFixed(2)} energy=${input.mindState.energy.toFixed(2)}\n` +
      `关注：${input.mindState.attention || '（无）'}\n担心：${input.mindState.currentConcern || '（无）'}`,
    `【关系】\n${formatRelationship(input.relationship)}`,
    `【最近对话】\n${formatRecent(input.recent)}`,
    `【记忆】\n${truncate(input.memoryBlock, 1600) || '（暂无）'}`,
  ].join('\n\n')

  const result = await completeJson(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userContent },
    ],
    { model: mindModel(), fallback: extractModel(), temperature: 0.35 },
  )

  const parsed = PlanSchema.parse(result.data)
  return {
    model: result.model,
    plan: {
      userState: parsed.user_state,
      stakes: parsed.stakes,
      interpretations: parsed.interpretations,
      options: parsed.options.map((option) => ({
        stance: option.stance,
        replyGoal: option.reply_goal,
        risk: option.risk,
      })),
      chosen: parsed.chosen,
      tone: parsed.tone,
      shouldAsk: parsed.should_ask,
      question: parsed.question?.trim() || null,
      thoughtSummary: truncate(parsed.thought_summary, 200),
      confidence: parsed.confidence,
      model: result.model,
    },
  }
}
