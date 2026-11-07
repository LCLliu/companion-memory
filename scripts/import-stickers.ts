import 'dotenv/config'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { z } from 'zod'
import { initDb } from '../src/core/db.ts'
import { addSticker, createStickerPack, findStickerBySha, findStickerPackByName } from '../src/core/store.ts'
import { completeChat } from '../src/core/llm.ts'
import { imageSize, MEDIA_ROOT, sha256File } from '../src/mind/stickers.ts'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const args = process.argv.slice(2)
const sourceDir = resolve(args.find((arg) => !arg.startsWith('--')) ?? 'data/media/stickers-in')
const forcePack = args.includes('--pack') ? args[args.indexOf('--pack') + 1] : undefined
const useVision = args.includes('--vision')

const VisionSchema = z.object({
  note: z.string().default(''),
  tags: z.array(z.string()).default([]),
})

function listImages(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
    .map((name) => join(dir, name))
    .sort((a, b) => a.localeCompare(b, 'zh'))
}

function subDirs(dir: string): string[] {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory() && listImages(path).length > 0
      } catch {
        return false
      }
    })
    .sort((a, b) => a.localeCompare(b, 'zh'))
}

function safeToken(value: string): string {
  return value.replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 24)
}

function tagsFromName(file: string): string[] {
  const stem = basename(file, extname(file))
  return stem
    .split(/[-_\s]+/g)
    .map((part) => part.trim())
    .filter((part) => part !== '' && !/^v?\d+$/i.test(part))
    .slice(0, 4)
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

async function describeWithVision(path: string, name: string): Promise<{ note: string; tags: string[] }> {
  const mime = MIME[extname(path).toLowerCase()] ?? 'image/jpeg'
  const dataUrl = `data:${mime};base64,${readFileSync(path).toString('base64')}`
  const raw = await completeChat(
    [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `这是要放进聊天表情库的一张图，名字叫「${name}」。只输出 JSON：{"note":"一句话说明画面里有什么","tags":["2到4个词，说情绪或动作"]}`,
          },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    { temperature: 0.2 },
  )
  const jsonStart = raw.indexOf('{')
  const jsonEnd = raw.lastIndexOf('}')
  if (jsonStart < 0 || jsonEnd < 0) return { note: '', tags: [] }
  const parsed = VisionSchema.safeParse(JSON.parse(raw.slice(jsonStart, jsonEnd + 1)))
  return parsed.success ? { note: parsed.data.note.trim(), tags: parsed.data.tags.map(safeToken).filter(Boolean) } : { note: '', tags: [] }
}

if (!existsSync(sourceDir)) {
  console.log(`没有这个目录：${sourceDir}`)
  console.log('把表情包放进去，或者先跑 pnpm make:stickers 生成一组占位图')
  process.exit(1)
}

initDb()
mkdirSync(MEDIA_ROOT, { recursive: true })

const groups: Array<{ pack: string; files: string[] }> = subDirs(sourceDir)
  .map((dir) => ({ pack: forcePack ?? basename(dir), files: listImages(dir) }))
  .concat(
    listImages(sourceDir).length > 0
      ? [{ pack: forcePack ?? (subDirs(sourceDir).length > 0 ? basename(sourceDir) : '默认包'), files: listImages(sourceDir) }]
      : [],
  )

let added = 0
let skipped = 0

for (const group of groups) {
  let pack = findStickerPackByName(group.pack)
  if (pack === undefined) {
    pack = createStickerPack(group.pack, sourceDir)
    console.log(`\n新建表情包：${group.pack}`)
  }
  for (const file of group.files) {
    const sha = sha256File(file)
    if (findStickerBySha(sha) !== undefined) {
      skipped += 1
      continue
    }
    const name = basename(file, extname(file))
    const target = `${safeToken(name) || 'sticker'}-${sha.slice(0, 8)}${extname(file).toLowerCase()}`
    mkdirSync(join(MEDIA_ROOT, safeToken(group.pack) || 'pack'), { recursive: true })
    copyFileSync(file, join(MEDIA_ROOT, safeToken(group.pack) || 'pack', target))
    const size = imageSize(file)
    let tags = tagsFromName(file)
    let note = ''
    if (useVision) {
      try {
        const described = await describeWithVision(file, name)
        note = described.note
        tags = [...new Set([...tags, ...described.tags])].slice(0, 6)
      } catch (error) {
        console.warn(`  视觉标注失败（${name}）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    addSticker({
      packId: pack.id,
      name,
      file: `${safeToken(group.pack) || 'pack'}/${target}`,
      tags,
      note,
      sha256: sha,
      bytes: statSync(file).size,
      width: size.width,
      height: size.height,
    })
    added += 1
    console.log(`  + ${name}  标签 ${tags.join('/') || '（无）'}${note === '' ? '' : `  画面：${note}`}`)
  }
}

console.log(`\n导入完成：新增 ${added} 张，跳过重复 ${skipped} 张`)
console.log(`图片目录：${MEDIA_ROOT}`)
