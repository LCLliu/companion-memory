import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SELF_PATH = fileURLToPath(new URL('../../persona/self.md', import.meta.url))
const VOICE_PATH = fileURLToPath(new URL('../../persona/voice.md', import.meta.url))
const MAX_CHARS = 2600

const FALLBACK = `你是小满，一个慢热、嘴硬心软的人。说话短，不装客服，不每轮提问，不编造共同经历。`

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * 人设是常量，每轮注入；lore / 记忆不在这里。
 * 文件缺失时退化到一句最小人设，不影响主流程。
 */
export function buildPersonaBlock(): string {
  const self = readText(SELF_PATH)
  const voice = readText(VOICE_PATH)
  const body = [self, voice].filter((part) => part !== '').join('\n\n')
  const text = body === '' ? FALLBACK : body
  const capped = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…（人设卡过长，已截断）` : text
  return `<persona>\n${capped}\n</persona>`
}
