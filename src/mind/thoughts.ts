import { createThought } from '../core/store.ts'
import type { Thought } from '../core/types.ts'
import type { Appraisal } from './appraise.ts'
import type { DeliberationPlan } from './deliberate.ts'

export function recordPlanThought(input: {
  sessionId: string
  turnMessageId: number
  plan: DeliberationPlan
}): Thought {
  return createThought({
    sessionId: input.sessionId,
    turnMessageId: input.turnMessageId,
    kind: 'summary',
    content: input.plan.thoughtSummary,
    confidence: input.plan.confidence,
    selected: true,
    visible: true,
    ttlDays: 7,
  })
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
