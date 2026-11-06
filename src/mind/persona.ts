import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SELF_PATH = fileURLToPath(new URL('../../persona/self.md', import.meta.url))
const VOICE_PATH = fileURLToPath(new URL('../../persona/voice.md', import.meta.url))
const LIFE_PATH = fileURLToPath(new URL('../../persona/life.md', import.meta.url))
const MAX_CHARS = 4200

const FALLBACK = `你是小满。像手机聊天，默认少用句号。不安会说出来，也会自己缓一缓。`

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
  const life = readText(LIFE_PATH)
  const body = [self, voice, life].filter((part) => part !== '').join('\n\n')
  const text = body === '' ? FALLBACK : body
  const capped = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…（人设卡过长，已截断）` : text
  return `<persona>\n${capped}\n</persona>`
}
