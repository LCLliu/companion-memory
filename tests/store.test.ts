import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { resetDbForTests } from '../src/core/db.ts'
import {
  addMessage,
  closeOpenLoop,
  countUserMessages,
  createMemory,
  createOpenLoop,
  createSession,
  findExistingMemory,
  listOpenLoops,
  setMemoryStatus,
  stats,
} from '../src/core/store.ts'
import { retrieve } from '../src/core/retrieve.ts'
import { buildBrief, buildMemoryContext } from '../src/core/inject.ts'

beforeEach(() => {
  resetDbForTests(':memory:')
  process.env.RECALL_TOP_K = '3'
})

test('中文检索：偏好能被问题召回', () => {
  const memory = createMemory({ kind: 'preference', text: '我喜欢喝冰美式，不加糖' })
  const result = retrieve('p-0001', '我喜欢喝什么？')
  assert.equal(result.selected.length, 1)
  assert.equal(result.selected[0]!.id, memory.id)
  assert.ok(result.hits[0]!.final > 0)
})

test('归档后不再参与检索，恢复后回来', () => {
  const memory = createMemory({ kind: 'fact', text: '我的生日是三月十二日' })
  assert.equal(retrieve('p-0001', '生日是什么时候').selected.length, 1)

  setMemoryStatus(memory.id, 'archived')
  assert.equal(retrieve('p-0001', '生日是什么时候').selected.length, 0)

  setMemoryStatus(memory.id, 'active')
  assert.equal(retrieve('p-0001', '生日是什么时候').selected.length, 1)
})

test('置顶记忆与未完成事项进入会话简报', () => {
  createMemory({ kind: 'boundary', text: '不要主动提体重', pinned: true })
  createOpenLoop({ text: '下周交一份方案', kind: 'plan', dueAt: '2026-11-05' })
  const brief = buildBrief('p-0001')
  assert.match(brief.text, /不要主动提体重/)
  assert.match(brief.text, /下周交一份方案/)
  assert.equal(brief.pinned.length, 1)
  assert.equal(brief.openLoops.length, 1)
})

test('记忆块包含注入 id 和闭合标签', () => {
  const memory = createMemory({ kind: 'preference', text: '我喜欢喝冰美式' })
  const result = retrieve('p-0001', '冰美式')
  const block = buildMemoryContext(buildBrief('p-0001'), result.hits)
  assert.match(block.text, /<companion-memory>/)
  assert.match(block.text, new RegExp(memory.id))
  assert.deepEqual(block.injectedIds, [memory.id])
})

test('手动写入去重：包含关系算同一条', () => {
  const first = createMemory({ kind: 'fact', text: '我住在杭州，平时坐地铁上班' })
  const second = findExistingMemory('p-0001', '我住在杭州')
  assert.equal(second?.id, first.id)
})

test('会话与消息计数', () => {
  const session = createSession()
  addMessage(session.id, 'user', '你好')
  addMessage(session.id, 'assistant', '你好呀')
  addMessage(session.id, 'user', '今天有点累')
  assert.equal(countUserMessages(session.id), 2)
  const overview = stats()
  assert.equal(overview.sessions, 1)
  assert.equal(overview.messages, 3)
})

test('没有匹配时返回空结果，不抛错', () => {
  const result = retrieve('p-0001', '完全不存在的内容 xyz')
  assert.equal(result.selected.length, 0)
  assert.equal(result.mode, 'empty')
})

test('未完成事项关闭后不再出现在 open 列表', () => {
  const loop = createOpenLoop({ text: '帮他找一份资料', kind: 'promise' })
  assert.equal(listOpenLoops('p-0001', 'open').length, 1)
  assert.equal(closeOpenLoop(loop.id), true)
  assert.equal(listOpenLoops('p-0001', 'open').length, 0)
})
