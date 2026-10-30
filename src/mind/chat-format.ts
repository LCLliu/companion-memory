/**
 * 把一条模型输出拆成人味的 1–3 条短消息。
 * 约定模型用 ||| 分隔；没有分隔符时保持一条，避免为了凑数硬拆。
 */
export function splitBubbles(raw: string, max = 3): string[] {
  const parts = raw
    .split(/\s*\|\|\|\s*/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) return [raw.trim()].filter((part) => part !== '')
  if (parts.length <= max) return parts
  return [...parts.slice(0, max - 1), parts.slice(max - 1).join(' ')]
}
