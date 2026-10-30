// 离线核心评测：不调用模型，只测检索命中与快慢路由。
// 运行：pnpm eval
import { writeFileSync } from 'node:fs'
import { resetDbForTests } from '../src/core/db.ts'
import { createMemory, neighborsOf } from '../src/core/store.ts'
import { retrieve } from '../src/core/retrieve.ts'
import { runMaintenance } from '../src/core/maintenance.ts'
import { getMindState } from '../src/core/store.ts'
import { routeMessage } from '../src/mind/perceive.ts'

const memoryProbes = [
  ['我喜欢喝冰美式，不加糖', '我喜欢喝什么', 'preference'],
  ['我对花生过敏', '我有什么过敏', 'fact'],
  ['我住在杭州', '我住在哪里', 'fact'],
  ['我家猫叫团子', '我的猫叫什么', 'fact'],
  ['我周末想去看展', '我周末想做什么', 'preference'],
  ['我不喜欢别人叫我全名', '称呼上要注意什么', 'boundary'],
  ['我下周三有面试', '面试是什么时候', 'fact'],
  ['我喜欢晚上跑步', '我什么时候跑步', 'preference'],
  ['我妈妈住在苏州', '我妈住在哪里', 'fact'],
  ['我对猫毛过敏', '我对什么过敏', 'fact'],
  ['我最近在学吉他', '我在学什么乐器', 'fact'],
  ['我喜欢吃辣', '我口味怎么样', 'preference'],
  ['我讨厌早起', '我讨厌什么', 'preference'],
  ['我生日是三月十二日', '我生日是什么时候', 'fact'],
  ['我养了一只狗叫豆豆', '我的狗叫什么', 'fact'],
  ['我住在城西', '我住哪边', 'fact'],
  ['我最喜欢的电影是星际穿越', '我最喜欢的电影', 'preference'],
  ['我每天坐地铁上班', '我怎么上班', 'fact'],
  ['我不吃香菜', '我饮食上有什么禁忌', 'boundary'],
  ['我下周要搬家', '我下周有什么安排', 'fact'],
]

const routingProbes = [
  ['你好呀', false],
  ['今天天气怎么样', false],
  ['我在看剧', false],
  ['晚安', false],
  ['周末有什么电影', false],
  ['我吃了火锅', false],
  ['哈哈', false],
  ['我去洗澡', false],
  ['在吗', false],
  ['随便聊聊', false],
  ['我今天真的很累', true],
  ['我有点焦虑，睡不着', true],
  ['你还记得我上次说的那件事吗', true],
  ['我们是不是吵架了', true],
  ['我该怎么办', true],
  ['你答应过我的', true],
  ['我想哭', true],
  ['我觉得你根本不在乎我', true],
  ['该不该换工作', true],
  ['你上次说会帮我，结果呢', true],
]

const edgeProbes = [
  ['团子喜欢趴在键盘上', '团子今天又趴在键盘上睡觉'],
  ['周末想去看展览', '周末想去看展的门票'],
  ['下雨天喜欢待在家里', '下雨天喜欢待在家看书'],
]

resetDbForTests(':memory:')

const memoryRows = []
let memoryHit = 0
for (const [text, query, kind] of memoryProbes) {
  const memory = createMemory({ kind, text })
  const result = retrieve('p-0001', query, { topK: 3 })
  const hit = result.selected.some((item) => item.id === memory.id)
  if (hit) memoryHit += 1
  memoryRows.push({ query, expected: memory.id, got: result.selected.map((item) => item.id), hit })
}

const state = getMindState()
const routingRows = []
let routingHit = 0
for (const [text, expectedSlow] of routingProbes) {
  const result = routeMessage(text, state)
  const hit = result.slow === expectedSlow
  if (hit) routingHit += 1
  routingRows.push({ text, expectedSlow, actualSlow: result.slow, reasons: result.reasons, hit })
}

const edgeIds = edgeProbes.map(([a, b]) => [
  createMemory({ kind: 'fact', text: a }).id,
  createMemory({ kind: 'fact', text: b }).id,
])
runMaintenance({ trigger: 'test' })
const edgeRows = edgeIds.map(([a, b], index) => {
  const neighborIds = neighborsOf(a, 5).map((item) => item.memory.id)
  return {
    pair: edgeProbes[index],
    connected: neighborIds.includes(b),
    neighborIds,
  }
})
const edgeHit = edgeRows.filter((row) => row.connected).length

const summary = {
  memory: `${memoryHit}/${memoryProbes.length}`,
  routing: `${routingHit}/${routingProbes.length}`,
  edges: `${edgeHit}/${edgeProbes.length}`,
}

const report = [
  '# 核心评测报告',
  '',
  `生成时间：${new Date().toISOString()}`,
  '',
  `- 记忆检索命中（top 3）：**${summary.memory}**`,
  `- 快慢路由判断：**${summary.routing}**`,
  `- 1 跳联想命中：**${summary.edges}**`,
  '',
  '## 记忆检索',
  '',
  '| 查询 | 期望 | 实际 | 命中 |',
  '|---|---|---|---|',
  ...memoryRows.map((row) => `| ${row.query} | ${row.expected} | ${row.got.join(', ') || '—'} | ${row.hit ? '✅' : '❌'} |`),
  '',
  '## 快慢路由',
  '',
  '| 输入 | 期望 | 实际 | 命中 | 理由 |',
  '|---|---|---|---|---|',
  ...routingRows.map((row) => `| ${row.text} | ${row.expectedSlow ? '慢' : '快'} | ${row.actualSlow ? '慢' : '快'} | ${row.hit ? '✅' : '❌'} | ${row.reasons.join(' / ') || '—'} |`),
  '',
  '## 1 跳联想',
  '',
  '| 事件 A | 事件 B | 是否连上 |',
  '|---|---|---|',
  ...edgeRows.map((row) => `| ${row.pair[0]} | ${row.pair[1]} | ${row.connected ? '✅' : '❌'} |`),
  '',
  '> 说明：这是离线核心评测，不调用模型；回答质量仍需人工或带模型的端到端评测。',
  '',
].join('\n')

writeFileSync('docs/eval-report.md', report, 'utf8')
console.log(summary)
console.log('report -> docs/eval-report.md')
