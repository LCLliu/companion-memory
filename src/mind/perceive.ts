import type { MindState } from '../core/types.ts'

export interface MediaRef {
  id: string
  kind: 'image' | 'audio' | 'video' | 'file'
  caption?: string
}

export interface Percept {
  text: string
  /** 多模态预留：当前永远是空数组，等 M1 再填。 */
  attachments: MediaRef[]
  modalityNotes: string[]
  emotion: {
    label: string
    valence: number
    arousal: number
    confidence: number
  }
  intent: 'chat' | 'vent' | 'ask' | 'decide' | 'recall' | 'conflict'
  urgency: number
  relationshipCue: boolean
  ambiguity: number
  needs: string[]
  risk: 'low' | 'medium' | 'high'
}

export interface RouteDecision {
  slow: boolean
  reasons: string[]
  percept: Percept
}

const NEGATIVE = [
  '难过', '累', '烦', '焦虑', '害怕', '生气', '委屈', '孤独', '崩溃',
  '压力', '难受', '失望', '伤心', '疼', '痛', '讨厌', '想哭', '失眠',
]
const POSITIVE = ['开心', '高兴', '喜欢', '期待', '兴奋', '舒服', '放松', '满足', '感动', '幸福']
const CONFLICT = ['吵架', '分手', '冷战', '骗', '敷衍', '不在乎', '你总是', '你根本', '滚', '讨厌你']
const RELATIONSHIP = ['记得', '上次', '之前', '我们', '你答应', '答应过', '想你', '对不起', '抱歉', '关系']
const DECISION = ['怎么办', '该不该', '要不要', '选哪个', '建议', '决定', '选择', '帮我拿主意']
const MEMORY_CUE = ['还记得', '你记得', '记不记得', '上次说', '以前说', '我说过']
const BOUNDARY = ['不要', '别', '禁止', '必须', '答应', '保证', '承诺']

function hits(text: string, words: string[]): string[] {
  return words.filter((word) => text.includes(word))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function perceiveMessage(text: string, mindState: MindState): Percept {
  const negative = hits(text, NEGATIVE)
  const positive = hits(text, POSITIVE)
  const conflict = hits(text, CONFLICT)
  const relationship = hits(text, RELATIONSHIP)
  const decision = hits(text, DECISION)
  const memoryCue = hits(text, MEMORY_CUE)
  const boundary = hits(text, BOUNDARY)

  const valence = clamp(positive.length * 0.25 - negative.length * 0.25, -1, 1)
  const arousal = clamp(0.35 + negative.length * 0.12 + positive.length * 0.08 + conflict.length * 0.15, 0, 1)
  const label = conflict.length > 0
    ? '冲突'
    : negative.length > 0
      ? (negative[0] ?? '低落')
      : positive.length > 0
        ? (positive[0] ?? '愉快')
        : '平静'

  const emotionScore = negative.length + positive.length > 0 ? 2 : 0
  const relationshipCue = relationship.length + memoryCue.length > 0
  const intent: Percept['intent'] = conflict.length > 0
    ? 'conflict'
    : memoryCue.length > 0
      ? 'recall'
      : decision.length > 0
        ? 'decide'
        : negative.length > 0
          ? 'vent'
          : positive.length > 0
            ? 'chat'
            : 'chat'

  const ambiguity = /为什么|什么意思|你猜|那个|这件事|哪件|怎么办|是不是/.test(text) ? 0.65 : 0.2

  const needs: string[] = []
  if (negative.length > 0) needs.push('被听见', '被理解')
  if (decision.length > 0) needs.push('想要一个方向')
  if (memoryCue.length > 0) needs.push('被记得')
  if (needs.length === 0) needs.push('自然回应')

  return {
    text,
    attachments: [],
    modalityNotes: [],
    emotion: {
      label,
      valence,
      arousal,
      confidence: negative.length + positive.length + conflict.length > 0 ? 0.7 : 0.4,
    },
    intent,
    urgency: clamp(0.2 + negative.length * 0.15 + conflict.length * 0.3, 0, 1),
    relationshipCue,
    ambiguity,
    needs,
    risk: conflict.length > 0 ? 'high' : negative.length > 0 || decision.length > 0 ? 'medium' : 'low',
  }
}

export function routePercept(percept: Percept, mindState: MindState): RouteDecision {
  const text = percept.text
  const reasons: string[] = []
  let score = 0

  if (percept.emotion.confidence >= 0.7 && Math.abs(percept.emotion.valence) > 0.1) {
    score += 2
    reasons.push(`情绪线索：${percept.emotion.label}`)
  }
  if (percept.emotion.valence < -0.15) {
    score += 1
    reasons.push('负向情绪')
  }
  if (percept.intent === 'conflict') {
    score += 3
    reasons.push('冲突信号')
  }
  if (percept.intent === 'recall') {
    score += 3
    reasons.push('记忆确认')
  } else if (percept.relationshipCue) {
    score += 2
    reasons.push('关系线索')
  }
  if (percept.intent === 'decide') {
    score += 2
    reasons.push('需要拿主意')
  }
  if (hits(text, BOUNDARY).length > 0) {
    score += 2
    reasons.push('边界/承诺')
  }
  if (percept.ambiguity >= 0.6) {
    score += 1
    reasons.push('信息不够明确')
  }
  if (mindState.moodValence < -0.2 && percept.emotion.confidence >= 0.7) {
    score += 1
    reasons.push('她自己的状态也偏低')
  }
  if (text.length >= 80) {
    score += 0.5
    reasons.push('长消息')
  }

  return { slow: score >= 3, reasons, percept }
}

export function routeMessage(text: string, mindState: MindState): RouteDecision {
  return routePercept(perceiveMessage(text, mindState), mindState)
}
