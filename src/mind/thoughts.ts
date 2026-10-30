import { createThought } from '../core/store.ts'
import type { Thought } from '../core/types.ts'
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
