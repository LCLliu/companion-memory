import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPersonaBlock } from '../src/mind/persona.ts'
import { buildSystemPrompt } from '../src/core/inject.ts'

test('阶段化人设卡被加载并注入系统提示', () => {
  const persona = buildPersonaBlock()
  assert.match(persona, /<persona>/)
  assert.match(persona, /小满/)
  assert.match(persona, /越熟越甜/)
  assert.match(persona, /刚认识/)
  assert.match(persona, /她的日常/)
  assert.ok(persona.length < 4300)

  const system = buildSystemPrompt('<companion-memory>（暂无）</companion-memory>')
  assert.match(system, /<persona>/)
  assert.match(system, /小满/)
  assert.match(system, /默认少用句号/)
  assert.match(system, /用 \|\|\| 分隔/)
  assert.match(system, /companion-memory/)
})
