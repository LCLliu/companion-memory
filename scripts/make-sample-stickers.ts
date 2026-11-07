import 'dotenv/config'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 生成一组纯程序画的占位表情，用来验收导入与收发链路；不是真表情包。

const SIZE = 160

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(pixels: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 3))
  for (let y = 0; y < SIZE; y += 1) {
    pixels.copy(raw, y * (1 + SIZE * 3) + 1, y * SIZE * 3, (y + 1) * SIZE * 3)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

type Face = { bg: [number, number, number]; mouth: 'flat' | 'smile' | 'open' | 'wave' | 'sleep' | 'heart' }

function draw(face: Face): Buffer {
  const pixels = Buffer.alloc(SIZE * SIZE * 3)
  const put = (x: number, y: number, color: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
    const at = (y * SIZE + x) * 3
    pixels[at] = color[0]
    pixels[at + 1] = color[1]
    pixels[at + 2] = color[2]
  }
  const disc = (cx: number, cy: number, r: number, color: [number, number, number]) => {
    for (let y = cy - r; y <= cy + r; y += 1) {
      for (let x = cx - r; x <= cx + r; x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) put(x, y, color)
      }
    }
  }

  for (let i = 0; i < SIZE * SIZE; i += 1) {
    pixels[i * 3] = face.bg[0]
    pixels[i * 3 + 1] = face.bg[1]
    pixels[i * 3 + 2] = face.bg[2]
  }

  const body: [number, number, number] = [245, 245, 240]
  const ink: [number, number, number] = [30, 32, 40]
  disc(80, 92, 46, body)
  disc(52, 56, 14, body)
  disc(108, 56, 14, body)
  disc(66, 86, 6, ink)
  disc(94, 86, 6, ink)

  if (face.mouth === 'flat') for (let x = 70; x <= 90; x += 1) put(x, 108, ink)
  if (face.mouth === 'smile') {
    for (let x = 66; x <= 94; x += 1) put(x, 104 + Math.round(Math.sin(((x - 66) / 28) * Math.PI) * 6), ink)
  }
  if (face.mouth === 'open') disc(80, 110, 9, ink)
  if (face.mouth === 'wave') {
    for (let x = 64; x <= 96; x += 1) put(x, 104 + Math.round(Math.sin((x / 5) * Math.PI) * 4), ink)
  }
  if (face.mouth === 'sleep') {
    for (const x of [62, 66, 70, 90, 94, 98]) put(x, 86, ink)
    disc(80, 110, 5, face.bg)
  }
  if (face.mouth === 'heart') {
    for (let y = 98; y <= 118; y += 1) {
      for (let x = 66; x <= 94; x += 1) {
        const dx = (x - 80) / 14
        const dy = (y - 108) / 12
        if ((dx * dx + dy * dy - 1) ** 3 - dx * dx * dy ** 3 <= 0) put(x, y, [232, 82, 120])
      }
    }
  }
  return pixels
}

const faces: Array<{ name: string; face: Face }> = [
  { name: '躺平', face: { bg: [96, 118, 160], mouth: 'flat' } },
  { name: '开心', face: { bg: [240, 190, 90], mouth: 'smile' } },
  { name: '啊？', face: { bg: [170, 100, 150], mouth: 'open' } },
  { name: '晕了', face: { bg: [110, 170, 150], mouth: 'wave' } },
  { name: '睡了', face: { bg: [80, 90, 130], mouth: 'sleep' } },
  { name: '比心', face: { bg: [235, 150, 160], mouth: 'heart' } },
]

const outDir = resolve(process.argv[2] ?? 'data/media/stickers-in/占位包')
mkdirSync(outDir, { recursive: true })
for (const item of faces) {
  const png = encodePng(draw(item.face))
  const path = `${outDir}/${item.name}.png`
  writeFileSync(path, png)
  console.log('生成', path, createHash('sha256').update(png).digest('hex').slice(0, 12))
}
console.log('下一步：pnpm import:stickers', resolve(outDir))
