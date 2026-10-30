import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPersonaBlock } from '../src/mind/persona.ts'
import { buildSystemPrompt } from '../src/core/inject.ts'

test('人设卡被加载并注入系统提示', () => {
  const persona = buildPersonaBlock()
  assert.match(persona, /<persona>/)
  assert.match(persona, /小满/)
  assert.match(persona, /记下了/)

  const system = buildSystemPrompt('<companion-memory>（暂无）</companion-memory>')
  assert.match(system, /<persona>/)
  assert.match(system, /小满/)
  assert.match(system, /companion-memory/)
})
