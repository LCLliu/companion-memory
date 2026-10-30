import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { resetDbForTests } from '../src/core/db.ts'
import { createMemory } from '../src/core/store.ts'
import { splitBubbles } from '../src/mind/chat-format.ts'
import { markCuriosityAsked, pickCuriosity } from '../src/mind/curiosity.ts'

beforeEach(() => {
  resetDbForTests(':memory:')
})

test('splitBubbles：按 ||| 拆成多条短消息', () => {
  assert.deepEqual(splitBubbles('嗯。|||你呢？'), ['嗯。', '你呢？'])
  assert.deepEqual(splitBubbles('  A  |||  ||| B  '), ['A', 'B'])
  assert.deepEqual(splitBubbles('只有一条'), ['只有一条'])
  assert.deepEqual(splitBubbles('   '), [])
})

test('splitBubbles：超过上限时把剩余并进最后一条', () => {
  const result = splitBubbles('一|||二|||三|||四', 3)
  assert.equal(result.length, 3)
  assert.deepEqual(result, ['一', '二', '三 四'])
})

test('curiosity：先问未知话题，问过就不再重复', () => {
  assert.equal(pickCuriosity()?.key, 'name')
  markCuriosityAsked('p-0001', 'name')
  assert.equal(pickCuriosity()?.key, 'work')
  markCuriosityAsked('p-0001', 'work')
  assert.equal(pickCuriosity()?.key, 'city')
})

test('curiosity：记忆里已知的话题会跳过', () => {
  markCuriosityAsked('p-0001', 'name')
  markCuriosityAsked('p-0001', 'work')
  createMemory({ kind: 'fact', text: '我住在杭州，平时周末在家画画' })
  assert.equal(pickCuriosity(), null)
})
