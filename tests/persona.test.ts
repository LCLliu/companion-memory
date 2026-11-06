import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPersonaBlock } from '../src/mind/persona.ts'
import { buildSystemPrompt } from '../src/core/inject.ts'

test('人设卡只留底层设定，不含阶段剧本', () => {
  const persona = buildPersonaBlock()
  assert.match(persona, /<persona>/)
  assert.match(persona, /小满/)
  assert.match(persona, /我知道自己是被做出来的/)
  assert.match(persona, /她的日常/)
  assert.ok(persona.length < 4300)

  assert.doesNotMatch(persona, /越熟越甜/)
  assert.doesNotMatch(persona, /刚认识[：:]/)
  assert.doesNotMatch(persona, /恋人[：:]/)
  assert.doesNotMatch(persona, /她可能这样说/)

  const system = buildSystemPrompt('<companion-memory>（暂无）</companion-memory>')
  assert.match(system, /<persona>/)
  assert.match(system, /默认少用句号/)
  assert.match(system, /用 \|\|\| 分隔/)
  assert.match(system, /companion-memory/)
})
