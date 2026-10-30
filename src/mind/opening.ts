import { completeChat, chatModel } from '../core/llm.ts'
import { buildBrief, buildSystemPrompt } from '../core/inject.ts'
import {
  addMessage,
  claimIntentionSurface,
  getSession,
  listDueIntentions,
  listMessages,
} from '../core/store.ts'
import type { Message } from '../core/types.ts'
import { splitBubbles } from './chat-format.ts'
import { markCuriosityAsked, pickCuriosity } from './curiosity.ts'

export interface OpeningResult {
  messages: Message[]
  kind: 'follow_up' | 'curiosity'
}

/**
 * 新会话由她先开口：优先问到期的事，其次问一个她还不知道的、关于用户的问题。
 * 没有可问的就不硬开，避免每开一个会话都像客服迎接。
 */
export async function generateOpening(sessionId: string): Promise<OpeningResult | null> {
  const session = getSession(sessionId)
  if (session === undefined) throw new Error('会话不存在')
  if (listMessages(sessionId, 1).length > 0) return null

  const followUp = listDueIntentions(session.personId)[0] ?? null
  const curiosity = followUp === null ? pickCuriosity(session.personId) : null
  if (followUp === null && curiosity === null) return null

  const brief = buildBrief(session.personId)
  const memoryBlock = `<companion-memory>\n${brief.text || '（暂无长期记忆）'}\n</companion-memory>`
  const extra = [
    '【主动开场】',
    '- 这是你主动发起的一次对话，不是回复用户。',
    '- 只发 1–2 条短消息，用 ||| 分隔；短、自然，不要客服腔。',
    '- 不要提“系统 / 记忆 / 意图 / 提醒 / follow-up”。',
    followUp !== null
      ? `- 你之前想问他：${followUp.text}`
      : `- 你想更了解他：${curiosity!.question}`,
    '- 最多问一个问题；如果对方更想聊别的，就把话题让出去。',
  ].join('\n')

  const full = await completeChat(
    [
      { role: 'system', content: buildSystemPrompt(memoryBlock, extra) },
      { role: 'user', content: '（新会话，还没有人说话。你先开口。）' },
    ],
    { model: chatModel(), temperature: 0.8 },
  )

  const bubbles = splitBubbles(full, 2)
  const messages = bubbles.map((text) => addMessage(sessionId, 'assistant', text, []))
  if (followUp !== null) claimIntentionSurface(followUp.id)
  if (curiosity !== null) markCuriosityAsked(session.personId, curiosity.key)

  return {
    messages,
    kind: followUp !== null ? 'follow_up' : 'curiosity',
  }
}
