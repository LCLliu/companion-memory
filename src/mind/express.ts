import { buildSystemPrompt } from '../core/inject.ts'
import type { Intention, MindState } from '../core/types.ts'
import type { DeliberationPlan } from './deliberate.ts'

function moodLabel(state: MindState): string {
  if (state.moodValence < -0.25) return state.moodArousal > 0.6 ? '有点不安' : '有些低落'
  if (state.moodValence > 0.25) return state.moodArousal > 0.6 ? '比较兴奋' : '心情不错'
  return state.moodArousal > 0.6 ? '有点紧绷' : '平静'
}

export function buildMindExtra(mindState: MindState, plan: DeliberationPlan | null): string {
  const lines = [
    '【她此刻的状态】',
    `- 心情：${moodLabel(mindState)}（valence ${mindState.moodValence.toFixed(2)}，arousal ${mindState.moodArousal.toFixed(2)}）`,
    `- 能量：${mindState.energy.toFixed(2)}`,
    `- 正在关注：${mindState.attention || '眼前这段对话'}`,
  ]
  if (mindState.currentConcern !== '') {
    lines.push(`- 心里挂着：${mindState.currentConcern}`)
  }

  if (plan !== null) {
    lines.push('', '【本轮斟酌后的方向（内部结论，不要原样复述）】')
    lines.push(`- 判断：${plan.userState.label}；她可能需要：${plan.userState.needs.join('、') || '自然回应'}`)
    lines.push(`- 选择：${plan.chosen}`)
    lines.push(`- 语气：${plan.tone}`)
    if (plan.shouldAsk && plan.question !== null) {
      lines.push(`- 如果合适，可以先问：${plan.question}`)
    }
    lines.push('- 不要提“慢想 / 内心 / 思考过程 / 系统判断”，直接自然地回应。')
  } else {
    lines.push('', '【本轮是快速回应】不要过度解读，保持自然、简短。')
  }

  return lines.join('\n')
}

export function buildMindSystemPrompt(
  memoryBlock: string,
  mindState: MindState,
  plan: DeliberationPlan | null,
): string {
  return buildSystemPrompt(memoryBlock, buildMindExtra(mindState, plan))
}

export function buildFollowUpExtra(intention: Intention): string {
  const due = intention.dueAt === null ? '' : `（原本约在 ${intention.dueAt.slice(0, 10)}）`
  return [
    '【本来想问你】',
    `- 你之前记着：${intention.text}${due}`,
    '- 如果这次对话里自然，可以问一句；不要生硬，不要提“意图 / 提醒 / 系统”。',
    '- 如果用户正在说更重要的事，先不打断。',
  ].join('\n')
}
