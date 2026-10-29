# lcl-companion 设计方案

> 状态：设计稿，未开工
> 日期：2026-10-29
> 定位：与 LCL_MER 并列的“陪伴型长期记忆”插件。LCL_MER 继续负责编码记忆，互不干扰。

## 0. 目标与非目标

### 目标

1. 单个人与 AI 长期对话（数月到数年），记忆可持续累积。
2. 关键信息不丢：称呼、偏好、边界、承诺、重要事件、关系基调。
3. 无效信息不占上下文：每轮只带 1.3k token 左右的记忆块。
4. 可纠正、可删除、可追溯：任何一条记忆能查到出处，能改、能撤销。
5. 本地优先：数据在本地，单文件可备份；多用户可按人隔离。
6. 能接 DSH，后期能接 QQ 官方 Bot。

### 非目标

- 不追求“完美记住一切”。允许模糊、允许归档，不允许编造。
- 不做多模态（图片/语音）记忆，第一版只处理文本。
- 不做云同步、不做多人共享记忆。
- 不修改 LCL_MER 的数据模型和现有行为。

## 1. 总体架构

```
QQ / Web / CLI
      │
      ▼
DSH Agent Session
      │  agent/created      → 会话简报注入
      │  agent/pre-step     → 每轮检索注入
      │  agent/turn-stopping→ 累积对话、抽取
      │  工具调用           → recall / remember / forget
      ▼
lcl-companion 插件
      ├─ 写入管道（LLM 抽取 + 校验 + 去重 + 冲突）
      ├─ 读取管道（FTS5 + 向量 + 时间/重要性加权）
      ├─ 巩固任务（事件 → 章节 → 关系卡）
      ├─ 衰减/归档/强化
      ├─ 调度器（每 10 分钟 tick + 启动补跑）
      └─ Web 管理页（可选，复用 LCL_MER 的 HTTP/UI 模式）
      ▼
~/.dsh/companion/
      ├─ companion.db        SQLite 主库（WAL）
      ├─ journal.jsonl       审计流水
      ├─ raw/                原始对话按月归档（.jsonl.zst）
      ├─ exports/            Markdown 导出（只读，可给 Obsidian）
      └─ config.json         预算、模型、衰减参数
```

## 2. 数据模型

第一版用 SQLite 单库，WAL 模式，`busy_timeout=5000`。

### 2.1 person

| 字段 | 说明 |
|---|---|
| id | `p-0001` |
| platform | `qq` / `web` / `cli` |
| external_id | 平台用户 id（QQ 号等） |
| name / aliases | 显示名、别名（JSON） |
| timezone | 时区 |
| created_at | 创建时间 |

唯一键：`(platform, external_id)`。所有记忆都必须带 `person_id`，这是多用户隔离的根。

### 2.2 memory（统一记忆表）

| 字段 | 说明 |
|---|---|
| id | `m-0001` |
| person_id | 归属人 |
| kind | `episode` / `fact` / `preference` / `boundary` / `promise` / `relationship` / `chapter` |
| level | `0` 原始 / `1` 事件 / `2` 章节 / `3` 自我与关系 |
| text | 正文（事件是摘要，事实是一句话） |
| occurred_at | 事件发生时间 |
| valid_from / valid_to | 事实有效期（职位、住址、关系状态会变） |
| valence / arousal | 情绪效价 / 唤醒度，`-1..1` / `0..1` |
| salience | 重要性 `0..1` |
| confidence | 置信度 `0..1` |
| status | `active` / `superseded` / `archived` / `pending_review` |
| supersedes / superseded_by | 版本链 |
| source_memory_id | 来源事件 id（可追溯） |
| source_turn_ids | 来源对话轮次（JSON 数组，抽取时必须有） |
| pinned | 是否永久保留 |
| access_count / last_access | 召回次数 / 最近召回时间 |
| created_at | 写入时间 |

### 2.3 edge（联想边）

| 字段 | 说明 |
|---|---|
| src_memory_id / dst_memory_id | 两端 |
| relation | `same_topic` / `same_person` / `temporal` / `emotional` / `supports` / `contradicts` |
| weight | 权重 `0..1` |
| created_at | 创建时间 |

第一版只做 `same_topic` 和 `temporal` 两类，够用且便宜。

### 2.4 relationship（关系状态）

| 字段 | 说明 |
|---|---|
| person_id | 归属人 |
| key | `nickname` / `tone` / `boundaries` / `rituals` / `current_chapter` / `trust_notes` |
| value | 文本（关系卡整体 ≤500 token） |
| updated_at | 更新时间 |

关系卡是**替换式**的，不 append。每次更新写 journal，旧版本保留在 journal 里。

### 2.5 open_loop（未完成事项）

| 字段 | 说明 |
|---|---|
| id | `ol-0001` |
| person_id | 归属人 |
| text | 答应过 / 没聊完的事 |
| kind | `promise` / `plan` / `unresolved_topic` / `question` |
| due_at | 预期时间（可空） |
| status | `open` / `closed` / `stale` |
| source_memory_id | 来源事件 |
| created_at / closed_at | 时间 |

### 2.6 recall_log

| 字段 | 说明 |
|---|---|
| id | 自增 |
| person_id | 归属人 |
| memory_id | 被召回的记忆 |
| query | 触发查询 |
| score | 检索得分 |
| injected | 是否真的注入 |
| used | 是否被回复实际使用（二期用 LLM/规则判定） |
| at | 时间 |

用途：强化（access_count）、衰减证据、评测“注入噪音率”。

### 2.7 raw_turn

| 字段 | 说明 |
|---|---|
| id | 自增 |
| person_id / session_id / seq | 归属与会话定位 |
| role / text / at | 消息内容与时间 |

保留 90 天在库内，更早的按月压成 `raw/YYYY-MM.jsonl.zst`，**不删**，除非用户显式要求。

### 2.8 job

`name / next_run_at / last_run_at / state`，用于幂等调度与启动补跑。

### 2.9 索引

- FTS5：`memory_fts(text, summary)`，外接 `memory` 的 rowid。
- 向量（二期）：`sqlite-vec` 的 `vec0` 表，只对 `level>=1` 的记忆做 embedding，1024 维、int8 量化。
- 普通索引：`(person_id, status)`、`(person_id, kind)`、`(occurred_at)`、`(next_run_at)`。

## 3. 写入路径

### 3.1 显式写入

用户说“记住：……”“以后别……”：

1. 直接写入 `memory`，`kind=fact/preference/boundary`，`source_turn_ids` 指向当前轮；
2. 可选 `pinned=1`；
3. 如果与现有条目冲突，标 `pending_review`，不覆盖。

### 3.2 会话结束 / 每 20 轮：LLM 抽取

输入：自上次抽取以来的对话轮次。输出严格 JSON：

```json
{
  "episode": {
    "summary": "一到三句话，只写发生的事",
    "occurred_at": "2026-10-29T21:00:00+08:00",
    "valence": -0.3,
    "arousal": 0.6,
    "salience": 0.8
  },
  "facts": [
    {
      "kind": "preference",
      "text": "用户不喜欢在晚上谈工作",
      "confidence": 0.9,
      "valid_from": "2026-10-29",
      "valid_to": null
    }
  ],
  "open_loops": [
    { "text": "下周要交一份方案", "kind": "plan", "due_at": "2026-11-05" }
  ],
  "closed_loops": ["ol-0003"],
  "relationship_updates": {
    "tone": "最近压力大，需要先接情绪再给建议"
  },
  "boundaries": ["不要主动提体重"]
}
```

校验规则（**硬性**）：

1. 每条 fact 必须有 `source_turn_ids`，没有就丢弃；
2. 不能把“AI 自己说的话”抽成用户事实；
3. 同一 `(subject, predicate)` 的否定/肯定冲突 → 两条都保留，`pending_review`；
4. 抽取结果先落候选表，敏感类型（boundary / promise）默认要人确认；
5. 单轮最多晋升 10 条，防止一次灌爆。

### 3.3 去重与合并

- 完全包含或 Dice ≥ 0.85 → 合并，保留信息更多的一条，累加证据；
- 同主题新版本 → `revise`：旧条 `superseded`，新条版本 +1；
- 矛盾 → `conflict`：两条都保留，等 review。

### 3.4 夜晚巩固

- 当日 episode → 日章节（level 2）；
- 本周章节 → 周摘要；
- 关系卡：根据最近 7 天事件重写，≤500 token；
- 事实合并、过期标记、衰减计算；
- 低价值记忆 `archived`（不删）；pinned 永不归档；
- 所有写操作在一个事务里，失败回滚。

## 4. 读取与注入

### 4.1 会话开始（agent/created）

注入“会话简报”，总量 ≤1,200 token：

| 内容 | 上限 |
|---|---|
| 关系卡（称呼、基调、边界、当前章节） | 250 |
| 未完成事项 | 150 |
| 最近 3 条事件 | 400 |
| 置顶记忆 | 200 |
| 头部说明 | 50 |

### 4.2 每轮（agent/pre-step）

只在**检测到新的用户消息**时检索，工具步不重复检索。

```
query = 当前用户消息 + 最近 2 轮（补上下文）
score = 0.55 * 语义相似 + 0.25 * BM25 + 0.10 * 时间新近 + 0.10 * salience
过滤：score >= 0.55，person_id 匹配，status=active
取 top 3，每条 <=200 token，总计 <=900 token
去重：本会话已注入过的 memory id 不再注入（除非用户明确追问）
```

插件每轮贡献 ≤1,300 token（关系卡 250 + open loops 150 + 检索 900）；加上宿主自己的人格与最近原文，整体请求约 **3–6k token**。

### 4.3 工具

| 工具 | 作用 |
|---|---|
| `companion_recall(query, limit)` | 深度检索，单次 ≤2,000 token |
| `companion_remember(text, kind, pin)` | 显式写入 |
| `companion_forget(id, mode)` | 归档 / 删除（默认 dry-run） |
| `companion_review()` | 待裁决冲突、待确认的敏感记忆 |
| `companion_profile()` | 查看/编辑关系卡与置顶 |

### 4.4 注入形态

`<companion-memory>` 块，`role=user`，`source.kind='lcl-companion'`，与 LCL_MER 一致；抽取时排除这类消息。

## 5. 巩固、遗忘、调度

### 5.1 衰减

```
retention = salience * 0.5^(days / halfLife) * (1 + 0.2 * log(1 + access_count))
halfLife: 闲聊 14 天 / 事件 90 天 / 事实 365 天 / 关系卡与置顶 ∞
```

- 低于 0.1 → `archived`（不删）；
- 被召回 → `access_count++`、`last_access=now`，相当于间隔重复；
- pinned / boundary / promise 永不自动归档；
- 删除只有用户显式操作，且写 `.forgotten.jsonl` 可恢复。

### 5.2 调度

- 插件内 `setInterval` 每 10 分钟 tick；
- 启动时先补跑一次，按 `next_run_at` 只跑一次，不补 N 次；
- 任务：`extract_pending`、`nightly_consolidate`、`weekly_decay`、`daily_export`；
- 单写队列：`better-sqlite3` 同步写 + 事务，避免并发写冲突。

### 5.3 隐私

- 数据本地；
- 抽取默认调 DeepSeek API，意味着**对话片段会发到 API**——需要在配置里明确；
- 可切换本地模型（Ollama + qwen/bge）以完全离线；
- 按 `person_id` 隔离；支持导出和彻底删除某个人。

## 6. 宿主与 QQ 接入

### DSH

- 插件放在独立 profile（如 `companion`），不与 LCL_MER 同 profile 也行；
- 事件：`agent/created`、`agent/pre-step`、`agent/turn-stopping`；
- 不把 `webServer` 设为 required（LCL_MER 的教训），HTTP 面可选。

### QQ

- 只用官方 QQ Bot（`@tencent-connect/dsh-qqbot` 或社区 dsh-qqchat），不挂第三方协议；
- 私聊：`person_id = qq:<uin>`；
- 群聊：群记忆与个人记忆分开；默认仅 @ 响应；不在未授权时学习其他成员；
- 第一版先做私聊，群聊二期。

## 7. 落地阶段与验收

### Phase 0（0.5–1 天）：骨架

- SQLite schema、person、memory、open_loop；
- `agent/created` 注入会话简报；
- `companion_remember` / `companion_recall` 两个工具；
- 手动写入 + 新会话能读到。

**验收**：写一条事实 → 重启 → 新会话注入可见；recall 能查到；不调 LLM。

### Phase 1（2–3 天）：自动抽取 + 每轮召回

- 会话结束 LLM 抽取 episode/fact/open_loop；
- 每轮基于用户消息自动检索 top 3；
- 关系卡、未完成事项；
- 30 条记忆探针评测。

**验收**：
- 第 1 天说的事实，第 3 天能主动提起；
- 探针命中率 ≥90%；
- 编造共同经历 = 0；
- 插件每轮 ≤1.3k token。

### Phase 2（3–5 天）：巩固与遗忘

- 夜间 episode → 章节 → 关系卡；
- 衰减、归档、pin、冲突裁决；
- Web 审核页 / Markdown 导出。

**验收**：
- 模拟 7 天对话后关系卡稳定、无自相矛盾；
- 低价值细节被归档而不是被编造；
- 删除可恢复。

### Phase 3：QQ 与多用户

- 官方 Bot 适配、`person_id` 映射；
- 私聊/群聊隔离、权限；
- 向量检索、bge-m3、sqlite-vec；
- 备份与导出。

## 8. 评测

### 探针集（30 条）

| 类别 | 数量 | 例子 |
|---|---|---|
| 身份 | 5 | “我叫什么？” |
| 偏好 | 5 | “我喜欢喝什么？” |
| 承诺 | 5 | “你答应过我什么？” |
| 旧事件 | 5 | “上周那件事后来怎样了？” |
| 纠正 | 5 | “我上次纠正过你什么？” |
| 边界 | 5 | “什么话题不要提？” |

### 指标

- 探针命中率 ≥90%；
- 虚假记忆率 = 0（不能编造没发生的事）；
- 每轮 token：中位数 2.5–4k，p95 <6k；
- 注入记忆使用率 ≥60%；
- 回复延迟（不含 LLM 生成）增加 <300ms。

## 9. 优点

1. **本地、可控、可备份**：一个 SQLite 文件，隐私边界清楚。
2. **上下文恒定**：无论聊 1 年还是 10 年，每轮记忆块都 ≤1.3k。
3. **可审计、可纠正**：来源、版本、冲突、删除记录齐全。
4. **风险隔离**：不改 LCL_MER，编码记忆不受影响。
5. **多用户就绪**：`person_id` 从第一天就在 schema 里，接 QQ 不用重构。
6. **渐进交付**：Phase 0 一天能跑，Phase 1 三天能验证“被记住的感觉”。
7. **复用已验证的宿主经验**：事件名、注入队列、认证、测试方式都沿用 LCL_MER 踩过的坑。

## 10. 缺点与对策

| 缺点 | 影响 | 对策 |
|---|---|---|
| 比 LCL_MER 多一条 LLM 抽取链路 | 成本、延迟、失败风险 | 异步批处理；抽取用便宜模型；失败保留原文重试 |
| 两套插件、部分代码重复 | 维护成本 | 先复制几百行基础件；稳定后再抽 core |
| 抽取会出错 | 假记忆、误解 | 强制 source_turn_ids；敏感类型人工确认；冲突不覆盖 |
| SQLite 不可手改 | 不如 Markdown 直观 | 导出 Markdown + Web 管理页；Obsidian 只读 |
| 向量/本地 embedding 增加部署复杂度 | 上手门槛 | Phase 1 只用 FTS5，Phase 3 再加向量 |
| 夜间任务只在宿主运行时执行 | 桌面关机就延后 | 启动补跑；记录 `next_run_at`，不补多次 |
| QQ 多用户隐私 | 记忆串人、泄露 | `person_id` 强隔离；群聊默认不学习；官方 Bot |
| 关系建模的伦理风险 | 依赖、操控感 | 透明说明是 AI；可查看/删除记忆；不做成瘾性设计 |
| 不追求完美记忆 | 用户可能觉得“忘了” | 明确“记不清会说记不清”，不编造；重要内容 pin |

## 11. 备选方案对比

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 原地改 LCL_MER | 复用最多 | cwd/项目模型与陪伴模型冲突；回归风险高 | 不推荐 |
| 完全重写 | 模型最干净 | 4–6 周；重踩宿主契约与边界条件 | 不推荐 |
| mem0 / Zep | 上手快，抽取/图谱现成 | 数据/控制权外移；每次写入调 LLM；中文人设控制弱 | 只借鉴机制 |
| 本方案 | 风险低、可控、渐进 | 多一套代码和抽取链路 | **推荐** |

## 12. 待拍板

1. 抽取模型：DeepSeek API（便宜、质量好，但对话片段出网）还是本地 Ollama（完全离线，质量/速度差一些）？
2. 第一版范围：只做私聊，还是一开始就带 QQ 群？
3. 自动写入尺度：事实自动晋升，还是全部进候选区等人确认？（建议 boundary/promise 必须确认）
4. 开发位置：先在 `D:\QoderWorkplace\companion-memory` 做可跑 MVP，稳定后再包成 DSH 插件，还是直接进 DSH profile？

默认建议：**DeepSeek API 抽取 + 私聊优先 + 敏感记忆人工确认 + 先独立 MVP 再插件化**。
