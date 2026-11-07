import { createThought } from '../core/store.ts'
import type { Thought } from '../core/types.ts'
import type { Appraisal } from './appraise.ts'
import type { DeliberationPlan } from './deliberate.ts'

export function recordPlanThought(input: {
  sessionId: string
  turnMessageId: number
  plan: DeliberationPlan
}): Thought {
  const thought = createThought({
    sessionId: input.sessionId,
    turnMessageId: input.turnMessageId,
    kind: 'summary',
    content: input.plan.thoughtSummary,
    confidence: input.plan.confidence,
    selected: true,
    visible: true,
    ttlDays: 7,
  })
  if (input.plan.sticker?.want === true) {
    const hint = input.plan.sticker.hint ?? ''
    const reason = input.plan.sticker.reason ?? ''
    createThought({
      sessionId: input.sessionId,
      turnMessageId: input.turnMessageId,
      kind: 'intention_candidate',
      content: `想甩一张表情给他：${hint === '' ? '（没说清要哪张）' : hint}${reason === '' ? '' : `｜因为${reason}`}`,
      confidence: input.plan.confidence,
      selected: false,
      visible: true,
      ttlDays: 3,
    })
  }
  return thought
}

export function recordAppraisalThought(input: {
  sessionId: string
  turnMessageId: number
  appraisal: Appraisal
}): Thought {
  return createThought({
    sessionId: input.sessionId,
    turnMessageId: input.turnMessageId,
    kind: 'appraisal',
    content: input.appraisal.summary,
    confidence: input.appraisal.confidence,
    selected: false,
    visible: true,
    ttlDays: 7,
  })
}
