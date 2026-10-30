import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type {
  Intention,
  Memory,
  MemoryKind,
  Message,
  OpenLoop,
  Reflection,
  Session,
  SessionBrief,
  Thought,
} from '../core/types.ts'
import {
  del,
  get,
  post,
  type ApiConfig,
  type DebugResult,
  type DetailResult,
  type ExtractResponse,
  type MindMeta,
  type MindPayload,
  type MindPreview,
  type RememberResult,
  type SessionDetail,
} from './api.ts'

type ToastKind = 'ok' | 'info' | 'error'
type Tab = 'memories' | 'loops' | 'mind' | 'debug'
type StatusFilter = 'active' | 'archived' | 'all'

const MODE_LABEL: Record<string, string> = {
  off: '内心关闭',
  shadow: '影子慢想',
  on: '慢想开启',
}

const THOUGHT_LABEL: Record<string, string> = {
  appraisal: '评估',
  option: '候选',
  critique: '自检',
  reflection: '反思',
  intention_candidate: '意图',
  summary: '慢想',
}

const KIND_LABEL: Record<string, string> = {
  episode: '事件',
  fact: '事实',
  preference: '偏好',
  boundary: '边界',
  promise: '承诺',
  relationship: '关系',
  chapter: '章节',
}

const STATUS_LABEL: Record<string, string> = {
  active: '生效',
  archived: '已归档',
  superseded: '已更替',
  pending_review: '待裁决',
}

const LOOP_LABEL: Record<string, string> = {
  promise: '承诺',
  plan: '计划',
  unresolved_topic: '没聊完',
  question: '问题',
}

function fmt(value: string | null): string {
  if (value === null || value === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function labelOf(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null) return ''
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'string' ? item : ''
}

function KindBadge({ kind }: { kind: string }) {
  return <span className={`badge kind-${kind}`}>{KIND_LABEL[kind] ?? kind}</span>
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status] ?? status}</span>
}

function MessageBubble({ message }: { message: Message }) {
  return (
    <div className={`msg ${message.role}`}>
      <div className="msg-meta">
        <span>{message.role === 'user' ? '你' : 'AI'}</span>
        <span>{fmt(message.createdAt)}</span>
      </div>
      <div className="msg-body">{message.content}</div>
      {message.injectedMemoryIds.length > 0 && (
        <div className="msg-chips">
          {message.injectedMemoryIds.map((id) => (
            <span className="chip" key={id}>
              {id}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function RememberModal({
  text,
  kind,
  pinned,
  onText,
  onKind,
  onPinned,
  onClose,
  onSubmit,
}: {
  text: string
  kind: MemoryKind
  pinned: boolean
  onText: (value: string) => void
  onKind: (value: MemoryKind) => void
  onPinned: (value: boolean) => void
  onClose: () => void
  onSubmit: (event: FormEvent) => void
}) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <form
        className="modal"
        onSubmit={onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h3>记住一条</h3>
          <button type="button" className="icon" onClick={onClose}>
            ×
          </button>
        </header>
        <textarea
          autoFocus
          rows={4}
          placeholder="例如：我喜欢喝冰美式，不加糖。"
          value={text}
          onChange={(event) => onText(event.target.value)}
        />
        <div className="form-row">
          <label>
            类型
            <select value={kind} onChange={(event) => onKind(event.target.value as MemoryKind)}>
              <option value="fact">事实</option>
              <option value="preference">偏好</option>
              <option value="boundary">边界</option>
              <option value="promise">承诺</option>
              <option value="relationship">关系</option>
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(event) => onPinned(event.target.checked)}
            />
            置顶（永远注入）
          </label>
        </div>
        <footer className="modal-foot">
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={text.trim() === ''}>
            写入记忆
          </button>
        </footer>
      </form>
    </div>
  )
}

function DetailModal({
  detail,
  onClose,
  onPin,
  onArchive,
  onRestore,
  onReinforce,
  onDelete,
}: {
  detail: DetailResult
  onClose: () => void
  onPin: (memory: Memory) => void
  onArchive: (memory: Memory) => void
  onRestore: (memory: Memory) => void
  onReinforce: (memory: Memory) => void
  onDelete: (memory: Memory) => void
}) {
  const memory = detail.memory
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title">
            <h3>{memory.id}</h3>
            <KindBadge kind={memory.kind} />
            <StatusBadge status={memory.status} />
            {memory.pinned && <span className="badge pinned">置顶</span>}
          </div>
          <button type="button" className="icon" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="detail-text">{memory.text}</div>

        <div className="meta-grid">
          <div>
            <span>创建</span>
            <strong>{fmt(memory.createdAt)}</strong>
          </div>
          <div>
            <span>发生</span>
            <strong>{fmt(memory.occurredAt)}</strong>
          </div>
          <div>
            <span>重要性</span>
            <strong>{memory.salience.toFixed(2)}</strong>
          </div>
          <div>
            <span>置信度</span>
            <strong>{memory.confidence.toFixed(2)}</strong>
          </div>
          <div>
            <span>强化次数</span>
            <strong>{memory.accessCount}</strong>
          </div>
          <div>
            <span>最近强化</span>
            <strong>{fmt(memory.lastReinforced)}</strong>
          </div>
          <div>
            <span>来源轮次</span>
            <strong>{memory.sourceMessageIds.length}</strong>
          </div>
        </div>

        <section className="source-block">
          <h4>来源对话</h4>
          {detail.sourceMessages.length === 0 && <p className="muted">没有可回溯的来源轮次。</p>}
          {detail.sourceMessages.map((message) => (
            <div className="source-msg" key={message.id}>
              <span className={`badge ${message.role}`}>{message.role === 'user' ? '你' : 'AI'}</span>
              <span className="muted">#{message.id}</span>
              <p>{message.content}</p>
            </div>
          ))}
        </section>

        <footer className="modal-foot">
          <div>
            <button type="button" className="ghost" onClick={() => onReinforce(memory)}>
              确认重要
            </button>
            <button type="button" className="ghost" onClick={() => onPin(memory)}>
              {memory.pinned ? '取消置顶' : '置顶'}
            </button>
            {memory.status === 'archived' ? (
              <button type="button" className="ghost" onClick={() => onRestore(memory)}>
                恢复
              </button>
            ) : (
              <button type="button" className="ghost" onClick={() => onArchive(memory)}>
                归档
              </button>
            )}
            <button type="button" className="danger" onClick={() => onDelete(memory)}>
              彻底删除
            </button>
          </div>
          <button type="button" className="primary" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  )
}

export default function App() {
  const [config, setConfig] = useState<ApiConfig | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [brief, setBrief] = useState<SessionBrief | null>(null)
  const [followUp, setFollowUp] = useState<Intention | null>(null)
  const [memories, setMemories] = useState<Memory[]>([])
  const [loops, setLoops] = useState<OpenLoop[]>([])
  const [tab, setTab] = useState<Tab>('memories')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [kindFilter, setKindFilter] = useState<'all' | MemoryKind>('all')
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<DetailResult | null>(null)
  const [rememberOpen, setRememberOpen] = useState(false)
  const [rememberText, setRememberText] = useState('')
  const [rememberKind, setRememberKind] = useState<MemoryKind>('fact')
  const [rememberPin, setRememberPin] = useState(false)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [injected, setInjected] = useState<{ id: string; kind: string; text: string }[]>([])
  const [debugQuery, setDebugQuery] = useState('')
  const [debugResult, setDebugResult] = useState<DebugResult | null>(null)
  const [debugBlock, setDebugBlock] = useState<string | null>(null)
  const [debugLoading, setDebugLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [loopText, setLoopText] = useState('')
  const [mind, setMind] = useState<MindPayload | null>(null)
  const [mindMeta, setMindMeta] = useState<MindMeta | null>(null)
  const [mindQuery, setMindQuery] = useState('')
  const [mindPreview, setMindPreview] = useState<MindPreview | null>(null)
  const [mindLoading, setMindLoading] = useState(false)
  const [toast, setToast] = useState<{ text: string; kind: ToastKind } | null>(null)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void boot()
  }, [])

  useEffect(() => {
    const element = chatScrollRef.current
    if (element === null) return
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  }, [messages, streamText])

  useEffect(() => {
    if (toast === null) return
    const timer = setTimeout(() => setToast(null), 4200)
    return () => clearTimeout(timer)
  }, [toast])

  function notify(text: string, kind: ToastKind = 'info'): void {
    setToast({ text, kind })
  }

  async function boot(): Promise<void> {
    try {
      const [cfg, sessionList, memoryList, loopList, mindData] = await Promise.all([
        get<ApiConfig>('/api/config'),
        get<{ items: Session[] }>('/api/sessions'),
        get<{ items: Memory[] }>('/api/memories?status=all&limit=300'),
        get<{ items: OpenLoop[] }>('/api/open-loops?status=all'),
        get<MindPayload>('/api/mind'),
      ])
      setConfig(cfg)
      setSessions(sessionList.items)
      setMemories(memoryList.items)
      setLoops(loopList.items)
      setMind(mindData)
      if (sessionList.items.length > 0) {
        await loadSession(sessionList.items[0]!.id)
      }
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  async function loadSession(id: string): Promise<void> {
    const data = await get<SessionDetail>(`/api/sessions/${id}`)
    setSession(data.session)
    setMessages(data.messages)
    setBrief(data.brief)
    setFollowUp(data.followUp ?? null)
  }

  async function refreshAll(): Promise<void> {
    const [sessionList, memoryList, loopList, mindData] = await Promise.all([
      get<{ items: Session[] }>('/api/sessions'),
      get<{ items: Memory[] }>('/api/memories?status=all&limit=300'),
      get<{ items: OpenLoop[] }>('/api/open-loops?status=all'),
      get<MindPayload>('/api/mind'),
    ])
    setSessions(sessionList.items)
    setMemories(memoryList.items)
    setLoops(loopList.items)
    setMind(mindData)
    if (session !== null) {
      const data = await get<{ brief: SessionBrief }>(`/api/sessions/${session.id}/brief`)
      setBrief(data.brief)
    }
  }

  async function selectSession(id: string): Promise<void> {
    if (streaming || id === session?.id) return
    try {
      await loadSession(id)
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  async function newSession(): Promise<void> {
    if (streaming) return
    try {
      const data = await post<{ session: Session; brief: SessionBrief; followUp: Intention | null }>('/api/sessions', {})
      setSessions((prev) => [data.session, ...prev])
      setSession(data.session)
      setMessages([])
      setBrief(data.brief)
      setFollowUp(data.followUp ?? null)
      setInjected([])
      setStreamText('')
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  async function send(): Promise<void> {
    const text = input.trim()
    if (session === null || text === '' || streaming) return
    const sid = session.id
    const temp: Message = {
      id: -Date.now(),
      sessionId: sid,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      injectedMemoryIds: [],
    }
    setMessages((prev) => [...prev, temp])
    setInput('')
    setStreaming(true)
    setStreamText('')
    setInjected([])
    setMindMeta(null)

    let streamError: string | null = null
    try {
      const response = await fetch(`/api/sessions/${sid}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as any
        throw new Error(body?.message ?? `发送失败（${response.status}）`)
      }
      if (response.body === null) throw new Error('没有可读的响应流')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          let event = 'message'
          const dataLines: string[] = []
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
          }
          if (dataLines.length === 0) continue
          let payload: any
          try {
            payload = JSON.parse(dataLines.join('\n'))
          } catch {
            continue
          }
          if (event === 'meta') {
            setInjected(Array.isArray(payload.injected) ? payload.injected : [])
            if (payload.mind !== undefined && payload.mind !== null) {
              setMindMeta(payload.mind as MindMeta)
            }
            if (typeof payload.brief === 'string') {
              setBrief((prev) => (prev === null ? prev : { ...prev, text: payload.brief }))
            }
          } else if (event === 'delta') {
            if (typeof payload.text === 'string') {
              setStreamText((prev) => prev + payload.text)
            }
          } else if (event === 'done') {
            if (payload.autoReflect === true || payload.autoExtract === true) {
              notify('本轮已触发自动反思，稍后可在“内心”里查看', 'info')
            }
          } else if (event === 'error') {
            streamError = String(payload.message ?? '模型请求失败')
          }
        }
      }

      if (streamError !== null) throw new Error(streamError)
      await loadSession(sid)
      await refreshAll()
    } catch (error) {
      notify(errorText(error), 'error')
      try {
        await loadSession(sid)
        await refreshAll()
      } catch {
        /* 保留当前界面 */
      }
    } finally {
      setStreaming(false)
      setStreamText('')
      setInjected([])
    }
  }

  async function submitRemember(event: FormEvent): Promise<void> {
    event.preventDefault()
    const text = rememberText.trim()
    if (text === '') return
    try {
      const result = await post<RememberResult>('/api/memories', {
        text,
        kind: rememberKind,
        pinned: rememberPin,
        sessionId: session?.id,
      })
      setRememberOpen(false)
      setRememberText('')
      setRememberPin(false)
      notify(
        result.duplicate ? `已有类似记忆：${result.memory.id}` : `已写入 ${result.memory.id}`,
        result.duplicate ? 'info' : 'ok',
      )
      await refreshAll()
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  async function runExtract(): Promise<void> {
    if (session === null || busy !== null) return
    setBusy('extract')
    try {
      const data = await post<ExtractResponse>(`/api/sessions/${session.id}/extract`)
      const { result } = data
      const reflection = data.reflectionError
        ? ` · 反思失败：${data.reflectionError}`
        : data.reflection
          ? ` · 反思 ${data.reflection.id}`
          : ''
      notify(
        `抽取完成：事件 ${result.episodeId ?? '无'} · 事实 ${result.factIds.length} · 未完成 ${result.openLoopIds.length}` +
          (result.skipped > 0 ? ` · 跳过 ${result.skipped}` : '') +
          reflection,
        data.reflectionError ? 'info' : 'ok',
      )
      await loadSession(session.id)
      await refreshAll()
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function openDetail(id: string): Promise<void> {
    try {
      const data = await get<DetailResult>(`/api/memories/${id}`)
      setDetail(data)
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  async function togglePin(memory: Memory): Promise<void> {
    try {
      await post(`/api/memories/${memory.id}/pin`, { pinned: !memory.pinned })
      await refreshAll()
      if (detail?.memory.id === memory.id) await openDetail(memory.id)
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  async function archiveMemory(memory: Memory): Promise<void> {
    try {
      await post(`/api/memories/${memory.id}/archive`)
      setDetail(null)
      await refreshAll()
      notify(`已归档 ${memory.id}`, 'ok')
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  async function restoreMemory(memory: Memory): Promise<void> {
    try {
      await post(`/api/memories/${memory.id}/restore`)
      setDetail(null)
      await refreshAll()
      notify(`已恢复 ${memory.id}`, 'ok')
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  async function reinforceMemory(memory: Memory): Promise<void> {
    try {
      await post(`/api/memories/${memory.id}/reinforce`)
      await refreshAll()
      if (detail?.memory.id === memory.id) await openDetail(memory.id)
      notify(`已确认重要：${memory.id}`, 'ok')
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  async function hardDelete(memory: Memory): Promise<void> {
    if (!window.confirm(`彻底删除 ${memory.id}？此操作不可恢复。`)) return
    try {
      await del(`/api/memories/${memory.id}`)
      setDetail(null)
      await refreshAll()
      notify(`已删除 ${memory.id}`, 'ok')
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  async function completeIntention(intention: Intention): Promise<void> {
    try {
      await post(`/api/intentions/${intention.id}/done`)
      await refreshAll()
      notify(`已完成：${intention.text}`, 'ok')
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  async function runMindPreview(): Promise<void> {
    if (mindQuery.trim() === '') return
    setMindLoading(true)
    try {
      const data = await get<MindPreview>(`/api/debug/mind?q=${encodeURIComponent(mindQuery)}`)
      setMindPreview(data)
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setMindLoading(false)
    }
  }

  async function runDebug(): Promise<void> {
    if (debugQuery.trim() === '') return
    setDebugLoading(true)
    try {
      const data = await get<DebugResult>(`/api/debug/recall?q=${encodeURIComponent(debugQuery)}`)
      setDebugResult(data)
      setDebugBlock(null)
    } catch (error) {
      notify(errorText(error), 'error')
    } finally {
      setDebugLoading(false)
    }
  }

  async function showInjection(): Promise<void> {
    try {
      const data = await get<{ memoryBlock: string }>(
        `/api/debug/injection?q=${encodeURIComponent(debugQuery)}`,
      )
      setDebugBlock(data.memoryBlock)
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  async function closeLoop(id: string): Promise<void> {
    try {
      await post(`/api/open-loops/${id}/close`)
      await refreshAll()
      notify(`已关闭 ${id}`, 'ok')
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  async function addLoop(event: FormEvent): Promise<void> {
    event.preventDefault()
    const text = loopText.trim()
    if (text === '') return
    try {
      await post('/api/open-loops', { text, kind: 'plan' })
      setLoopText('')
      await refreshAll()
      notify('已添加未完成事项', 'ok')
    } catch (error) {
      notify(errorText(error), 'error')
    }
  }

  const activeMemories = memories.filter((memory) => memory.status === 'active')
  const archivedMemories = memories.filter((memory) => memory.status === 'archived')
  const openLoops = loops.filter((loop) => loop.status === 'open')
  const filteredMemories = memories
    .filter((memory) => statusFilter === 'all' || memory.status === statusFilter)
    .filter((memory) => kindFilter === 'all' || memory.kind === kindFilter)
    .filter((memory) => {
      const q = search.trim().toLowerCase()
      return q === '' || memory.text.toLowerCase().includes(q) || memory.id.toLowerCase().includes(q)
    })

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">CM</div>
          <div>
            <h1>Companion Memory</h1>
            <p>{config?.phase ?? '正在连接…'}</p>
          </div>
          <span className={`dot ${config?.keyConfigured ? 'ok' : 'warn'}`} title={config?.keyConfigured ? 'API Key 已配置' : 'API Key 未配置'} />
        </div>

        <button type="button" className="new-session" onClick={() => void newSession()} disabled={streaming}>
          + 新会话
        </button>

        <div className="session-list">
          {sessions.length === 0 && <p className="empty-small">还没有会话，点上面新建一个。</p>}
          {sessions.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`session-item ${session?.id === item.id ? 'active' : ''}`}
              onClick={() => void selectSession(item.id)}
              disabled={streaming}
            >
              <span className="session-title">{item.title}</span>
              <span className="session-date">{fmt(item.startedAt)}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-foot">
          <div><span>长期记忆</span><strong>{activeMemories.length}</strong></div>
          <div><span>未完成</span><strong>{openLoops.length}</strong></div>
          <div><span>模型</span><strong>{config?.chatModel ?? '—'}</strong></div>
        </div>
      </aside>

      <main className="chat-panel">
        <header className="chat-head">
          <div>
            <h2>{session?.title ?? '白板记忆'}</h2>
            <p>{session === null ? '新建一个会话开始' : `本会话 ${messages.filter((m) => m.role === 'user').length} 轮用户消息`}</p>
          </div>
          <div className="head-actions">
            <span className="model-pill">
              {config?.chatModel ?? '—'} · {MODE_LABEL[config?.mindMode ?? 'off']}
            </span>
            <button type="button" className="ghost" onClick={() => void runExtract()} disabled={session === null || busy !== null}>
              {busy === 'extract' ? '反思中…' : '结束并反思'}
            </button>
          </div>
        </header>

        {config !== null && !config.keyConfigured && (
          <div className="banner">
            未配置 <code>LLM_API_KEY</code>：复制 <code>.env.example</code> 为 <code>.env</code> 并填入智谱 Key，重启后即可聊天与自动反思。现在仍可手动写入记忆、测试检索。
          </div>
        )}

        <div className="chat-scroll" ref={chatScrollRef}>
          {followUp !== null && messages.length === 0 && !streaming && (
            <div className="followup-card">
              <span className="badge followup">想问你</span>
              <p>{followUp.text}</p>
              <span className="hint">会在你开口时自然提起，不会单独发消息</span>
            </div>
          )}

          {brief !== null && brief.text !== '' && (
            <details className="brief" open={messages.length === 0}>
              <summary>本次会话记忆简报</summary>
              <pre>{brief.text}</pre>
            </details>
          )}

          {session === null && (
            <div className="empty-state">
              <h3>白板记忆</h3>
              <p>还没有会话。新建一个，然后告诉它一件关于你的事。</p>
              <button type="button" className="primary" onClick={() => void newSession()}>
                开始新会话
              </button>
            </div>
          )}

          {session !== null && messages.length === 0 && !streaming && (
            <div className="empty-state">
              <h3>从一句话开始</h3>
              <p>比如：“我叫 …，最近在 …”。也可以点右下角“记住这条”直接写入一条记忆。</p>
            </div>
          )}

          {messages.map((message) => (
            <MessageBubble message={message} key={message.id} />
          ))}

          {streaming && (
            <div className="msg assistant streaming">
              <div className="msg-meta">
                <span>AI</span>
                <span>正在回复…</span>
              </div>
              <div className="msg-body">
                {streamText}
                <span className="cursor">▍</span>
              </div>
              {injected.length > 0 && (
                <div className="msg-chips">
                  {injected.map((item) => (
                    <span className="chip" key={item.id} title={item.text}>
                      {item.id} · {KIND_LABEL[item.kind] ?? item.kind}
                    </span>
                  ))}
                </div>
              )}
              {mindMeta !== null && (
                <div className={`mind-trace ${mindMeta.slow ? 'slow' : 'fast'}`}>
                  {mindMeta.mode === 'off'
                    ? '快速回应'
                    : mindMeta.slow
                      ? mindMeta.plan !== null
                        ? `慢想：${mindMeta.plan.chosen}`
                        : '影子慢想中（不影响回复）'
                      : '快速回应'}
                </div>
              )}
              {mindMeta?.appraisal !== null && mindMeta?.appraisal !== undefined && (
                <div className="mind-trace appraisal">她感觉到：{mindMeta.appraisal.label} · {mindMeta.appraisal.summary}</div>
              )}
              {mindMeta?.followUp !== null && mindMeta?.followUp !== undefined && (
                <div className="mind-trace followup">她本来想问你：{mindMeta.followUp.text}</div>
              )}
            </div>
          )}

        </div>

        <div className="composer">
          <textarea
            rows={2}
            placeholder={session === null ? '先新建一个会话' : '说点什么…（Enter 发送，Shift+Enter 换行）'}
            value={input}
            disabled={session === null || streaming}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <div className="composer-actions">
            <button type="button" className="ghost" onClick={() => setRememberOpen(true)} disabled={session === null}>
              记住这条
            </button>
            <button type="button" className="primary" onClick={() => void send()} disabled={session === null || streaming || input.trim() === ''}>
              发送
            </button>
          </div>
        </div>
      </main>

      <aside className="memory-panel">
        <div className="panel-head">
          <h2>记忆</h2>
          <span className="count">{activeMemories.length}</span>
        </div>

        <div className="tabs">
          <button type="button" className={tab === 'memories' ? 'active' : ''} onClick={() => setTab('memories')}>
            记忆 <em>{activeMemories.length}</em>
          </button>
          <button type="button" className={tab === 'loops' ? 'active' : ''} onClick={() => setTab('loops')}>
            未完成 <em>{openLoops.length}</em>
          </button>
          <button type="button" className={tab === 'mind' ? 'active' : ''} onClick={() => setTab('mind')}>
            内心 <em>{mind?.thoughts.length ?? 0}</em>
          </button>
          <button type="button" className={tab === 'debug' ? 'active' : ''} onClick={() => setTab('debug')}>
            调试
          </button>
        </div>

        {tab === 'memories' && (
          <div className="tab-body">
            <div className="filters">
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="active">生效中</option>
                <option value="archived">已归档</option>
                <option value="all">全部</option>
              </select>
              <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as 'all' | MemoryKind)}>
                <option value="all">全部类型</option>
                <option value="episode">事件</option>
                <option value="fact">事实</option>
                <option value="preference">偏好</option>
                <option value="boundary">边界</option>
                <option value="promise">承诺</option>
              </select>
            </div>
            <input className="search" placeholder="搜索记忆…" value={search} onChange={(event) => setSearch(event.target.value)} />
            {filteredMemories.length === 0 && (
              <p className="empty-small">
                {statusFilter === 'archived' ? '没有归档的记忆。' : '还没有记忆。聊几句并抽取，或手动“记住这条”。'}
              </p>
            )}
            <div className="memory-list">
              {filteredMemories.map((memory) => (
                <button type="button" className="memory-item" key={memory.id} onClick={() => void openDetail(memory.id)}>
                  <div className="memory-line">
                    <KindBadge kind={memory.kind} />
                    {memory.pinned && <span className="badge pinned">置顶</span>}
                    <span className="memory-date">{fmt(memory.occurredAt ?? memory.createdAt)}</span>
                  </div>
                  <p>{memory.text}</p>
                  <div className="memory-foot">
                    <span>{memory.id}</span>
                    <span>{memory.sourceMessageIds.length} 轮来源</span>
                  </div>
                </button>
              ))}
            </div>
            {archivedMemories.length > 0 && statusFilter !== 'archived' && (
              <p className="empty-small">另有 {archivedMemories.length} 条已归档，切换筛选可查看。</p>
            )}
          </div>
        )}

        {tab === 'loops' && (
          <div className="tab-body">
            {openLoops.length === 0 && <p className="empty-small">没有未完成事项。抽取时模型会识别承诺和计划。</p>}
            <div className="loop-list">
              {openLoops.map((loop) => (
                <div className="loop-item" key={loop.id}>
                  <div className="memory-line">
                    <span className={`badge loop-${loop.kind}`}>{LOOP_LABEL[loop.kind] ?? loop.kind}</span>
                    <span className="memory-date">{fmt(loop.createdAt)}</span>
                  </div>
                  <p>{loop.text}</p>
                  <div className="memory-foot">
                    <span>{loop.id}{loop.dueAt ? ` · 到期 ${loop.dueAt.slice(0, 10)}` : ''}</span>
                    <button type="button" className="link" onClick={() => void closeLoop(loop.id)}>
                      关闭
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <form className="inline-form" onSubmit={(event) => void addLoop(event)}>
              <input placeholder="手动添加一条…" value={loopText} onChange={(event) => setLoopText(event.target.value)} />
              <button type="submit" className="ghost" disabled={loopText.trim() === ''}>
                添加
              </button>
            </form>
          </div>
        )}

        {tab === 'mind' && (
          <div className="tab-body">
            {mind === null ? (
              <p className="empty-small">内心层还没启动。重启后会自动创建。</p>
            ) : (
              <>
                <div className="mind-state">
                  <div className="memory-line">
                    <span className={`badge mind-${mind.mode}`}>{MODE_LABEL[mind.mode]}</span>
                    <span className="memory-date">{fmt(mind.state.updatedAt)}</span>
                  </div>
                  <div className="mind-metrics">
                    <span>心情 {mind.state.moodValence.toFixed(2)} / {mind.state.moodArousal.toFixed(2)}</span>
                    <span>能量 {mind.state.energy.toFixed(2)}</span>
                  </div>
                  <p>{mind.state.attention || '还没有明确的关注点'}</p>
                  {mind.state.currentConcern !== '' && (
                    <p className="muted">心里挂着：{mind.state.currentConcern}</p>
                  )}
                  <div className="mind-rel">
                    信任：{mind.relationshipSnapshot.labels.trust} · 熟悉：{mind.relationshipSnapshot.labels.familiarity}
                    {' · '}张力：{mind.relationshipSnapshot.labels.tension}
                    {' · '}最近感觉：{mind.relationshipSnapshot.labels.recentMood}
                    {mind.relationshipSnapshot.tone !== '' ? ` · 基调：${mind.relationshipSnapshot.tone}` : ''}
                  </div>
                </div>

                <h4 className="mind-h">最近的想法</h4>
                {mind.thoughts.length === 0 && <p className="empty-small">慢路径触发后，这里会出现一句摘要。</p>}
                <div className="thought-list">
                  {mind.thoughts.map((thought: Thought) => (
                    <div className="thought-item" key={thought.id}>
                      <div className="memory-line">
                        <span className={`badge thought-${thought.kind}`}>{THOUGHT_LABEL[thought.kind] ?? thought.kind}</span>
                        <span className="memory-date">{fmt(thought.createdAt)}</span>
                      </div>
                      <p>{thought.content}</p>
                      <div className="memory-foot">
                        <span>置信 {thought.confidence.toFixed(2)}</span>
                        <span>{thought.id}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <h4 className="mind-h">最近的反思</h4>
                {mind.reflections.length === 0 && <p className="empty-small">结束一次会话并反思后，这里会出现记录。</p>}
                <div className="reflection-list">
                  {mind.reflections.map((reflection: Reflection) => (
                    <div className="reflection-item" key={reflection.id}>
                      <div className="memory-line">
                        <span className="badge reflection">反思</span>
                        <span className="memory-date">{fmt(reflection.createdAt)}</span>
                      </div>
                      <p>{reflection.whatHappened}</p>
                      {labelOf(reflection.userState, 'label') !== '' && (
                        <div className="memory-foot">
                          <span>她当时：{labelOf(reflection.userState, 'label')}</span>
                        </div>
                      )}
                      {labelOf(reflection.relationshipDelta, 'tone') !== '' && (
                        <div className="memory-foot">
                          <span>关系：{labelOf(reflection.relationshipDelta, 'tone')}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <h4 className="mind-h">想做的事</h4>
                {mind.intentions.length === 0 && <p className="empty-small">还没有主动意图。</p>}
                <div className="intention-list">
                  {mind.intentions.map((intention: Intention) => (
                    <div className="intention-item" key={intention.id}>
                      <div className="memory-line">
                        <span className="badge intention">{intention.kind}</span>
                        {mind.followUps.some((item) => item.id === intention.id) && (
                          <span className="badge followup">待提起</span>
                        )}
                        <span className="memory-date">{intention.dueAt ? intention.dueAt.slice(0, 10) : '未定期'}</span>
                      </div>
                      <p>{intention.text}</p>
                      <div className="memory-foot">
                        <span>{intention.id}</span>
                        <button type="button" className="link" onClick={() => void completeIntention(intention)}>
                          完成
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <h4 className="mind-h">路由预览</h4>
                <p className="hint">只跑本地启发式，不调用模型；看这句话会不会触发慢想。</p>
                <div className="inline-form">
                  <input
                    value={mindQuery}
                    onChange={(event) => setMindQuery(event.target.value)}
                    placeholder="例如：我今天真的很累"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void runMindPreview()
                      }
                    }}
                  />
                  <button type="button" className="ghost" onClick={() => void runMindPreview()} disabled={mindLoading || mindQuery.trim() === ''}>
                    {mindLoading ? '判断中…' : '判断'}
                  </button>
                </div>
                {mindPreview !== null && (
                  <div className="mind-preview-result">
                    <span className={`badge ${mindPreview.slow ? 'slow' : 'fast'}`}>
                      {mindPreview.slow ? '会慢想' : '快速回应'}
                    </span>
                    <span>
                      {mindPreview.percept.emotion.label} · {mindPreview.reasons.join(' / ') || '无明显信号'}
                    </span>
                    <p>
                      意图 {mindPreview.percept.intent} · 歧义 {mindPreview.percept.ambiguity.toFixed(2)} · 风险 {mindPreview.percept.risk}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'debug' && (
          <div className="tab-body">
            <p className="hint">输入一句话，看当前检索会召回哪些记忆、各自得分多少。</p>
            <div className="inline-form">
              <input
                placeholder="例如：我喜欢喝什么？"
                value={debugQuery}
                onChange={(event) => setDebugQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void runDebug()
                  }
                }}
              />
              <button type="button" className="ghost" onClick={() => void runDebug()} disabled={debugLoading || debugQuery.trim() === ''}>
                {debugLoading ? '检索中…' : '检索'}
              </button>
            </div>
            {debugResult !== null && (
              <>
                <p className="hint">模式 {debugResult.mode} · {debugResult.items.length} 条候选</p>
                <div className="debug-list">
                  {debugResult.items.map((item) => (
                    <div className={`debug-item ${item.selected ? 'selected' : ''}`} key={item.id}>
                      <div className="memory-line">
                        <KindBadge kind={item.kind} />
                        {item.selected && <span className="badge injected">会注入</span>}
                        <span className="memory-date">{item.id}</span>
                      </div>
                      <p>{item.text}</p>
                      <div className="scores">
                        <span title={`原始 BM25: ${item.bm25}`}>相关 {item.norm.toFixed(2)}</span>
                        <span>新近 {item.recency.toFixed(2)}</span>
                        <span>重要 {item.salience.toFixed(2)}</span>
                        <span>情绪 {item.emotion.toFixed(2)}</span>
                        <strong>排序分 {item.final.toFixed(2)}</strong>
                      </div>
                    </div>
                  ))}
                </div>
                <button type="button" className="ghost wide" onClick={() => void showInjection()}>
                  查看拼装后的注入块
                </button>
                {debugBlock !== null && <pre className="injection-block">{debugBlock}</pre>}
              </>
            )}
          </div>
        )}
      </aside>

      {rememberOpen && (
        <RememberModal
          text={rememberText}
          kind={rememberKind}
          pinned={rememberPin}
          onText={setRememberText}
          onKind={setRememberKind}
          onPinned={setRememberPin}
          onClose={() => setRememberOpen(false)}
          onSubmit={(event) => void submitRemember(event)}
        />
      )}

      {detail !== null && (
        <DetailModal
          detail={detail}
          onClose={() => setDetail(null)}
          onPin={(memory) => void togglePin(memory)}
          onArchive={(memory) => void archiveMemory(memory)}
          onRestore={(memory) => void restoreMemory(memory)}
          onReinforce={(memory) => void reinforceMemory(memory)}
          onDelete={(memory) => void hardDelete(memory)}
        />
      )}

      {toast !== null && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  )
}
