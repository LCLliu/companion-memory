import { getRelationship, getRelationshipSnapshot, listMemories, listOpenLoops } from './store.ts'
import type { Memory, RecallHit, SessionBrief } from './types.ts'

const RELATION_LABELS: Record<string, string> = {
  nickname: '称呼',
  tone: '最近基调',
  boundaries: '边界',
  rituals: '共同习惯',
  current_chapter: '当前章节',
  trust_notes: '关系备注',
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function dateOf(memory: Memory): string {
  return (memory.occurredAt ?? memory.createdAt).slice(0, 10)
}

export function buildBrief(personId: string): SessionBrief {
  const relationship = getRelationship(personId)
  const relationshipSnapshot = getRelationshipSnapshot(personId)
  const openLoops = listOpenLoops(personId, 'open', 5)
  const episodes = listMemories({
    personId,
    kind: 'episode',
    status: 'active',
    limit: 3,
    orderBy: 'occurred_at',
  })
  const pinned = listMemories({
    personId,
    status: 'active',
    pinned: true,
    limit: 5,
    orderBy: 'salience',
  })

  const lines: string[] = []
  lines.push('【关系状态】')
  lines.push(
    `- 信任：${relationshipSnapshot.labels.trust} · 熟悉：${relationshipSnapshot.labels.familiarity} · ` +
      `张力：${relationshipSnapshot.labels.tension} · 最近感觉：${relationshipSnapshot.labels.recentMood}`,
  )
  const descriptive = relationship.filter(
    (entry) => !['trust', 'familiarity', 'tension', 'recent_mood'].includes(entry.key),
  )
  if (descriptive.length > 0) {
    lines.push('【关系备注】')
    for (const entry of descriptive) {
      lines.push(`- ${RELATION_LABELS[entry.key] ?? entry.key}：${truncate(entry.value, 100)}`)
    }
  }
  if (openLoops.length > 0) {
    lines.push('【未完成】')
    for (const loop of openLoops) {
      lines.push(`- [${loop.id}] ${truncate(loop.text, 100)}${loop.dueAt ? `（${loop.dueAt.slice(0, 10)}）` : ''}`)
    }
  }
  if (episodes.length > 0) {
    lines.push('【最近事件】')
    for (const episode of episodes) {
      lines.push(`- ${dateOf(episode)} [${episode.id}] ${truncate(episode.text, 120)}`)
    }
  }
  if (pinned.length > 0) {
    lines.push('【置顶】')
    for (const memory of pinned) {
      lines.push(`- [${memory.id}] ${truncate(memory.text, 100)}`)
    }
  }

  return {
    relationship,
    openLoops,
    episodes,
    pinned,
    text: lines.join('\n'),
  }
}

export function buildMemoryContext(brief: SessionBrief, hits: RecallHit[]): {
  text: string
  injectedIds: string[]
} {
  // 简报里已经出现的记忆（置顶 / 最近事件）不再重复进“相关记忆”，
  // 否则同一个 id 会在同一块里出现两次，白花 token。
  const briefIds = new Set([...brief.pinned, ...brief.episodes].map((memory) => memory.id))
  const relevant = hits.filter((hit) => !briefIds.has(hit.memory.id))

  const lines: string[] = []
  if (brief.text !== '') lines.push(brief.text)
  if (relevant.length > 0) {
    lines.push('【可能相关的记忆】')
    for (const hit of relevant) {
      const { memory } = hit
      lines.push(`- [${memory.id}] (${memory.kind} · ${dateOf(memory)}) ${truncate(memory.text, 120)}`)
    }
  }
  const body = lines.length > 0 ? lines.join('\n') : '（暂无长期记忆）'
  const cap = Math.max(400, Number(process.env.MEMORY_BLOCK_MAX_CHARS ?? 1600))
  const capped = body.length > cap ? `${body.slice(0, cap)}…` : body
  return {
    text: `<companion-memory>\n${capped}\n</companion-memory>`,
    injectedIds: relevant.map((hit) => hit.memory.id),
  }
}

export const SYSTEM_RULES = `你是一个长期陪伴用户的 AI 对话伙伴。
你会看到一段 <companion-memory> 记忆，它可能不完整、过时或与当前语境无关。

规则：
1. 只把 <companion-memory> 里出现的内容当作长期记忆；没有出现的事，不要声称“我记得”。
2. 不确定时直接说“我记不太清了”，不要编造共同经历、时间或细节。
3. 语气自然、简洁，像长期相处的朋友；不要复述整个记忆列表，只在相关时自然提起。
4. 不要提“系统 / 数据库 / 注入 / 检索 / token”等实现细节。
5. 如果记忆和用户当前说法冲突，以用户当前说法为准，并可以轻轻确认一次。`

export function buildSystemPrompt(memoryBlock: string): string {
  return `${SYSTEM_RULES}\n\n${memoryBlock}`
}
