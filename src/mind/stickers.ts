import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getSticker, listStickerPacks } from '../core/store.ts'
import { dice, tokenSet } from '../core/maintenance.ts'
import type { MessageAttachment, Sticker } from '../core/types.ts'

const MEDIA_PREFIX = '/media/stickers/'
const STICKER_MARKER = /\[\[sticker:([^\]]+)\]\]/g
const POKE_MARKER = /\[\[poke\]\]/g

export const MEDIA_ROOT = resolve(process.env.STICKER_DIR ?? 'data/media/stickers')

export interface StickerDesire {
  want: boolean
  reason?: string
  hint?: string
}

export function mediaUrl(file: string): string {
  return `${MEDIA_PREFIX}${file.split(/[\\/]/g).map(encodeURIComponent).join('/')}`
}

export function stickerToAttachment(sticker: Sticker): MessageAttachment {
  return {
    type: 'sticker',
    stickerId: sticker.id,
    name: sticker.name,
    file: mediaUrl(sticker.file),
    pack: sticker.packName,
    tags: sticker.tags,
  }
}

export function allStickers(): Sticker[] {
  return listStickerPacks().flatMap((pack) => pack.stickers)
}

function findStickerByRef(ref: string): Sticker | undefined {
  const trimmed = ref.trim()
  if (trimmed === '') return undefined
  const byId = getSticker(trimmed)
  if (byId !== undefined) return byId
  const lower = trimmed.toLowerCase()
  return allStickers().find(
    (sticker) =>
      sticker.name.toLowerCase() === lower ||
      sticker.name.toLowerCase().includes(lower) ||
      lower.includes(sticker.name.toLowerCase()) ||
      sticker.tags.some((tag) => tag.toLowerCase() === lower),
  )
}

export function resolveStickerRefs(refs: string[]): MessageAttachment[] {
  const out: MessageAttachment[] = []
  for (const ref of refs) {
    const sticker = findStickerByRef(ref)
    if (sticker !== undefined) out.push(stickerToAttachment(sticker))
  }
  return out
}

function describeSticker(attachment: MessageAttachment): string {
  const parts = [attachment.pack === undefined ? '' : `来自「${attachment.pack}」`]
  if (attachment.tags !== undefined && attachment.tags.length > 0) {
    parts.push(`标签 ${attachment.tags.join('/')}`)
  }
  const note = attachment.stickerId === undefined ? '' : getSticker(attachment.stickerId)?.note ?? ''
  if (note !== '') parts.push(`画面 ${note}`)
  const tail = parts.filter((part) => part !== '').join('；')
  return `「${attachment.name ?? '一张表情包'}」${tail === '' ? '' : `（${tail}）`}`
}

export function describeTurn(attachments: MessageAttachment[]): string {
  const parts: string[] = []
  if (attachments.some((attachment) => attachment.type === 'poke')) parts.push('【戳了戳你】')
  for (const attachment of attachments) {
    if (attachment.type === 'sticker') parts.push(`【表情包：${attachment.name ?? ''}】`)
  }
  return parts.join(' ')
}

export function describeAttachments(attachments: MessageAttachment[]): string {
  if (attachments.length === 0) return ''
  const lines = attachments.map((attachment) =>
    attachment.type === 'poke'
      ? '- 他戳了戳你（没有文字，只是一个动作）'
      : `- 他发来表情包${describeSticker(attachment)}`,
  )
  return `【他刚发的表情】\n${lines.join('\n')}`
}

export function describeInventory(): string {
  const stickers = allStickers()
  if (stickers.length === 0) return ''
  const detail = listStickerPacks()
    .filter((pack) => pack.stickers.length > 0)
    .map((pack) => `${pack.name} ${pack.stickers.length} 张`)
    .join('、')
  return `你存了 ${stickers.length} 张表情（${detail}），还有戳一戳这个动作。`
}

export function describeCapability(): string {
  const inventory = describeInventory()
  if (inventory === '') return ''
  return [
    '【你的手机里存着什么】',
    `- ${inventory}`,
    '- 想甩一张就在回复里单独写 [[sticker:名字或编号]]，想戳他就单独写 [[poke]]；不想发就不用发，也别用文字描述图片',
  ].join('\n')
}

export function pickCandidates(hint: string, limit = 5): Sticker[] {
  const stickers = allStickers()
  if (stickers.length === 0) return []
  const tokens = tokenSet(hint ?? '')
  if (tokens.size === 0) return stickers.slice(0, limit)
  return stickers
    .map((sticker) => ({
      sticker,
      score:
        dice(tokens, tokenSet(`${sticker.name} ${sticker.tags.join(' ')} ${sticker.note}`)) +
        (hint.trim() !== '' && sticker.name.includes(hint.trim()) ? 0.5 : 0),
    }))
    .filter((item) => item.score > 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.sticker)
}

export function describeDesire(desire: StickerDesire | null | undefined): string {
  if (desire === null || desire === undefined || !desire.want) return ''
  const hint = (desire.hint ?? '').trim()
  const reason = (desire.reason ?? '').trim()
  const picks = pickCandidates(hint)
  const lines = picks.map(
    (sticker) =>
      `- [[sticker:${sticker.id}]] ${sticker.name}` +
      `${sticker.tags.length > 0 ? `：${sticker.tags.join('/')}` : ''}` +
      `${sticker.note === '' ? '' : ` · ${sticker.note}`}`,
  )
  return [
    '【这一刻你想甩一张表情】',
    reason === '' ? '' : `原因：${reason}`,
    hint === '' ? '' : `你想要的画面：${hint}`,
    lines.length === 0 ? '库里没有对得上的，这次就正常说话。' : lines.join('\n'),
    '对不上就别说，别硬凑。',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export function parseMarkers(raw: string): { text: string; attachments: MessageAttachment[] } {
  const attachments: MessageAttachment[] = []
  const stickerIds: string[] = []
  for (const match of raw.matchAll(STICKER_MARKER)) stickerIds.push(match[1]!)
  attachments.push(...resolveStickerRefs(stickerIds))
  let text = raw.replace(STICKER_MARKER, '')
  if (POKE_MARKER.test(text)) {
    attachments.push({ type: 'poke' })
    text = text.replace(POKE_MARKER, '')
  }
  text = text
    .split('\n')
    .map((line) => line.replace(/\s{2,}/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
  return { text, attachments }
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function imageSize(path: string): { width: number; height: number } {
  const buffer = readFileSync(path)
  if (buffer.length > 24 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  const head = buffer.subarray(0, 4).toString('ascii')
  if (head === 'GIF8') return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  if (buffer.subarray(0, 2).toString('hex') === 'ffd8') {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break
      const marker = buffer[offset + 1]!
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      offset += 2 + buffer.readUInt16BE(offset + 2)
    }
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    const form = buffer.subarray(12, 16).toString('ascii')
    if (form === 'VP8X') {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
    }
    if (form === 'VP8L') {
      const bits = buffer.readUInt32LE(21)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
    }
    if (form === 'VP8 ') {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    }
  }
  return { width: 0, height: 0 }
}
