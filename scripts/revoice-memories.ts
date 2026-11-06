import 'dotenv/config'
import process from 'node:process'
import { z } from 'zod'
import { getDb, initDb } from '../src/core/db.ts'
import { listMemories } from '../src/core/store.ts'
import { completeJson } from '../src/core/llm.ts'

const PERSON_ID = 'p-0001'
const apply = process.argv.includes('--apply')

const RewriteSchema = z.object({
  items: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
})

const SYSTEM = `你是这个 AI 伴侣本人。下面这些是别人替你记下来的长期记忆，写法是第三方案卷腔（“用户”“助手”“该用户”）。
你的任务：把它们改写成你自己以后重读时会记得的说法。

规则：
1. 提到自己用“我”，提到对方用他的名字或他喜欢的称呼。
2. 不要出现“用户”“助手”“AI”“对方”“该用户”。
3. 只改口吻，不改事实、不加对话里没有的细节、不删信息。
4. 一句话保持一句话，别写成抒情。
5. 只输出 JSON：{"items":[{"id":"m-0001","text":"改写后的一句话"}]}

对话里出现的称呼优先用在 nickname 那条里。`

initDb()

const memories = listMemories({ personId: PERSON_ID, status: 'all', limit: 500 })
if (memories.length === 0) {
  console.log('没有记忆，退出')
  process.exit(0)
}

const listing = memories.map((memory) => `- ${memory.id} | ${memory.kind} | ${memory.text}`).join('\n')
const { data } = await completeJson([
  { role: 'system', content: SYSTEM },
  { role: 'user', content: `共 ${memories.length} 条：\n${listing}` },
])
const parsed = RewriteSchema.parse(data)
const byId = new Map(parsed.items.map((item) => [item.id, item.text]))

const db = getDb()
const update = db.prepare('UPDATE memory SET text = ? WHERE id = ?')
let changed = 0

if (apply) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `./data/companion.db.bak-${stamp}`
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`)
  console.log(`备份：${backup}`)
}

for (const memory of memories) {
  const next = byId.get(memory.id)
  if (!next || next.trim() === '') continue
  if (next === memory.text) continue
  console.log(`\n${memory.id} [${memory.kind}]`)
  console.log(`  旧  ${memory.text}`)
  console.log(`  新  ${next}`)
  if (/(用户|助手)/.test(next)) console.log('  ⚠ 仍是案卷腔，未应用')
  else if (apply) {
    update.run(next, memory.id)
    changed += 1
  }
}

console.log(apply ? `\n已改写 ${changed} 条` : `\n预览模式，未写入（加 --apply 写入）`)
