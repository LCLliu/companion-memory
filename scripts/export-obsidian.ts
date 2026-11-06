import 'dotenv/config'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDb } from '../src/core/db.ts'
import {
  getMindState,
  getRelationshipSnapshot,
  lastMaintenance,
  latestChapter,
  listContradictions,
  listEdges,
  listIntentions,
  listMemories,
  listMessages,
  listReflections,
  listSessions,
  listSourceMessages,
  listThoughts,
} from '../src/core/store.ts'
import type { Memory } from '../src/core/types.ts'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const vaultRoot = process.env.OBSIDIAN_VAULT_PATH ?? 'D:/ObsidianNotes'
const exportRoot = join(vaultRoot, 'CompanionMemory')
const scope = (process.env.OBSIDIAN_EXPORT_SCOPE ?? 'graph').toLowerCase()
const fullExport = scope === 'full'
const personId = 'p-0001'

const KIND_LABEL: Record<string, string> = {
  episode: '事件',
  fact: '事实',
  preference: '偏好',
  boundary: '边界',
  promise: '承诺',
  chapter: '阶段',
  relationship: '关系',
  self_fact: '她自己',
}

const GENERATED_DIRS = [
  '10-记忆',
  '20-关系',
  '30-反思',
  '40-意图',
  '50-联想',
  '60-人设',
  '70-想法',
  '80-矛盾',
  '85-维护',
  '90-会话',
]

initDb()

mkdirSync(exportRoot, { recursive: true })
for (const dir of GENERATED_DIRS) {
  try {
    rmSync(join(exportRoot, dir), { recursive: true, force: true })
  } catch {
    // Obsidian 有时会短暂占用文件；清不掉就先覆盖写入。
  }
}
for (const file of ['00-记忆首页.md', '95-时间线.md', '图谱说明.md']) {
  try {
    rmSync(join(exportRoot, file), { force: true })
  } catch {
    // 同上，清不掉就覆盖。
  }
}

const memories = listMemories({ personId, status: 'all', limit: 500 })
const sessions = listSessions(personId, 500)
const reflections = listReflections(personId, 500)
const intentions = listIntentions(personId, 'all', 500)
const edges = listEdges(personId, 5000)
const contradictions = listContradictions(personId, 'all', 500)
const thoughts = listThoughts(personId, 500)
const relationship = getRelationshipSnapshot(personId)
const mind = getMindState(personId)
const chapter = latestChapter(personId)
const maintenance = lastMaintenance(personId)

const usedMemoryNames = new Set<string>()
const usedSessionNames = new Set<string>()
const usedReflectionNames = new Set<string>()
const usedIntentionNames = new Set<string>()
const usedThoughtNames = new Set<string>()

const memoryFileById = new Map<string, string>()
for (const memory of memories) {
  const base = makeFileName(shortDate(memory.createdAt), titleFromText(memory.text, KIND_LABEL[memory.kind] ?? memory.kind))
  memoryFileById.set(memory.id, uniqueFileName(base, usedMemoryNames))
}

const edgesByMemory = new Map<string, string[]>()
for (const edge of edges) {
  const srcName = memoryFileById.get(edge.srcMemoryId) ?? edge.srcMemoryId
  const dstName = memoryFileById.get(edge.dstMemoryId) ?? edge.dstMemoryId
  const forward = `- [[${dstName}]] · ${edge.relation} · weight ${edge.weight.toFixed(2)}`
  const backward = `- [[${srcName}]] · ${edge.relation} · weight ${edge.weight.toFixed(2)}`
  edgesByMemory.set(edge.srcMemoryId, [...(edgesByMemory.get(edge.srcMemoryId) ?? []), forward])
  edgesByMemory.set(edge.dstMemoryId, [...(edgesByMemory.get(edge.dstMemoryId) ?? []), backward])
}

function write(relativePath: string, content: string): void {
  const path = join(exportRoot, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`, 'utf8')
}

function writeFull(relativePath: string, content: string): void {
  if (fullExport) write(relativePath, content)
}

function yamlValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(String(value))
}

function yamlArray(values: unknown[]): string {
  return `[${values.map(yamlValue).join(', ')}]`
}

function frontmatter(fields: Record<string, unknown>): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${Array.isArray(value) ? yamlArray(value) : yamlValue(value)}`)
  }
  lines.push('---')
  return lines.join('\n')
}

function shortDate(value: string | null | undefined): string {
  if (!value) return ''
  return value.slice(0, 10)
}

function titleFromText(text: string, fallback = '未命名'): string {
  const first = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/[。！？!?；;]/)[0]
    .trim()
  const withoutUser = first.replace(/^用户(?:的)?(?:说|提到|希望|喜欢|想要|需要)?\s*/, '').trim()
  const title = withoutUser || first || fallback
  return title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').replace(/\s+/g, ' ').slice(0, 34)
}

function makeFileName(date: string, title: string): string {
  const safeTitle = title || '未命名'
  return `${date || '未知日期'} ${safeTitle}`.trim()
}

function uniqueFileName(base: string, used: Set<string>): string {
  let name = base
  let index = 2
  while (used.has(name)) {
    name = `${base} ${index}`
    index += 1
  }
  used.add(name)
  return name
}

function memoryTags(memory: Memory): string[] {
  const tags = ['memory', memory.kind, memory.status]
  if (memory.pinned) tags.push('pinned')
  return tags
}

function memoryMarkdown(memory: Memory): string {
  const sourceMessages = listSourceMessages(memory.sourceMessageIds)
  const links = edgesByMemory.get(memory.id) ?? []
  const sourceLines = memory.sourceSessionId
    ? [`- 来源会话：${memory.sourceSessionId}`]
    : ['- 手动写入']
  if (sourceMessages.length > 0) {
    sourceLines.push(`- 消息 ${sourceMessages.map((message) => `#${message.id}`).join(', ')}`)
  }

  return [
    frontmatter({
      type: 'memory',
      id: memory.id,
      kind: memory.kind,
      status: memory.status,
      text: memory.text,
      created_at: memory.createdAt,
      occurred_at: memory.occurredAt,
      salience: Number(memory.salience.toFixed(4)),
      confidence: Number(memory.confidence.toFixed(4)),
      pinned: memory.pinned,
      source_session: memory.sourceSessionId,
      tags: memoryTags(memory),
    }),
    '',
    `# ${titleFromText(memory.text, KIND_LABEL[memory.kind] ?? memory.kind)}`,
    '',
    `类型：${KIND_LABEL[memory.kind] ?? memory.kind} · ID：${memory.id}`,
    '',
    memory.text,
    '',
    '## 来源',
    ...sourceLines,
    '',
    ...(links.length > 0 ? ['## 联想', ...links, ''] : []),
  ].join('\n')
}

for (const memory of memories) {
  const fileName = memoryFileById.get(memory.id) ?? memory.id
  write(`10-记忆/${fileName}.md`, memoryMarkdown(memory))
}

for (const session of sessions) {
  const messages = listMessages(session.id, 2000)
  const sessionTitle = titleFromText(session.title, '会话')
  const fileName = uniqueFileName(
    makeFileName(shortDate(session.startedAt), `会话 ${sessionTitle}`),
    usedSessionNames,
  )
  writeFull(
    `90-会话/${fileName}.md`,
    [
      frontmatter({
        type: 'session',
        id: session.id,
        title: session.title,
        status: session.status,
        started_at: session.startedAt,
        ended_at: session.endedAt,
        tags: ['session', session.status],
      }),
      '',
      `# ${sessionTitle}`,
      '',
      `会话 ID：${session.id}`,
      '',
      `开始：${session.startedAt}`,
      '',
      '## 消息',
      '',
      ...messages.map((message) => `- **${message.role}** · ${message.createdAt} · ${message.content}`),
    ].join('\n'),
  )
}

for (const reflection of reflections) {
  const reflectionTitle = titleFromText(reflection.whatHappened, '关系复盘')
  const fileName = uniqueFileName(
    makeFileName(shortDate(reflection.createdAt), `反思 ${reflectionTitle}`),
    usedReflectionNames,
  )
  writeFull(
    `30-反思/${fileName}.md`,
    [
      frontmatter({
        type: 'reflection',
        id: reflection.id,
        session_id: reflection.sessionId,
        created_at: reflection.createdAt,
        tags: ['reflection'],
      }),
      '',
      `# ${reflectionTitle}`,
      '',
      `反思 ID：${reflection.id}`,
      '',
      reflection.whatHappened,
      '',
      '## 用户状态',
      '',
      '```json',
      JSON.stringify(reflection.userState, null, 2),
      '```',
      '',
      '## 她的状态',
      '',
      '```json',
      JSON.stringify(reflection.myState, null, 2),
      '```',
      '',
      '## 学到',
      '',
      ...reflection.learned.map((item) => `- ${item}`),
      '',
      '## 未解决',
      '',
      ...reflection.unresolved.map((item) => `- ${item}`),
      '',
      '## 关系变化',
      '',
      '```json',
      JSON.stringify(reflection.relationshipDelta, null, 2),
      '```',
      '',
      `会话：${reflection.sessionId}`,
    ].join('\n'),
  )
}

for (const intention of intentions) {
  const intentionTitle = titleFromText(intention.text, '以后想问')
  const fileName = uniqueFileName(
    makeFileName(shortDate(intention.createdAt), `意图 ${intentionTitle}`),
    usedIntentionNames,
  )
  writeFull(
    `40-意图/${fileName}.md`,
    [
      frontmatter({
        type: 'intention',
        id: intention.id,
        kind: intention.kind,
        status: intention.status,
        due_at: intention.dueAt,
        created_at: intention.createdAt,
        completed_at: intention.completedAt,
        source_reflection_id: intention.sourceReflectionId,
        tags: ['intention', intention.status],
      }),
      '',
      `# ${intentionTitle}`,
      '',
      `意图 ID：${intention.id}`,
      '',
      intention.text,
      '',
      intention.sourceReflectionId ? `来源反思：${intention.sourceReflectionId}` : '来源：手动或早期数据',
    ].join('\n'),
  )
}

writeFull(
  '50-联想/联想边.md',
  [
    frontmatter({ type: 'edge-index', title: '联想边', tags: ['edges'] }),
    '',
    '# 联想边',
    '',
    ...(edges.length === 0
      ? ['当前还没有联想边。记忆变多并运行维护后，这里会出现 same_topic 连接。']
      : edges.map((edge) => {
          const srcName = memoryFileById.get(edge.srcMemoryId) ?? edge.srcMemoryId
          const dstName = memoryFileById.get(edge.dstMemoryId) ?? edge.dstMemoryId
          return `- ${srcName} --${edge.relation}--> ${dstName} · weight ${edge.weight.toFixed(2)}`
        })),
  ].join('\n'),
)

writeFull(
  '20-关系/当前关系.md',
  [
    frontmatter({ type: 'relationship', title: '当前关系', tags: ['relationship'] }),
    '',
    '# 当前关系',
    '',
    `- 信任：${relationship.labels.trust}`,
    `- 熟悉：${relationship.labels.familiarity}`,
    `- 张力：${relationship.labels.tension}`,
    `- 最近感觉：${relationship.labels.recentMood}`,
    relationship.tone ? `- 基调：${relationship.tone}` : '',
    '',
    '## 数值',
    '',
    `- trust：${relationship.trust.toFixed(2)}`,
    `- familiarity：${relationship.familiarity.toFixed(2)}`,
    `- tension：${relationship.tension.toFixed(2)}`,
    `- recent_mood：${relationship.recentMood.toFixed(2)}`,
    '',
    '## 她的状态',
    '',
    `- mood_valence：${mind.moodValence.toFixed(2)}`,
    `- mood_arousal：${mind.moodArousal.toFixed(2)}`,
    `- energy：${mind.energy.toFixed(2)}`,
    mind.attention ? `- attention：${mind.attention}` : '',
    mind.currentConcern ? `- current_concern：${mind.currentConcern}` : '',
    chapter ? `- 最近阶段：${memoryFileById.get(chapter.id) ?? titleFromText(chapter.text, '阶段摘要')}` : '- 最近阶段：还没有生成',
  ]
    .filter((line) => line !== '')
    .join('\n'),
)

writeFull(
  '80-矛盾/待核对.md',
  [
    frontmatter({ type: 'contradiction-index', title: '需要核对', tags: ['contradiction'] }),
    '',
    '# 需要核对',
    '',
    ...(contradictions.length === 0
      ? ['当前没有待核对矛盾。']
      : contradictions.map((item) => {
          const a = memories.find((memory) => memory.id === item.aMemoryId)
          const b = memories.find((memory) => memory.id === item.bMemoryId)
          const aName = memoryFileById.get(item.aMemoryId) ?? item.aMemoryId
          const bName = memoryFileById.get(item.bMemoryId) ?? item.bMemoryId
          return `- ${aName} 与 ${bName}：${item.reason}\n  - A：${a?.text ?? '（已不存在）'}\n  - B：${b?.text ?? '（已不存在）'}`
        })),
  ].join('\n'),
)

writeFull(
  '85-维护/最近维护.md',
  [
    frontmatter({ type: 'maintenance', title: '最近维护', tags: ['maintenance'] }),
    '',
    '# 最近维护',
    '',
    maintenance
      ? `- 时间：${maintenance.at}\n- 触发：${maintenance.trigger}\n- 扫描：${maintenance.scanned}\n- 归档：${maintenance.archived}\n- 新增边：${maintenance.edges}\n- 矛盾：${maintenance.contradictions}\n- 过期意图：${maintenance.expiredIntentions}\n- 清理想法：${maintenance.thoughtsPruned}`
      : '还没有维护记录。',
  ].join('\n'),
)

for (const thought of thoughts) {
  const thoughtTitle = titleFromText(thought.content, '想法')
  const fileName = uniqueFileName(
    makeFileName(shortDate(thought.createdAt), `想法 ${thoughtTitle}`),
    usedThoughtNames,
  )
  writeFull(
    `70-想法/${fileName}.md`,
    [
      frontmatter({
        type: 'thought',
        id: thought.id,
        kind: thought.kind,
        confidence: thought.confidence,
        created_at: thought.createdAt,
        tags: ['thought', thought.kind],
      }),
      '',
      `# ${thoughtTitle}`,
      '',
      `想法 ID：${thought.id}`,
      '',
      thought.content,
    ].join('\n'),
  )
}

if (fullExport) {
  mkdirSync(join(exportRoot, '60-人设'), { recursive: true })
  for (const file of ['self.md', 'voice.md', 'life.md']) {
    const source = join(projectRoot, 'persona', file)
    if (existsSync(source)) copyFileSync(source, join(exportRoot, '60-人设', file))
  }
}

const activeMemories = memories.filter((memory) => memory.status === 'active')
writeFull(
  '95-时间线.md',
  [
    frontmatter({ type: 'timeline', title: '时间线', tags: ['timeline'] }),
    '',
    '# 时间线',
    '',
    ...(activeMemories.length === 0
      ? ['还没有生效记忆。']
      : activeMemories
          .slice()
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
          .map((memory) => `- ${shortDate(memory.createdAt)} ${memoryFileById.get(memory.id) ?? memory.id} · ${KIND_LABEL[memory.kind] ?? memory.kind} · ${memory.text}`)),
  ].join('\n'),
)

write(
  '图谱说明.md',
  [
    frontmatter({ type: 'graph-help', title: '图谱说明', tags: ['graph-help'] }),
    '',
    '# 图谱怎么看',
    '',
    '默认导出只生成记忆文档，不生成会话、反思、意图、想法、人设和首页，避免 Obsidian Graph 出现太多无关节点。',
    '',
    '记忆文档在：',
    '',
    '```text',
    'CompanionMemory/10-记忆',
    '```',
    '',
    '如果只想看记忆节点，在 Graph View 搜索框里输入：',
    '',
    '```text',
    'path:CompanionMemory/10-记忆',
    '```',
    '',
    '需要导出完整资料库时，运行：',
    '',
    '```bash',
    'OBSIDIAN_EXPORT_SCOPE=full pnpm export:obsidian',
    '```',
    '',
    '完整模式会额外生成会话、反思、意图、想法、人设、关系、维护、矛盾和时间线页面。',
  ].join('\n'),
)

writeFull(
  '00-记忆首页.md',
  [
    frontmatter({ type: 'index', title: 'Companion Memory', tags: ['index'] }),
    '',
    '# Companion Memory',
    '',
    `导出时间：${new Date().toISOString()}`,
    '',
    '## 快速入口',
    '',
    '- 当前关系：`20-关系/当前关系.md`',
    '- 联想边：`50-联想/联想边.md`',
    '- 时间线：`95-时间线.md`',
    '- 待核对：`80-矛盾/待核对.md`',
    '- 最近维护：`85-维护/最近维护.md`',
    '',
    '## 当前统计',
    '',
    `- 会话：${sessions.length}`,
    `- 记忆：${memories.length}`,
    `- 生效记忆：${activeMemories.length}`,
    `- 反思：${reflections.length}`,
    `- 意图：${intentions.length}`,
    `- 联想边：${edges.length}`,
    `- 待核对矛盾：${contradictions.filter((item) => item.status === 'pending').length}`,
    '',
    '## 最近记忆',
    '',
    ...(activeMemories.length === 0
      ? ['还没有生效记忆。']
      : activeMemories
          .slice()
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
          .slice(0, 20)
          .map((memory) => `- ${memoryFileById.get(memory.id) ?? memory.id} · ${KIND_LABEL[memory.kind] ?? memory.kind} · ${memory.text}`)),
    '',
    '## 人设',
    '',
    '- `60-人设/self.md`',
    '- `60-人设/voice.md`',
    '- `60-人设/life.md`',
  ].join('\n'),
)

console.log(`obsidian export -> ${exportRoot}`)
console.log({
  sessions: sessions.length,
  memories: memories.length,
  activeMemories: activeMemories.length,
  reflections: reflections.length,
  intentions: intentions.length,
  edges: edges.length,
  contradictions: contradictions.length,
})
