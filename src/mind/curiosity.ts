import {
  getRelationship,
  listMemories,
  listRecentMessagesForPerson,
  upsertRelationship,
} from '../core/store.ts'

interface Topic {
  key: string
  question: string
  known: RegExp
}

const TOPICS: readonly Topic[] = [
  { key: 'name', question: '你希望我怎么称呼你？', known: /(叫我|称呼|名字|我叫)/ },
  { key: 'work', question: '你平时在忙什么？', known: /(工作|上班|职业|在做|项目)/ },
  { key: 'city', question: '你平时在哪个城市？', known: /(住在|城市|哪个区)/ },
  { key: 'weekend', question: '你周末一般怎么过？', known: /(周末|休息日|空闲)/ },
]

function askedKeys(personId: string): Set<string> {
  const raw = getRelationship(personId).find((entry) => entry.key === 'curiosity_asked')?.value ?? ''
  return new Set(raw.split(',').map((key) => key.trim()).filter((key) => key !== ''))
}

export function pickCuriosity(personId = 'p-0001'): { key: string; question: string } | null {
  const asked = askedKeys(personId)
  const texts = [
    ...listRecentMessagesForPerson(personId, 80).map((message) => message.content),
    ...listMemories({ personId, status: 'active', limit: 200 }).map((memory) => memory.text),
  ].join('\n')

  for (const topic of TOPICS) {
    if (asked.has(topic.key)) continue
    if (topic.known.test(texts)) continue
    return { key: topic.key, question: topic.question }
  }
  return null
}

export function markCuriosityAsked(personId: string, key: string): void {
  const asked = askedKeys(personId)
  asked.add(key)
  upsertRelationship(personId, 'curiosity_asked', [...asked].join(','))
}
