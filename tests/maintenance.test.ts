import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { resetDbForTests } from '../src/core/db.ts'
import {
  createMemory,
  getMemory,
  listContradictions,
  listEdges,
  neighborsOf,
} from '../src/core/store.ts'
import { runMaintenance } from '../src/core/maintenance.ts'
import { retrieve } from '../src/core/retrieve.ts'

beforeEach(() => {
  resetDbForTests(':memory:')
})

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

test('维护会归档老 episode，但不动 pinned 和 fact', () => {
  const oldEpisode = createMemory({
    kind: 'episode',
    text: '很久以前的一次闲聊',
    createdAt: daysAgo(60),
    occurredAt: daysAgo(60),
  })
  const pinnedEpisode = createMemory({
    kind: 'episode',
    text: '第一次见面',
    createdAt: daysAgo(60),
    occurredAt: daysAgo(60),
    pinned: true,
  })
  const oldFact = createMemory({
    kind: 'fact',
    text: '用户住在杭州',
    createdAt: daysAgo(60),
  })

  const run = runMaintenance({ trigger: 'test' })
  assert.equal(run.archived, 1)
  assert.equal(getMemory(oldEpisode.id)!.status, 'archived')
  assert.equal(getMemory(pinnedEpisode.id)!.status, 'active')
  assert.equal(getMemory(oldFact.id)!.status, 'active')
})

test('维护会建立 1 跳联想边', () => {
  const a = createMemory({ kind: 'fact', text: '团子喜欢趴在键盘上' })
  const b = createMemory({ kind: 'fact', text: '团子今天又趴在键盘上睡觉' })
  runMaintenance({ trigger: 'test' })

  const edges = listEdges()
  assert.ok(edges.length >= 1)
  const neighbors = neighborsOf(a.id).map((item) => item.memory.id)
  assert.ok(neighbors.includes(b.id))

  const result = retrieve('p-0001', '团子喜欢')
  assert.ok(result.hits.some((hit) => hit.memory.id === a.id))
  assert.ok(result.hits.some((hit) => hit.memory.id === b.id))
})

test('维护会检测极性矛盾的相似记忆', () => {
  const a = createMemory({ kind: 'preference', text: '我喜欢喝咖啡' })
  const b = createMemory({ kind: 'preference', text: '我不喜欢喝咖啡' })
  const run = runMaintenance({ trigger: 'test' })
  assert.ok(run.contradictions >= 1)
  const pending = listContradictions()
  assert.equal(pending.length, 1)
  assert.ok([pending[0]!.aMemoryId, pending[0]!.bMemoryId].includes(a.id))
  assert.ok([pending[0]!.aMemoryId, pending[0]!.bMemoryId].includes(b.id))
})

test('维护幂等：第二轮不重复归档/加矛盾', () => {
  createMemory({ kind: 'preference', text: '我喜欢喝咖啡' })
  createMemory({ kind: 'preference', text: '我不喜欢喝咖啡' })
  const first = runMaintenance({ trigger: 'test' })
  const second = runMaintenance({ trigger: 'test' })
  assert.equal(second.archived, 0)
  assert.equal(second.contradictions, 0)
  assert.equal(second.edges, first.edges)
})
