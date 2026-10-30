import type { MindState } from '../core/types.ts'
import type { DeliberationPlan } from './deliberate.ts'
import type { Percept } from './perceive.ts'

export interface Appraisal {
  label: string
  valence: number
  arousal: number
  needs: string[]
  stakes: number
  impact: 'positive' | 'neutral' | 'tense' | 'low'
  confidence: number
  summary: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function appraiseTurn(percept: Percept, plan: DeliberationPlan | null): Appraisal {
  const label = plan?.userState.label ?? percept.emotion.label
  const needs = plan !== null && plan.userState.needs.length > 0
    ? plan.userState.needs
    : percept.needs
  const valence = percept.emotion.valence
  const arousal = percept.emotion.arousal
  const stakes = plan?.stakes ??
    (percept.risk === 'high' ? 0.8 : percept.risk === 'medium' ? 0.5 : 0.2)
  const impact: Appraisal['impact'] = percept.intent === 'conflict'
    ? 'tense'
    : valence > 0.2
      ? 'positive'
      : valence < -0.2
        ? 'low'
        : 'neutral'
  const summary = `你看起来${label}，可能想${needs.join('、') || '自然聊聊'}。`

  return {
    label,
    valence,
    arousal,
    needs,
    stakes,
    impact,
    confidence: plan?.userState.confidence ?? percept.emotion.confidence,
    summary,
  }
}

export function blendMindState(
  state: MindState,
  appraisal: Appraisal,
): Partial<Omit<MindState, 'personId' | 'updatedAt'>> {
  return {
    moodValence: clamp(state.moodValence * 0.85 + appraisal.valence * 0.15, -1, 1),
    moodArousal: clamp(state.moodArousal * 0.85 + appraisal.arousal * 0.15, 0, 1),
    energy: Math.max(0.2, state.energy - 0.01),
    attention: appraisal.summary.slice(0, 80),
  }
}
