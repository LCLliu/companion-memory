import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resetDbForTests } from '../src/core/db.ts'
import { addSticker, createStickerPack, findStickerBySha, getSticker } from '../src/core/store.ts'
import { splitBubbles } from '../src/mind/chat-format.ts'
import {
  resolveStickerRefs,
  describeAttachments,
  describeCapability,
  describeDesire,
  describeInventory,
  describeTurn,
  mediaUrl,
  parseMarkers,
} from '../src/mind/stickers.ts'

resetDbForTests(':memory:')

const pack = createStickerPack('测试包', 'data/media/stickers-in')
const sticker = addSticker({
  packId: pack.id,
  name: '躺平',
  file: '测试包/tangping-abcd1234.png',
  tags: ['累', '不想动'],
  note: '一只白色团子摊在地上',
  sha256: 'sha-tangping',
})
addSticker({
  packId: pack.id,
  name: '开心',
  file: '测试包/kaixin-99887766.png',
  tags: ['开心', '笑'],
  note: '一只白色团子举着双手跳起来',
  sha256: 'sha-kaixin',
})

test('她输出的表情标记被拆成附件，文字里不留痕迹', () => {
  const bubbles = splitBubbles(`我也刚改完|||[[sticker:${sticker.id}]] 就是这个`).map((bubble) => parseMarkers(bubble))
  assert.deepEqual(bubbles.map((item) => item.text), ['我也刚改完', '就是这个'])
  assert.equal(bubbles[0]!.attachments.length, 0)
  assert.equal(bubbles[1]!.attachments.length, 1)
  assert.equal(bubbles[1]!.attachments[0]?.stickerId, sticker.id)
  assert.equal(
    bubbles[1]!.attachments[0]?.file,
    '/media/stickers/%E6%B5%8B%E8%AF%95%E5%8C%85/tangping-abcd1234.png',
  )
})

test('不存在的编号和戳一戳', () => {
  assert.deepEqual(resolveStickerRefs(['st-nope']), [])
  const parsed = parseMarkers('[[poke]]')
  assert.equal(parsed.text, '')
  assert.deepEqual(parsed.attachments, [{ type: 'poke' }])
})

test('他发来的表情被写成她能读懂的一句话', () => {
  const attachment = resolveStickerRefs([sticker.id])[0]!
  const text = describeAttachments([attachment])
  assert.match(text, /【他刚发的表情】/)
  assert.match(text, /他发来表情包「躺平」/)
  assert.match(text, /标签 累\/不想动/)
  assert.match(text, /画面 一只白色团子摊在地上/)
  assert.equal(describeAttachments([]), '')
  assert.match(describeTurn([attachment]), /【表情包：躺平】/)
  assert.match(describeAttachments([{ type: 'poke' }]), /他戳了戳你/)
})

test('库存只报数量，不把编号摆在她眼前', () => {
  const inventory = describeInventory()
  assert.match(inventory, /你存了 2 张表情/)
  assert.doesNotMatch(inventory, /\[\[sticker:/)
  assert.match(describeCapability(), /想甩一张就在回复里单独写/)
})

test('不想发就没有任何候选', () => {
  assert.equal(describeDesire(null), '')
  assert.equal(describeDesire({ want: false }), '')
})

test('想发的时候才拿到对得上的那几张', () => {
  const block = describeDesire({ want: true, reason: '他说累，我想让他笑一下', hint: '瘫在地上不想动' })
  assert.match(block, /【这一刻你想甩一张表情】/)
  assert.match(block, /原因：他说累/)
  assert.match(block, new RegExp(`\\[\\[sticker:${sticker.id}\\]\\] 躺平`))
  assert.doesNotMatch(block, /开心/)
})

test('她只记得名字时也发得出去', () => {
  const resolved = resolveStickerRefs(['躺平'])
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0]?.stickerId, sticker.id)
  assert.equal(parseMarkers('[[sticker:躺平]]').attachments.length, 1)
})

test('按文件哈希找回同一张表情', () => {
  assert.equal(getSticker(sticker.id)?.name, '躺平')
  assert.equal(findStickerBySha('sha-tangping')?.id, sticker.id)
  assert.equal(findStickerBySha(''), undefined)
  assert.equal(mediaUrl('a/b.png'), '/media/stickers/a/b.png')
})
