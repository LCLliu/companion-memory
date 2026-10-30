import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { resetDbForTests } from '../src/core/db.ts'
import {
  createMemory,
  getRelationship,
  latestChapter,
} from '../src/core/store.ts'
import { chapterDue, saveChapter } from '../src/mind/chapter.ts'

beforeEach(() => {
  resetDbForTests(':memory:')
})

test('阶段摘要需要至少两段新事件', () => {
  createMemory({ kind: 'episode', text: '第一天聊了工作压力' })
  assert.equal(chapterDue(), null)
  createMemory({ kind: 'episode', text: '第二天聊了周末看展' })
  const due = chapterDue()
  assert.ok(due !== null)
  assert.equal(due!.episodes.length, 2)
})

test('saveChapter 写入 chapter 记忆和 current_chapter', () => {
  const a = createMemory({ kind: 'episode', text: '第一天聊了工作压力' })
  const b = createMemory({ kind: 'episode', text: '第二天聊了周末看展' })
  const result = saveChapter({
    chapter: '这段时间她工作压力大，周末去看了展。',
    selfNarrative: '我们最近更像是在互相报平安。',
    episodes: [a, b],
  })
  assert.equal(result.memory.kind, 'chapter')
  assert.equal(latestChapter()?.id, result.memory.id)
  assert.equal(
    getRelationship().find((entry) => entry.key === 'current_chapter')?.value,
    '我们最近更像是在互相报平安。',
  )
  assert.equal(chapterDue(), null)
})
