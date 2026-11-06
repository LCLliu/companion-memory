import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { completeChat } from '../src/core/llm.ts'

test('503 会自动重试直到成功', async () => {
  let attempts = 0
  const server = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      attempts += 1
      if (attempts === 1) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Service is too busy' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const oldBase = process.env.LLM_BASE_URL
  const oldKey = process.env.LLM_API_KEY
  const oldAttempts = process.env.LLM_RETRY_ATTEMPTS

  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`
  process.env.LLM_API_KEY = 'test'
  process.env.LLM_RETRY_ATTEMPTS = '2'

  try {
    const text = await completeChat([{ role: 'user', content: 'hi' }])
    assert.equal(text, 'ok')
    assert.equal(attempts, 2)
  } finally {
    server.close()
    if (oldBase === undefined) delete process.env.LLM_BASE_URL
    else process.env.LLM_BASE_URL = oldBase
    if (oldKey === undefined) delete process.env.LLM_API_KEY
    else process.env.LLM_API_KEY = oldKey
    if (oldAttempts === undefined) delete process.env.LLM_RETRY_ATTEMPTS
    else process.env.LLM_RETRY_ATTEMPTS = oldAttempts
  }
})
