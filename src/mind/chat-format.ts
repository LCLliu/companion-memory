/**
 * 把模型输出按 ||| 拆成短消息。
 * 不限制条数：她想发几条就发几条，空段会被丢掉。
 */
export function splitBubbles(raw: string): string[] {
  const parts = raw
    .split(/\s*\|\|\|\s*/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) return [raw.trim()].filter((part) => part !== '')
  return parts
}
