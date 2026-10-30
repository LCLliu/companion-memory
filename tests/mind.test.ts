import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { resetDbForTests } from '../src/core/db.ts'
import {
  bumpRelationshipNumber,
  claimIntentionSurface,
  createIntention,
  createMemory,
  createReflection,
  createThought,
  completeIntention,
  getMindState,
  getMemory,
  getRelationshipSnapshot,
  listDueIntentions,
  listIntentions,
  listThoughts,
  reinforceMemory,
  setRelationshipNumber,
  updateMindState,
} from '../src/core/store.ts'
import { retrieve } from '../src/core/retrieve.ts'
import { appraiseTurn, blendMindState } from '../src/mind/appraise.ts'
import { perceiveMessage, routeMessage } from '../src/mind/perceive.ts'

beforeEach(() => {
  resetDbForTests(':memory:')
})

test('检索只读：召回不增加强化次数', () => {
  const memory = createMemory({ kind: 'preference', text: '我喜欢喝冰美式' })
  retrieve('p-0001', '冰美式')
  assert.equal(getMemory(memory.id)!.accessCount, 0)
  assert.equal(reinforceMemory(memory.id), true)
  assert.equal(getMemory(memory.id)!.accessCount, 1)
})

test('mind_state 默认值、更新与边界', () => {
  const initial = getMindState()
  assert.equal(initial.moodValence, 0)
  assert.equal(initial.energy, 0.6)

  const updated = updateMindState('p-0001', {
    moodValence: -2,
    moodArousal: 3,
    energy: -1,
    attention: '她在说工作',
    currentConcern: '她最近很累',
  })
  assert.equal(updated.moodValence, -1)
  assert.equal(updated.moodArousal, 1)
  assert.equal(updated.energy, 0)
  assert.equal(updated.attention, '她在说工作')
})

test('thought 写入与过期清理', () => {
  const thought = createThought({
    kind: 'summary',
    content: '她可能只是想被听见。',
    confidence: 0.8,
    selected: true,
    visible: true,
  })
  assert.match(thought.id, /^t-\d{4}$/)
  assert.equal(listThoughts('p-0001', 10).length, 1)
})

test('reflection 写入与读取', () => {
  const reflection = createReflection({
    sessionId: 's-test',
    whatHappened: '她说了工作上的挫败。',
    userState: { label: '挫败' },
    myState: { mood: '担心' },
    learned: [{ factIds: ['m-0001'] }],
    unresolved: [{ text: '面试结果' }],
    relationshipDelta: { tone: '更愿意先听' },
  })
  assert.match(reflection.id, /^r-\d{4}$/)
  assert.equal(reflection.whatHappened, '她说了工作上的挫败。')
  assert.equal(reflection.userState.label, '挫败')
})

test('intention 最多 3 条 active', () => {
  assert.ok(createIntention({ text: '问面试' }))
  assert.ok(createIntention({ text: '问她周末安排' }))
  assert.ok(createIntention({ text: '提醒她休息' }))
  assert.equal(createIntention({ text: '第四条' }), undefined)
  assert.equal(listIntentions('p-0001', 'active').length, 3)
})

test('intention 完成后不再出现在 active', () => {
  const intention = createIntention({ text: '问面试' })!
  assert.equal(completeIntention(intention.id), true)
  assert.equal(listIntentions('p-0001', 'active').length, 0)
})

test('快慢路由：闲聊快、情绪与记忆线索慢', () => {
  const state = getMindState()
  assert.equal(routeMessage('你好呀', state).slow, false)
  assert.equal(routeMessage('我今天真的很累，有点想哭', state).slow, true)
  assert.equal(routeMessage('你还记得我上次说的那件事吗', state).slow, true)
  assert.equal(routeMessage('我们是不是吵架了', state).slow, true)
})

test('关系状态：默认值、标签、边界', () => {
  const initial = getRelationshipSnapshot()
  assert.equal(initial.trust, 0.5)
  assert.equal(initial.familiarity, 0.3)
  assert.equal(initial.tension, 0.1)
  assert.equal(initial.labels.trust, '中')
  assert.equal(initial.labels.familiarity, '开始熟悉')
  assert.equal(initial.labels.tension, '平静')

  setRelationshipNumber('p-0001', 'trust', 2, 0, 1)
  assert.equal(getRelationshipSnapshot().trust, 1)
  bumpRelationshipNumber('p-0001', 'familiarity', 0.5, 0, 1)
  assert.equal(getRelationshipSnapshot().familiarity, 0.8)
})

test('情绪评估：负向感知会轻微影响心情', () => {
  const state = getMindState()
  const percept = perceiveMessage('我今天真的很累，有点想哭', state)
  const appraisal = appraiseTurn(percept, null)
  assert.equal(appraisal.label, '累')
  assert.ok(appraisal.needs.includes('被听见'))
  const blended = blendMindState(state, appraisal)
  assert.ok((blended.moodValence ?? 0) < 0)
  assert.ok((blended.attention ?? '').includes('累'))
})

test('到期意图每天只浮现一次', () => {
  const yesterday = new Date(Date.now() - 3_600_000).toISOString()
  const intention = createIntention({ text: '问她面试结果', dueAt: yesterday })!
  const now = new Date()
  assert.equal(listDueIntentions('p-0001', now).length, 1)
  assert.ok(claimIntentionSurface(intention.id, now))
  assert.equal(listDueIntentions('p-0001', now).length, 0)

  const tomorrow = new Date(now.getTime() + 86_400_000)
  assert.equal(listDueIntentions('p-0001', tomorrow).length, 1)
})
