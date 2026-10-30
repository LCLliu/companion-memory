# Companion Mind · 慢思记忆系统设计方案

> 状态：设计稿 v0.1
> 日期：2026-10-29
> 关系：在 Phase 0 `companion-memory` 之上增加“认知循环”；不是推翻记忆层，而是让记忆成为思考的底座。

## 0. 一句话

**她不是“记得更多”，而是会在回应前先想一想：这件事对我和你意味着什么、你现在需要什么、我该怎么说；说完之后她会反思，夜里再整理。**

记忆回答“发生过什么”，思考回答“这意味着什么、接下来怎么办”。前者是数据库，后者才像人。

---

## 1. 从“记忆”到“心智”

Phase 0 已经有了：

- 事件、事实、偏好、边界、承诺、未完成事项；
- 会话简报 + 每轮 top 3 检索；
- LLM 抽取与来源校验；
- 手动置顶 / 归档 / 恢复。

但它有一个根本问题：**记忆只在“被检索”时存在，模型没有“想”的过程**。

- 用户说一句难过的话，它检索到“她最近压力大”，然后直接给建议；
- 它不会先判断“现在该安慰还是该解决”；
- 它不会在回答前想“这句话会不会让她更难受”；
- 它不会在聊完之后想“我刚才是不是说得太急了”；
- 它不会在第二天主动想起“她今天有个面试”。

所以新方案的核心不是更多记忆类型，而是**在感知和表达之间加一层“ deliberation（斟酌）”**，并让这层思考有状态、有记忆、有反思、有边界。

---

## 2. 设计原则

1. **记忆是底料，不是产品**。产品是“她怎么想、怎么回应、怎么继续”。
2. **快慢双路径**。不是每句话都深思；小事快答，重要的事慢想。
3. **思考不等于暴露思维链**。内部思考只保存摘要，不把 raw CoT 塞给用户。
4. **思考不能变成事实**。`thought` 是临时的，`memory` 必须有来源和证据。
5. **情绪进入决策**。不是给回复加一个 emoji，而是影响“先共情还是先解决”“现在说不说”。
6. **关系是慢变量**。信任、熟悉、张力、共同经历，不能每轮重写。
7. **主动性有上限**。可以想起你、可以追问，但不能刷屏、不能制造愧疚。
8. **可审计、可关闭**。用户能看“她刚才在考虑什么”的摘要，也能删掉。

---

## 3. 总体架构

```
用户消息
   │
   ▼
① Perceive 感知：意图 / 情绪 / 紧迫度 / 关系线索 / 歧义
   │
   ▼
② Appraise 评估：这件事对“我”和“我们”意味着什么？值不值得慢想？
   │
   ├─ 快路径（低风险）──────────────────────────────┐
   │     Recall 检索 → Express 直接回应              │
   │                                                  │
   └─ 慢路径（高情绪/冲突/重要决定/记忆不确定）        │
         Recall 检索 → Deliberate 斟酌 → Express       │
                                                      ▼
                                              ③ 回应
                                                      │
                                                      ▼
                                        ④ Reflect 反思（每轮/每会话）
                                                      │
                                                      ▼
                                        ⑤ Consolidate 巩固（夜间）
                                                      │
                                                      ▼
                                     记忆 / 关系 / 意图 / 自我叙事
```

五个持续存在的状态：

| 状态 | 回答的问题 | 变化速度 |
|---|---|---|
| `memory` | 发生过什么、什么是真的 | 每会话增量 |
| `relationship_state` | 我们是什么关系、最近怎么样 | 慢，按会话 |
| `mind_state` | 我现在是什么状态、在担心什么 | 慢，按小时/天 |
| `thought` | 我此刻在考虑什么 | 快，分钟/小时，会过期 |
| `intention` | 我接下来想做什么 | 慢，按天/周 |

---

## 4. 认知循环的七个阶段

### 4.1 Perceive 感知

输入：用户消息 + 最近对话 + 时间 + 关系状态。

输出（JSON）：

```json
{
  "intent": "倾诉 | 求助 | 闲聊 | 试探 | 冲突 | 回忆 | 决策",
  "user_emotion": { "label": "疲惫", "valence": -0.4, "arousal": 0.5, "confidence": 0.8 },
  "urgency": 0.3,
  "relationship_cue": "她在确认我是否记得",
  "ambiguity": 0.6,
  "needs": ["被听见", "被记得"],
  "risk": "低"
}
```

规则：

- 情绪强度高、负价、关系线索、歧义高、涉及承诺/边界 → 进入慢路径；
- 感知结果不是记忆，只存 `thought`，TTL 7 天；
- 不要把“用户可能难过”写成事实，除非用户明确表达。

### 4.2 Appraise 评估

回答三个问题：

1. **这对她意味着什么？**（她是在求助、在试探、还是在发泄？）
2. **这对我们意味着什么？**（关系张力、信任、承诺、边界）
3. **我现在的状态适合怎么回应？**（耐心、疲惫、担心、想澄清）

输出：

```json
{
  "stakes": 0.7,
  "should_slow": true,
  "my_reaction": "有点担心，但不想过度解读",
  "what_i_dont_know": ["她是在说工作，还是在说我们"],
  "action_tendency": "先接情绪，再问一句"
}
```

### 4.3 Recall 检索

不是只查“相关记忆”，而是查五类：

| 类型 | 作用 |
|---|---|
| 事件记忆 | “上次类似的事发生了什么” |
| 语义事实/偏好/边界 | “她通常不喜欢什么” |
| 关系状态 | “我们现在是轻松还是紧张” |
| 未完成事项/意图 | “我答应过什么、她提过什么” |
| 当前关注 | “我最近在担心她什么” |

检索结果必须带：`id / 来源 / 置信度 / 时间`。低置信度记忆只能作为“猜测”，不能当事实。

### 4.4 Deliberate 斟酌（仅慢路径）

这是“慢慢思考”的核心。目标不是生成更多文字，而是**在几个可能的回应之间做选择**。

内部步骤：

1. **解释候选**：她这句话可能有哪 2–3 种意思？
2. **回应候选**：每种解释下，我可以怎么回？
3. **后果模拟**：每种回法可能让她感觉如何？对关系如何？
4. **价值检查**：是否符合我的人设、边界、承诺？
5. **选择**：选一个，并说明为什么；如果信息不够，选择“先问一句”。

输出 JSON：

```json
{
  "interpretations": [
    { "reading": "她在倾诉，不想听建议", "confidence": 0.7 },
    { "reading": "她在试探我是否记得", "confidence": 0.2 }
  ],
  "options": [
    { "stance": "先接情绪", "reply_goal": "让她感到被听见", "risk": "低" },
    { "stance": "直接给方案", "reply_goal": "解决问题", "risk": "可能让她觉得被敷衍" }
  ],
  "chosen": "先接情绪，再问一句她想要建议还是想说说",
  "tone": "温和、简短",
  "should_ask": true,
  "question": "你是想让我听着，还是一起想想办法？",
  "confidence": 0.75
}
```

约束：

- 最多 2 轮内部斟酌；超时/超预算退回快路径；
- 不展示 raw CoT，只把 `chosen` 和一句 `thought_summary` 存进 `thought`；
- 如果 `confidence < 0.5`，优先问，不要猜。

### 4.5 Express 表达

最终回复由“人设 + 关系 + 记忆 + 斟酌结论”共同决定：

- 长度：日常 1–3 句；重要话题可长，但不写成报告；
- 语气：随关系状态调整；紧张时先修复，不抖机灵；
- 记忆：只在相关时自然提起，不列清单；
- 不确定：直接说“我记不太清了”，不编；
- 问题：一轮最多一个，且是真问题，不是审问。

### 4.6 Reflect 反思

每轮或每会话结束，异步生成：

```json
{
  "what_happened": "她说了工作上的挫败，我没有急着给建议。",
  "user_state": { "label": "挫败", "needs": ["被听见"], "confidence": 0.7 },
  "my_state": { "mood": "担心", "concerns": ["她最近连续加班"] },
  "what_i_learned": [
    { "text": "她在压力大时更希望先被听见", "kind": "preference",
      "confidence": 0.8, "source_turn_ids": [42, 43] }
  ],
  "what_to_remember": [
    { "text": "她下周三有面试", "kind": "fact", "confidence": 0.9,
      "source_turn_ids": [44] }
  ],
  "what_remains": [
    { "text": "面试结果还没告诉我", "kind": "open_loop" }
  ],
  "relationship_delta": { "tone": "更信任一点", "tension": -0.1 },
  "next_intention": { "text": "周三晚上问一句面试怎么样", "due_at": "2026-11-04" }
}
```

硬规则：

- `what_i_learned` / `what_to_remember` 必须带 `source_turn_ids`；
- 没有来源的“领悟”只能进 `thought`，不能进 `memory`；
- `relationship_delta` 有上下限，不能一晚上从陌生到生死相依；
- `next_intention` 最多 3 条 active，避免“关心”变骚扰。

### 4.7 Consolidate 巩固（夜间 / 空闲）

- 合并零散 episode；
- 更新关系状态与自我叙事；
- 计算衰减、归档低价值记忆；
- 处理矛盾（保留冲突，不自动覆盖）；
- 生成 0–2 条“明天可以想起的事”（intention），不自动发消息；
- 输出一份 Dream 报告，用户可看。

---

## 5. 快慢双路径

### 5.1 路由规则

```ts
slow =
  emotion_intensity >= 0.65 ||
  negative_valence <= -0.3 ||
  relationship_cue ||
  conflict ||
  memory_conflict_or_low_confidence ||
  decision_request ||
  boundary_or_promise ||
  ambiguity >= 0.7
```

目标：**慢路径占比 20–30%**。超过 40% 说明阈值太松，会又慢又贵；低于 10% 说明该慢的时候没慢。

### 5.2 成本与延迟

| 路径 | LLM 调用 | 上下文 | 延迟目标 | 用途 |
|---|---|---|---|---|
| 快 | 1 次 | 3–4k | <2s | 闲聊、低风险 |
| 慢 | 2–3 次 | 6–10k | 3–8s | 情绪、冲突、决定、回忆 |
| 反思 | 1 次/会话 | 2–3k | 异步 | 学习与关系更新 |
| 巩固 | 1–2 次/夜 | 4–8k | 异步 | 合并、衰减、自我叙事 |

### 5.3 防过度思考

- 最多 2 轮斟酌；
- 硬超时 8s，超时用快路径结果；
- `confidence >= 0.75` 才允许“直接下结论”；
- 连续 3 次慢路径都被用户打断/忽略 → 降级为快路径，记录原因；
- 不模拟“正在输入 10 秒”来假装深沉；慢是真实的计算，不是表演。

---

## 6. 数据模型

在 Phase 0 的 SQLite 上新增：

### 6.1 `mind_state`

| 字段 | 说明 |
|---|---|
| person_id | 归属人 |
| mood_valence / mood_arousal | 当前心情坐标 |
| energy | 精力 0..1（用于决定“今天适合深聊吗”） |
| attention | 当前关注点（一句话） |
| current_concern | 我在担心什么 |
| updated_at | 更新时间 |

这是慢变量，按天衰减回基线；不要每轮重写。

### 6.2 `thought`

| 字段 | 说明 |
|---|---|
| id | `t-0001` |
| person_id / session_id / turn_id | 归属 |
| kind | `appraisal` / `option` / `critique` / `reflection` / `intention_candidate` / `summary` |
| content | 一句话摘要，不是 raw CoT |
| confidence | 0..1 |
| selected | 是否被采纳 |
| visible | 是否允许 UI 展示 |
| expires_at | 默认 7 天 |
| created_at | 时间 |

**原始推理不落库**；只存摘要、候选、结论。这样既省空间，也避免“把自己的猜测当事实”。

### 6.3 `reflection`

| 字段 | 说明 |
|---|---|
| id | `r-0001` |
| person_id / session_id | 归属 |
| what_happened | 发生了什么 |
| user_state | 用户状态（JSON） |
| my_state | 我的状态（JSON） |
| learned | 学到什么（JSON） |
| unresolved | 未解决（JSON） |
| relationship_delta | 关系变化（JSON） |
| created_at | 时间 |

### 6.4 `intention`

| 字段 | 说明 |
|---|---|
| id | `i-0001` |
| person_id | 归属 |
| text | “周三问一句面试怎么样” |
| kind | `follow_up` / `repair` / `share` / `ask` |
| due_at | 触发时间 |
| status | `active` / `done` / `dropped` / `expired` |
| source_reflection_id | 来源反思 |
| created_at | 时间 |

最多 3 条 active；过期自动 `expired`；用户可关闭。

### 6.5 扩展 `memory`

新增：

- `unresolved`：这件事是否还没解决；
- `emotional_charge`：情绪强度（可由 arousal 推导）；
- `last_reinforced`：最后一次“确认重要”的时间；
- `source_thought_id`：由哪次思考促成（可空）。

### 6.6 `edge`

```sql
edge(src_memory_id, dst_memory_id, relation, weight, created_at)
```

第一版只做 `same_topic` / `temporal` / `emotional` / `supports` / `contradicts`；1 跳扩展，不做全图 PPR。

---

## 7. 记忆生命周期（吸收 OmbreBrain 的机制）

### 7.1 衰减

```
score = importance
      × (1 + log1p(access_count))
      × e^(-days / halfLife)
      × emotion_weight
      × resolved_factor
```

- `halfLife`：闲聊 14 天 / 事件 90 天 / 事实 365 天 / 关系与边界 ∞；
- `emotion_weight = 1 + arousal × 0.8`；
- `resolved_factor`：未解决 1.0；已解决 0.1；已消化 0.05；
- `score < 0.3` → `archived`，不删除；
- `pinned / boundary / promise` 永不自动归档。

### 7.2 强化

**检索不加权，确认才加权。**

- 只有以下动作触发 `reinforce`：
  - 反思里明确“这条重要”；
  - 用户确认/重复/纠正；
  - 关系事件（承诺、道歉、和解）；
  - 手动置顶。
- 检索只读，记录 `recall_log`，不增加 `access_count`。

这是从 OmbreBrain 学到的最关键一条：**“我去找它”不等于“它重要”**。

### 7.3 联想

- 写入时建 `same_topic` / `temporal` 边；
- 检索先 FTS/向量取种子，再 1 跳扩展；
- 扩展权重 ×0.5，最多 3 条附加；
- 图只用于“想起相关的事”，不用于“替代检索”。

### 7.4 情绪

- 事件级：`valence / arousal`；
- 关系级：`tone / trust / tension / recent_mood`；
- AI 表达级：`response_policy`（先共情/先解决/先澄清/先道歉）；
- 情绪不写成“我真的很痛苦”，而是写成“我现在更适合先听你说”；
- 关系状态按天回落，不永久停在一次冲突里。

---

## 8. 元认知：会想，也要知道自己可能想错

1. **置信度**：每条记忆/判断带 `confidence`；低于 0.6 时，回复必须用“我记得”“可能”“不确定”；
2. **来源检查**：涉及共同经历的陈述必须能映射到 memory id；映射不到就降级为猜测或提问；
3. **矛盾检查**：两条记忆冲突时，不选一个当事实，先标记 `pending_review`；
4. **自检清单**（慢路径发给 critic）：
   - 我有没有编造记忆？
   - 我有没有答非所问？
   - 我有没有越界/说教？
   - 语气是否符合关系状态？
   - 是否太长、是否在表演深刻？
5. **允许不知道**：说“我记不清了”“我不确定你指的是哪件事”，比编造更像人。

---

## 9. 人设与自我叙事

“会思考”需要一个稳定的“谁在思考”。

`self` 块（常驻，600–800 token）：

- 价值观：她在乎什么、不会做什么；
- 性格：冷静/敏感/直接/俏皮；
- 依恋与关系模式：怎么表达关心、冲突时怎么处理；
- 恐惧与脆弱：什么会让她不安；
- 语言风格：句长、口头禅、是否用表情；
- 当前章节：最近在经历什么（慢更新）。

规则：

- 人设是**作者设定**，不是从记忆自动漂移；
- 自我叙事每月/重大事件后更新一次，版本化；
- 人设与记忆冲突：事实以记忆为准，语气以人设为准；
- 不把“思考”演成“深沉”；人设是冷静的人，慢想是自然结果，不是表演。

---

## 10. 主动性：会想起你，但不骚扰

- `intention` 驱动：面试后的追问、答应过的事、未解决的冲突；
- 每天最多 1 条主动消息；用户可关闭；
- 不制造愧疚（“你都不理我”），不刷存在感；
- “念头池”：后台每天最多生成 2 条 thought，只有在相关时才浮现；
- 主动消息必须带“可拒绝”的出口：“不想聊这个也没关系”。

---

## 11. 上下文预算

| 块 | 每轮常驻 | 会话开场 |
|---|---|---|
| 人设/规则 | 600–800 | 同左 |
| 关系 + mind_state | 200–300 | 300–500 |
| 未完成/意图 | 150–250 | 200–300 |
| 检索记忆 top 3–5 | 600–900 | 800–1,200 |
| 最近原文 6–12 轮 | 1,500–2,500 | 0 |
| 斟酌计划（慢路径，隐藏） | 500–800 | — |
| 工具预留 | 800–1,000 | — |
| **可见总计** | **3–5k** | **1.5–2.5k** |
| 慢路径隐藏总计 | +1–2k | — |

硬上限 8k；超过就压缩最近原文/摘要，不牺牲人设与关系卡。

---

## 12. 技术选型与模块

保留现有技术栈：Node 24 + TypeScript + Fastify + SQLite + React。

新增 `src/mind/`：

```
mind/
  perceive.ts      感知：意图/情绪/歧义
  appraise.ts      评估：stakes / should_slow
  deliberate.ts    慢路径：候选、后果、选择
  express.ts       提示词组装与最终回复
  reflect.ts       反思：学习/记忆/关系/意图
  consolidate.ts   夜间巩固
  mind-state.ts    心情/精力/关注点
  thoughts.ts      念头池（TTL、摘要）
  intentions.ts    主动意图
  router.ts        快慢路由
```

调度：

- 每轮：perceive → route → (recall) → deliberate? → express；
- 每会话结束：reflect（异步）；
- 每晚：consolidate + decay + dream；
- 每 10 分钟：tick，处理到期 intention / 后台念头（有上限）。

模型分工：

- 快路径：便宜、低延迟模型；
- 慢路径/反思：更强模型，温度低，JSON 输出；
- 抽取/打标：免费模型（GLM-4.7-Flash）；
- 全部通过 `.env` 配置，不写死。

不引入 LangGraph/Letta 运行时：当前是单用户、单进程，自己写一个 7 阶段状态机更简单、更可控。以后要接多 Agent 再考虑。

---

## 13. 开源项目对照：抄什么、不抄什么

| 项目 | 核心机制 | 抄 | 不抄 |
|---|---|---|---|
| Generative Agents | 记忆流 + 反思 + 规划 | 反思树、每日计划、重要性打分 | 小镇模拟、全量重放 |
| Letta / MemGPT | Core/Archival/Recall 分层、sleep-time compute、memory blocks | 睡眠时反思、核心记忆块、Git 版本 | 整个运行时、Postgres 依赖 |
| Mem0 | 抽取 / 更新 / 去重 | add/update/delete 判定、多租户隔离 | 每次写入都调 LLM、云端依赖 |
| Zep / Graphiti | 时序知识图谱 | `valid_from/valid_to`、冲突失效 | 一开始就上 Neo4j |
| A-MEM | Zettelkasten 自动链接与演化 | 记忆自动建链、旧卡更新 | 无审计的自动改写 |
| HippoRAG | 海马体索引 + PPR | 1 跳图扩展、多跳检索 | 过早做全图 PPR |
| ZenBrain | 七层记忆 + 元认知 + 睡眠 | 分层、元认知监控、睡眠巩固 | 15 个算法全上、过重 |
| OmbreBrain | 桶类型、遗忘曲线、Dream/Feel、检索与强化解耦 | 生命周期、情绪权重、检索不 touch | 目录扫描、16 个工具、五种模式 |
| Reflexion | 语言化自我反思 | 失败→分析→经验→下次调用 | 无限自我反思循环 |
| ReAct / Plan-and-Solve | 推理与行动交替、先规划 | 慢路径的 plan 步骤 | 每轮都显式 ReAct |
| MemOS | 记忆操作系统、调度 | 记忆任务调度、版本化 | 系统级重架构 |

---

## 13.5 多模态扩展（预留方案，不进入当前里程碑）

> **当前决定（2026-10-30）**：先做纯文本版；多模态只保留接口与设计，不实现上传、ASR、TTS、视觉，也不建空表。
> 本节保留完整方案，等文本版 Phase 1–2 稳定后再启动；QQ 继续推迟。

### 13.5.1 范围

| 能力 | 第一版 | 说明 |
|---|---|---|
| 图片输入 | ✅ | 上传 / 粘贴 / 拖拽 / 拍照；视觉模型生成 caption、OCR、实体、情绪 |
| 语音输出 TTS | ✅ | 回复可朗读；先浏览器/Edge TTS，后换角色音色 |
| 语音输入 ASR | 第二阶段 | 录音 → 转写 → 当作文本消息；保留音频附件 |
| 音频消息 | 第二阶段 | 音频气泡 + 转写文字 + 可回放 |
| 图片生成 | 第三阶段 | 她主动发图/自拍/示意图；需要额外模型与审核 |
| 视频输入/输出 | 暂不做 | 成本与延迟太高；先保证图片+语音闭环 |
| 实时全双工语音 | 暂不做 | 需要独立的语音通道、打断、回声消除；不是 Web MVP |

### 13.5.2 架构

```
浏览器
  ├─ 文件选择 / 拖拽 / 粘贴 / 摄像头 → POST /api/media
  ├─ MediaRecorder → WebM/Opus → POST /api/media
  └─ 音频播放器 / TTS 播放
        │
        ▼
Fastify /api/media
  ├─ 校验大小/类型/时长
  ├─ 压缩图片（WebP/JPEG）、音频（Opus/WebM）
  ├─ sha256 去重
  ├─ 落盘 data/media/{yyyy}/{mm}/{uuid}
  └─ 写 media 表
        │
        ▼
感知层
  ├─ 图片：vision 模型 → caption / OCR / 实体 / 情绪
  ├─ 音频：ASR → transcript（可选：语速/停顿/情绪）
  └─ 文本：原消息
        │
        ▼
Perceive 产出 percept：
  { text, attachments:[mediaId], modality_notes, emotion }
        │
        ▼
Appraise → Recall → Deliberate → Express
        │
        ├─ 文本回复
        ├─ TTS（可选）
        └─ 图片/媒体引用（可选）
```

### 13.5.3 数据模型

```sql
media(
  id TEXT PRIMARY KEY,          -- md-0001
  person_id TEXT NOT NULL,
  session_id TEXT,
  message_id INTEGER,
  kind TEXT,                    -- image | audio | video | file
  path TEXT NOT NULL,           -- 本地相对路径
  mime TEXT,
  bytes INTEGER,
  sha256 TEXT,
  width INTEGER, height INTEGER,
  duration_ms INTEGER,
  caption TEXT,                 -- 视觉模型生成
  ocr_text TEXT,
  transcript TEXT,              -- ASR
  entities TEXT,                -- JSON
  emotion_label TEXT,
  valence REAL, arousal REAL,
  status TEXT DEFAULT 'active', -- active | archived
  created_at TEXT
);

message_media(message_id, media_id);
memory_media(memory_id, media_id);

CREATE VIRTUAL TABLE media_fts USING fts5(
  caption, ocr_text, transcript,
  content='media', content_rowid='rowid',
  tokenize='trigram'
);
```

规则：

- 图片/音频文件在磁盘，SQLite 只存元数据与派生文本；
- `caption / ocr_text / transcript` 同时写一份到对应 `memory.text` 的摘要里，保证 `memory_recall` 能搜到；
- 删除媒体默认软删除（`status='archived'`），记忆保留文字摘要；彻底删除需要二次确认；
- 媒体大小限制：图片 10MB、音频 5 分钟/20MB；超出拒绝并提示；
- 同一 sha256 去重，避免重复上传。

### 13.5.4 视觉与语音选型

| 能力 | 推荐 | 备选 | 注意 |
|---|---|---|---|
| 图片理解 | 智谱 `GLM-4.6V-Flash`（免费） | Qwen-VL / Gemini | 单独配置 `VISION_MODEL`，不要和聊天模型混用 |
| OCR | 视觉模型直接出 | PaddleOCR 本地 | 中文截图/文档优先视觉模型 |
| ASR | 本地 `faster-whisper` | 硅基流动 SenseVoice / Whisper API | 云端会出网；本地需 Python sidecar |
| TTS | Edge TTS（中文自然、免费） | 浏览器 SpeechSynthesis / CosyVoice / GPT-SoVITS | 角色音色涉及克隆版权，先选通用音色 |
| 图片生成 | 智谱 CogView-3-Flash（免费） | ImageGen / 本地 SD | 第三阶段再做，需内容审核 |
| 存储 | 本地磁盘 + SQLite | 对象存储 | 不做云同步 |

`.env` 新增：

```dotenv
VISION_BASE_URL=https://open.bigmodel.cn/api/paas/v4
VISION_API_KEY=
VISION_MODEL=glm-4.6v-flash

ASR_PROVIDER=local            # local | api
ASR_MODEL=small               # faster-whisper
TTS_PROVIDER=edge             # edge | browser | local
TTS_VOICE=zh-CN-XiaoxiaoNeural
MEDIA_ROOT=./data/media
MEDIA_MAX_IMAGE_MB=10
MEDIA_MAX_AUDIO_MB=20
```

### 13.5.5 Web UI

- 输入区：回形针（图片）、麦克风（录音）、摄像头（拍照）；支持拖拽/粘贴；
- 气泡：图片网格、音频播放器 + 转写、视频播放器（后期）；
- 回复：文本 + “朗读”按钮；可设置自动朗读；
- 记忆面板：媒体画廊，按 image/audio 筛选；详情显示 caption/OCR/transcript 与来源消息；
- 调试面板：显示“她看到了什么”（caption/OCR）和“她听到了什么”（transcript），方便核对视觉/ASR 错误；
- 无障碍：图片 alt、音频字幕、键盘可操作。

### 13.5.6 对认知循环的影响

- `Perceive` 增加附件解析，产出 `modality_notes`：例如“她发来一张猫的照片，猫趴在键盘上，她看起来很开心”；
- `Appraise` 可以引用视觉/语音线索，但必须标明来源（图片/转写），不能把模型猜测当事实；
- `Recall` 支持按媒体检索：`media_fts` + 关联 memory；
- `Reflect` 可以写“她发照片时情绪是开心的”，并建立 `memory_media` 关联；
- `Express` 可选择文本、TTS、图片；语音回复要短，图片回复要克制，不能每轮都发图。

### 13.5.7 分阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1（3–4 天） | 图片上传/粘贴/拖拽 + 视觉 caption/OCR + 气泡展示 + 记忆关联 | 上传猫照片，她能说出“猫趴在键盘上”；新会话能回忆；图片详情可见来源 |
| M2（3–5 天） | TTS 朗读 + 语音输入 ASR + 音频气泡 + 转写 | 录 10 秒语音，转写正确率可接受；她回复并可朗读；音频可回放 |
| M3（约 1 周） | 媒体画廊 + 媒体检索 + 压缩/去重/归档 + 语音情绪（可选） | 存储不超过预算；删除媒体后记忆文字仍在；检索能命中 caption/transcript |
| M4（可选） | 图片生成 / 角色音色 / 短视频 / 实时语音 | 单独评估成本、延迟、伦理 |

### 13.5.8 风险

| 风险 | 对策 |
|---|---|
| 视觉模型编造图片内容 | caption 带置信度；关键描述要求“只写看得见的”；用户可纠正 |
| ASR 转写错误 | 保留原文音频；转写可编辑；低置信度时先确认 |
| 云端 API 隐私 | 图片/音频默认本地存储；云端调用需在 UI 明示；提供本地 ASR/TTS 选项 |
| 存储膨胀 | 压缩、去重、大小限制、归档策略；定期统计 |
| TTS 音色版权/人格 | 先用通用音色；克隆真人声音必须获得授权 |
| 延迟 | 图片 caption 异步；语音先出文字再出音频；TTS 流式 |
| 多模态记忆污染 | 媒体描述作为“证据”存，不把模型猜测写成事实；来源可追溯 |

### 13.5.9 需要拍板（等启动多模态时再定）

1. 第一版是否按“图片输入 + TTS 输出”起步？
2. ASR/TTS 走云端（快、简单）还是本地（隐私、部署重）？
3. 语音是否要“她的专属音色”？如果要，先选通用音色还是做克隆？
4. 图片生成是否进入第一阶段？建议不进。

### 13.5.10 文本版的“预留接口”（现在只做这些）

不建空表、不显示附件按钮、不写死视觉/语音代码；只留扩展点，避免以后返工。

| 预留点 | 现在怎么做 | 以后怎么接 |
|---|---|---|
| `percept` | 固定包含 `attachments: []`、`modality_notes: []` | 填入 mediaId / 图片描述 / 转写 |
| `message` | 继续用 `id` + `source_message_ids` | 新增 `message_media`，不动 message 结构 |
| `memory` | 继续用 `source_message_ids` | 新增 `memory_media` 关联，不动 memory 正文 |
| 搜索 | `memory_fts` 只索引文本 | 以后新增 `media_fts` 索引 caption/OCR/transcript |
| API | `POST /chat` 只接受 `{ message: string }` | 以后追加可选 `attachments?: MediaRef[]` |
| UI | 输入区只保留文本框 | 以后加回形针/麦克风/摄像头，不重排布局 |
| 配置 | `.env.example` 不写视觉/语音项 | 启动 M1 时追加 `VISION_* / ASR_* / TTS_* / MEDIA_*` |
| 存储 | 只有 `data/companion.db` | 以后加 `data/media/`，SQLite 只存元数据 |

原则：**接口形状预留，实现留空**。不要在文本版里塞 `media` 表或空字段，那会让 Phase 1 的 schema 变脏。

## 14. 分阶段路线图（文本优先）

### Phase 1（约 1 周）：会“先想一下”

- `mind_state` + 快慢路由；
- 慢路径：plan JSON → draft → critic → final；
- 每轮/每会话反思；
- `thought` 摘要 + 调试面板（不显示 raw CoT）。

**验收**：
- 20 条“慢思考探针”：情绪倾诉、冲突、记忆不确定、决定、边界；
- 慢路径占比 20–30%；
- 记忆探针 ≥90%；
- 虚假记忆 = 0；
- 用户主观评分“她考虑了我的感受” ≥4/5。

### Phase 2（约 1 周）：会“考虑你”

- 关系状态 + 情绪 appraisal + 未完成/意图；
- 主动追问（每天 ≤1 条）；
- “念头池”后台生成，默认不打扰。

**验收**：
- 面试/承诺类 follow-up 相关性 ≥70%；
- 主动消息可拒绝、不制造愧疚；
- 关系状态不会一夜突变。

### Phase 3（1–2 周）：会“整理自己”

- 夜间 Dream：合并 episode、更新自我叙事、衰减归档；
- 1 跳联想边 + 图扩展；
- 元认知：矛盾检测、置信度、来源检查。

**验收**：
- 低价值记忆被归档而非编造；
- 冲突不被自动覆盖；
- 自我叙事版本可回溯。

### Phase 4：Web 文本版收尾 / 评测

- 30 条记忆探针 + 20 条思考探针；
- 慢路径成本/延迟监控；
- 记忆管理 UI 完整化（关系、反思、意图）。

### Phase 5（预留，不在当前里程碑）：多模态

- 按 13.5 执行：先图片输入 + TTS，再语音输入，最后图片生成/视频；
- 启动前再确认 `VISION_* / ASR_* / TTS_*` 选型与隐私边界。

### 推迟：QQ / 多用户

- 官方 Bot、`person_id` 隔离；
- 等 Web 文本版与多模态稳定后再接入。

---

## 15. 风险与伦理

| 风险 | 对策 |
|---|---|
| 过度思考、延迟高 | 快慢路由、2 轮上限、8s 超时 |
| 表演深沉 | 评估“是否考虑了感受”，不评估“听起来深不深” |
| 把猜测当事实 | thought 与 memory 分离；来源校验 |
| 思考内容泄露隐私 | raw thought 不落库，摘要 TTL 7 天 |
| 情绪依赖/操控 | 透明说明 AI；不做好感度游戏；主动消息可关 |
| 关系状态失真 | 数值有上下限，按天回落，用户可见可改 |
| 反思改写事实 | 反思只能提议，记忆写入必须有来源 |
| 成本失控 | 慢路径 20–30%，反思异步，抽取用免费模型 |

---

## 16. 明确不做

- 不做“每轮 5 个 Agent 开会”；
- 不展示 raw chain-of-thought；
- 不把 thought 永久保存成 memory；
- 不让反思自动改写事实；
- 不在检索时自动强化；
- 不为了“像人”故意延迟回复；
- 不在没有记忆评测的情况下堆图谱。

---

## 17. 需要拍板

1. 慢路径触发阈值：情绪强度 0.65 是否合适？先按 0.6 试跑一周。
2. `thought` 是否在 UI 里可见？建议：调试模式可见摘要，正式模式默认隐藏。
3. 主动消息频率：每天 1 条，还是仅“用户明确提过且到期”才发？
4. 人设：先手写 600–800 token，还是从旧对话蒸馏？建议先手写，稳定后再蒸馏。
5. 模型分工：快路径/慢路径用同一模型，还是快用便宜、慢用强模型？建议先同一模型，按成本再拆。

---

## 18. 一句话总结

**Phase 0 让她“记得”；这个方案让她“在记得之后，先想一想，再决定怎么说；说完还会反思，夜里再整理”。**

记忆是骨架，情绪是重量，关系是坐标，反思是生长。慢，不是延迟，是在几个可能的自己之间做选择。
