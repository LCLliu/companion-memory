export interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmError'
  }
}

function baseUrl(): string {
  return (process.env.LLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '')
}

function apiKey(): string {
  return (process.env.LLM_API_KEY ?? '').trim()
}

export function isKeyConfigured(): boolean {
  return apiKey() !== ''
}

export function chatModel(): string {
  return process.env.LLM_CHAT_MODEL ?? 'glm-4.7-flash'
}

export function extractModel(): string {
  return process.env.LLM_EXTRACT_MODEL ?? 'glm-4.7-flash'
}

function timeoutMs(): number {
  return Number(process.env.LLM_TIMEOUT_MS ?? 60_000)
}

async function post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  if (!isKeyConfigured()) {
    throw new LlmError('未配置 LLM_API_KEY：请在 .env 中填入智谱 API Key')
  }
  const response = await fetch(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new LlmError(`模型接口返回 ${response.status}：${detail.slice(0, 300)}`)
  }
  return response
}

function parseDataLine(line: string): any | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return undefined
  const data = trimmed.slice(5).trim()
  if (data === '' || data === '[DONE]') return undefined
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

export async function streamChat(
  messages: ChatMsg[],
  onDelta: (text: string) => void,
  options: { model?: string; temperature?: number } = {},
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs())
  try {
    const response = await post(
      {
        model: options.model ?? chatModel(),
        messages,
        stream: true,
        temperature: options.temperature ?? 0.8,
      },
      controller.signal,
    )
    if (response.body === null) throw new LlmError('模型返回了空响应体')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() ?? ''
      for (const event of events) {
        for (const line of event.split(/\r?\n/)) {
          const json = parseDataLine(line)
          if (json === undefined) continue
          const delta = json?.choices?.[0]?.delta
          const text = typeof delta?.content === 'string' ? delta.content : ''
          if (text !== '') {
            full += text
            onDelta(text)
          }
        }
      }
    }

    if (full === '') throw new LlmError('模型没有返回内容（可能被限流或触发了内容策略）')
    return full
  } catch (error) {
    if (error instanceof LlmError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new LlmError(`模型请求超时（>${timeoutMs()}ms）`)
    }
    throw new LlmError(`模型请求失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

function stripJsonFence(raw: string): string {
  const fenced = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return fenced.trim()
  return fenced.slice(start, end + 1)
}

async function completeOnce(
  model: string,
  messages: ChatMsg[],
  temperature = 0.2,
): Promise<{ data: unknown; raw: string; model: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs())
  try {
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature,
      response_format: { type: 'json_object' },
    }
    let response: Response
    try {
      response = await post(body, controller.signal)
    } catch (error) {
      // 有些兼容接口不支持 response_format，去掉后重试一次
      if (error instanceof LlmError && /返回 400/.test(error.message)) {
        delete body.response_format
        response = await post(body, controller.signal)
      } else {
        throw error
      }
    }
    const json: any = await response.json()
    const raw = json?.choices?.[0]?.message?.content
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new LlmError('抽取模型没有返回 JSON 内容')
    }
    const cleaned = stripJsonFence(raw)
    let data: unknown
    try {
      data = JSON.parse(cleaned)
    } catch {
      throw new LlmError(`抽取结果不是合法 JSON：${cleaned.slice(0, 200)}`)
    }
    return { data, raw: cleaned, model }
  } catch (error) {
    if (error instanceof LlmError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new LlmError(`抽取请求超时（>${timeoutMs()}ms）`)
    }
    throw new LlmError(`抽取请求失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

export interface CompleteJsonOptions {
  model?: string
  fallback?: string
  temperature?: number
}

export async function completeJson(
  messages: ChatMsg[],
  options: CompleteJsonOptions = {},
): Promise<{ data: unknown; raw: string; model: string }> {
  const primary = options.model ?? extractModel()
  const fallback = options.fallback ?? process.env.LLM_EXTRACT_FALLBACK ?? ''
  const models = [primary, fallback].filter((model): model is string => model.trim() !== '')
  let lastError: unknown
  for (const model of models) {
    try {
      return await completeOnce(model, messages, options.temperature ?? 0.2)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new LlmError('抽取失败')
}

export function mindModel(): string {
  return process.env.MIND_MODEL ?? chatModel()
}

export function mindMode(): 'off' | 'shadow' | 'on' {
  const raw = (process.env.MIND_MODE ?? 'shadow').trim().toLowerCase()
  return raw === 'on' || raw === 'off' ? raw : 'shadow'
}
