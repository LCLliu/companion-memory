import { useEffect, useState } from 'react'
import type { MessageAttachment, StickerPack } from '../core/types.ts'
import { get } from './api.ts'

export function visibleText(content: string): string {
  return content.replace(/【(?:表情包：[^】]*|戳了戳你)】/g, '').trim()
}

export function AttachmentView({ attachments }: { attachments: MessageAttachment[] }) {
  if (attachments.length === 0) return null
  return (
    <div className="attachments">
      {attachments.map((attachment, index) =>
        attachment.type === 'poke' ? (
          <span className="poke" key={`${attachment.type}-${index}`}>
            戳了戳对方
          </span>
        ) : (
          <img
            className="sticker"
            key={`${attachment.stickerId}-${index}`}
            src={attachment.file}
            alt={attachment.name ?? '表情包'}
            title={[attachment.pack, ...(attachment.tags ?? [])].filter(Boolean).join(' · ')}
            draggable={false}
          />
        ),
      )}
    </div>
  )
}

export function StickerPanel({
  onSticker,
  onPoke,
  onClose,
}: {
  onSticker: (attachment: MessageAttachment) => void
  onPoke: () => void
  onClose: () => void
}) {
  const [packs, setPacks] = useState<StickerPack[]>([])
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    get<{ packs: StickerPack[] }>('/api/stickers')
      .then((result) => {
        if (!cancelled) setPacks(result.packs.filter((pack) => pack.stickers.length > 0))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const pack = packs[Math.min(active, packs.length - 1)]

  return (
    <div className="sticker-panel">
      {error !== null && <p className="sticker-empty">{error}</p>}
      {error === null && packs.length === 0 && (
        <p className="sticker-empty">
          还没有表情库。把图片放进 <code>data/media/stickers/包名/</code>，再跑 <code>pnpm import:stickers</code>。
        </p>
      )}
      {packs.length > 0 && (
        <>
          <div className="sticker-tabs">
            {packs.map((item, index) => (
              <button
                type="button"
                key={item.id}
                className={index === active ? 'active' : ''}
                onClick={() => setActive(index)}
              >
                {item.name}
              </button>
            ))}
          </div>
          <div className="sticker-grid">
            {(pack?.stickers ?? []).map((sticker) => (
              <button
                type="button"
                className="sticker-cell"
                key={sticker.id}
                title={[sticker.name, ...sticker.tags].join(' · ')}
                onClick={() => {
                  onSticker({
                    type: 'sticker',
                    stickerId: sticker.id,
                    name: sticker.name,
                    file: sticker.url,
                    pack: pack?.name,
                    tags: sticker.tags,
                  })
                }}
              >
                <img src={sticker.url} alt={sticker.name} draggable={false} />
              </button>
            ))}
          </div>
        </>
      )}
      <div className="sticker-foot">
        <button type="button" className="ghost" onClick={onPoke}>
          戳一戳
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          收起
        </button>
      </div>
    </div>
  )
}
