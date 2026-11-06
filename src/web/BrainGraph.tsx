import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { get, type BrainGraphPayload, type BrainNode } from './api.ts'

interface SimNode extends BrainNode {
  x: number
  y: number
  vx: number
  vy: number
  fixed: boolean
  radius: number
  color: string
  visible: boolean
  strength: number
}

interface Transform {
  x: number
  y: number
  k: number
}

const KIND_COLORS: Record<string, string> = {
  episode: '#7dd3fc',
  fact: '#a3e635',
  preference: '#f472b6',
  boundary: '#f97316',
  promise: '#c084fc',
  relationship: '#22d3ee',
  chapter: '#60a5fa',
  self_fact: '#fde047',
}

const KIND_LABEL: Record<string, string> = {
  episode: '事件',
  fact: '事实',
  preference: '偏好',
  boundary: '边界',
  promise: '承诺',
  relationship: '关系',
  chapter: '阶段',
  self_fact: '她自己',
}

const LINK_COLORS: Record<string, string> = {
  region: 'rgba(148, 163, 184, 0.22)',
  edge: 'rgba(125, 211, 252, 0.58)',
  recall: 'rgba(163, 230, 53, 0.42)',
  contradiction: 'rgba(248, 113, 113, 0.82)',
  message: 'rgba(59, 130, 246, 0.28)',
  inner: 'rgba(192, 132, 252, 0.34)',
}

const REGION_COLORS: Record<string, string> = {
  input: '#38bdf8',
  working: '#22d3ee',
  retrieval: '#a78bfa',
  expression: '#fbbf24',
  emotion: '#f472b6',
  hippocampus: '#34d399',
  longterm: '#60a5fa',
  introspection: '#c084fc',
  metabolism: '#f97316',
}

const TYPE_COLORS: Record<string, string> = {
  message: '#94a3b8',
  reflection: '#34d399',
  intention: '#c084fc',
  thought: '#22d3ee',
}

const CURVE_DAYS = [0, 7, 14, 30, 60, 90]

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function strengthOf(node: BrainNode): number {
  if (node.type !== 'memory') return 1
  return clamp(node.strength ?? 0.5, 0, 1)
}

function nodeColor(node: BrainNode): string {
  if (node.type === 'region') return REGION_COLORS[node.id] ?? '#e2e8f0'
  if (node.type === 'message') return node.kind === 'user' ? '#60a5fa' : '#fbbf24'
  if (node.type !== 'memory') return TYPE_COLORS[node.type] ?? '#94a3b8'
  return KIND_COLORS[node.kind ?? 'fact'] ?? '#94a3b8'
}

function nodeRadius(node: BrainNode): number {
  if (node.type === 'region') return 22
  if (node.type === 'memory') {
    const pinned = node.pinned ? 3 : 0
    return 5 + strengthOf(node) * 13 + pinned
  }
  if (node.type === 'reflection' || node.type === 'intention') return 9
  return 6
}

export default function BrainGraph({ onClose }: { onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nodesRef = useRef<SimNode[]>([])
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 })
  const fitViewRef = useRef<() => void>(() => {})
  const dragRef = useRef<{ nodeId: string | null; moved: boolean; startX: number; startY: number } | null>(null)

  const [data, setData] = useState<BrainGraphPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'active' | 'archived' | 'all'>('active')
  const [kindFilter, setKindFilter] = useState<'all' | string>('all')
  const [nonce, setNonce] = useState(0)
  const [showMessages, setShowMessages] = useState(false)
  const [showInner, setShowInner] = useState(true)

  const selectedNode = useMemo(() => {
    if (data === null) return null
    return data.nodes.find((node) => node.id === selectedId) ?? null
  }, [data, selectedId])

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({
      messages: showMessages ? '1' : '0',
      inner: showInner ? '1' : '0',
    })
    get<BrainGraphPayload>(`/api/brain?${params.toString()}`)
      .then((payload) => {
        if (!cancelled) setData(payload)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [showMessages, showInner, nonce])

  useEffect(() => {
    if (data === null) return
    const canvas = canvasRef.current
    const container = containerRef.current
    if (canvas === null || container === null) return

    const width = canvas.clientWidth
    const height = canvas.clientHeight

    function initialize() {
      const existing = new Map(nodesRef.current.map((node) => [node.id, node]))
      const centerX = width / 2
      const centerY = height / 2
      const ringRadius = Math.min(width, height) * 0.33
      const regionLayout = new Map(
        data!.regions.map((region, index) => {
          const angle = (index / data!.regions.length) * Math.PI * 2 - Math.PI / 2
          return [
            region.id,
            {
              x: centerX + Math.cos(angle) * ringRadius,
              y: centerY + Math.sin(angle) * ringRadius,
            },
          ]
        }),
      )
      const memoryRegion = new Map<string, string>()
      for (const link of data!.links) {
        if (link.kind === 'region') memoryRegion.set(link.target, link.source)
      }

      const next: SimNode[] = []
      for (const node of data!.nodes) {
        const previous = existing.get(node.id)
        const fixed = node.type === 'region'
        let base = { x: centerX, y: centerY }
        if (fixed) {
          base = regionLayout.get(node.id) ?? base
        } else {
          const region = regionLayout.get(memoryRegion.get(node.id) ?? 'longterm') ?? base
          base = {
            x: region.x + (Math.random() - 0.5) * 140,
            y: region.y + (Math.random() - 0.5) * 140,
          }
        }
        next.push({
          ...node,
          x: previous?.x ?? base.x,
          y: previous?.y ?? base.y,
          vx: previous?.vx ?? 0,
          vy: previous?.vy ?? 0,
          fixed,
          radius: nodeRadius(node),
          color: nodeColor(node),
          visible: true,
          strength: strengthOf(node),
        })
      }
      nodesRef.current = next
    }

    initialize()
    transformRef.current = { x: 0, y: 0, k: 1 }
    const timer = window.setTimeout(() => fitViewRef.current(), 80)
    return () => window.clearTimeout(timer)
  }, [data])

  useEffect(() => {
    const nodes = nodesRef.current
    for (const node of nodes) {
      if (node.type !== 'memory') {
        const q = query.trim()
        node.visible = q === '' || node.label.includes(q) || (node.text ?? '').includes(q)
        continue
      }
      if (statusFilter !== 'all' && node.status !== statusFilter) {
        node.visible = false
        continue
      }
      if (kindFilter !== 'all' && node.kind !== kindFilter) {
        node.visible = false
        continue
      }
      const q = query.trim()
      if (q !== '' && !(node.text ?? '').includes(q) && !node.label.includes(q)) {
        node.visible = false
        continue
      }
      node.visible = true
    }
  }, [data, query, statusFilter, kindFilter])

  useEffect(() => {
    if (data === null) return
    const canvas = canvasRef.current
    const container = containerRef.current
    if (canvas === null || container === null) return
    const context = canvas.getContext('2d')
    if (context === null) return
    const ctx = context

    let raf = 0
    let last = performance.now()

    function resize(): void {
      if (canvas === null) return
      const dpr = window.devicePixelRatio || 1
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      canvas.width = Math.max(1, Math.floor(width * dpr))
      canvas.height = Math.max(1, Math.floor(height * dpr))
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)

    function fitView(): void {
      const visible = nodesRef.current.filter((node) => node.visible)
      if (visible.length === 0 || canvas === null) return
      const padding = 80
      const minX = Math.min(...visible.map((node) => node.x - node.radius))
      const maxX = Math.max(...visible.map((node) => node.x + node.radius))
      const minY = Math.min(...visible.map((node) => node.y - node.radius))
      const maxY = Math.max(...visible.map((node) => node.y + node.radius))
      const boxWidth = Math.max(1, maxX - minX)
      const boxHeight = Math.max(1, maxY - minY)
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      const k = Math.min(2, Math.max(0.35, Math.min((width - padding * 2) / boxWidth, (height - padding * 2) / boxHeight)))
      transformRef.current = {
        k,
        x: width / 2 - ((minX + maxX) / 2) * k,
        y: height / 2 - ((minY + maxY) / 2) * k,
      }
    }
    fitViewRef.current = fitView

    for (let i = 0; i < 90; i += 1) {
      physics()
    }
    fitView()
    draw()

    raf = requestAnimationFrame(frame)

    function physics(): void {
      if (paused) return
      const nodes = nodesRef.current
      const byId = new Map(nodes.map((node) => [node.id, node]))
      const movable = nodes.filter((node) => !node.fixed && node.visible)

      for (const node of movable) {
        node.vx *= 0.86
        node.vy *= 0.86
      }

      for (let i = 0; i < movable.length; i += 1) {
        const a = movable[i]!
        for (let j = i + 1; j < movable.length; j += 1) {
          const b = movable[j]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const distSq = Math.max(120, dx * dx + dy * dy)
          const force = 1600 / distSq
          const dist = Math.sqrt(distSq)
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          a.vx -= fx
          a.vy -= fy
          b.vx += fx
          b.vy += fy
        }
      }

      for (const link of data!.links) {
        const source = byId.get(link.source)
        const target = byId.get(link.target)
        if (source === undefined || target === undefined) continue
        if (!source.visible || !target.visible) continue
        const dx = target.x - source.x
        const dy = target.y - source.y
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy))
        const ideal =
          link.kind === 'region'
            ? 165 - 70 * target.strength
            : link.kind === 'recall'
              ? 150
              : 95
        const strength = link.kind === 'contradiction' ? 0.018 : 0.012 * link.weight
        const force = (dist - ideal) * strength
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        if (!source.fixed) {
          source.vx += fx
          source.vy += fy
        }
        if (!target.fixed) {
          target.vx -= fx
          target.vy -= fy
        }
      }

      const width = canvas!.clientWidth
      const height = canvas!.clientHeight
      for (const node of movable) {
        node.vx += (width / 2 - node.x) * 0.00035
        node.vy += (height / 2 - node.y) * 0.00035
        node.x += node.vx
        node.y += node.vy
      }
    }

    function draw(): void {
      const width = canvas!.clientWidth
      const height = canvas!.clientHeight
      const transform = transformRef.current
      const nodes = nodesRef.current
      const byId = new Map(nodes.map((node) => [node.id, node]))

      ctx.clearRect(0, 0, width, height)
      ctx.save()
      ctx.translate(transform.x, transform.y)
      ctx.scale(transform.k, transform.k)

      for (const link of data!.links) {
        const source = byId.get(link.source)
        const target = byId.get(link.target)
        if (source === undefined || target === undefined) continue
        if (!source.visible || !target.visible) continue
        ctx.save()
        ctx.strokeStyle = LINK_COLORS[link.kind] ?? LINK_COLORS.region
        ctx.lineWidth = link.kind === 'contradiction' ? 2 : link.kind === 'edge' ? 1.6 : 1
        ctx.shadowColor = link.kind === 'edge' ? '#7dd3fc' : link.kind === 'recall' ? '#a3e635' : 'transparent'
        ctx.shadowBlur = link.kind === 'edge' || link.kind === 'recall' ? 8 : 0
        ctx.beginPath()
        ctx.moveTo(source.x, source.y)
        ctx.lineTo(target.x, target.y)
        ctx.stroke()
        ctx.restore()
      }

      for (const node of nodes) {
        if (!node.visible) continue
        const selected = node.id === selectedId
        const fading = node.type === 'memory' && node.strength < 0.35
        ctx.save()
        ctx.shadowColor = node.color
        ctx.shadowBlur =
          node.type === 'region' ? 18 : selected ? 22 : node.type === 'memory' ? 6 + node.strength * 16 : 8
        ctx.fillStyle = node.status === 'archived' ? 'rgba(100, 116, 139, 0.45)' : node.color
        ctx.globalAlpha =
          node.status === 'archived' ? 0.4 : node.type === 'memory' ? 0.3 + node.strength * 0.7 : 1
        ctx.beginPath()
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2)
        ctx.fill()
        if (node.type === 'region') {
          ctx.shadowBlur = 0
          ctx.strokeStyle = 'rgba(248, 250, 252, 0.35)'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(node.x, node.y, node.radius + 7, 0, Math.PI * 2)
          ctx.stroke()
        }
        if (node.type === 'memory') {
          ctx.shadowBlur = 0
          ctx.globalAlpha = 1
          const ring = node.radius + 5
          ctx.strokeStyle = fading ? 'rgba(148, 163, 184, 0.22)' : 'rgba(148, 163, 184, 0.14)'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(node.x, node.y, ring, 0, Math.PI * 2)
          ctx.stroke()
          ctx.strokeStyle = node.color
          ctx.globalAlpha = fading ? 0.45 : 0.85
          ctx.beginPath()
          ctx.arc(node.x, node.y, ring, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * node.strength)
          ctx.stroke()
          const marks = Math.min(6, node.accessCount ?? 0)
          if (marks > 0) {
            ctx.globalAlpha = 0.9
            ctx.fillStyle = '#f8fafc'
            for (let i = 0; i < marks; i += 1) {
              const angle = -Math.PI / 2 + (i / 6) * Math.PI * 2
              ctx.beginPath()
              ctx.arc(node.x + Math.cos(angle) * (ring + 5), node.y + Math.sin(angle) * (ring + 5), 1.8, 0, Math.PI * 2)
              ctx.fill()
            }
          }
          if (node.pinned) {
            ctx.globalAlpha = 0.75
            ctx.strokeStyle = '#fbbf24'
            ctx.lineWidth = 1.2
            ctx.setLineDash([3, 3])
            ctx.beginPath()
            ctx.arc(node.x, node.y, ring + 10, 0, Math.PI * 2)
            ctx.stroke()
            ctx.setLineDash([])
          }
          ctx.globalAlpha = 1
        }
        if (selected) {
          ctx.shadowBlur = 0
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(node.x, node.y, node.radius + 5, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.restore()

        if (node.type === 'region' || selected || transform.k > 0.72) {
          ctx.fillStyle = node.type === 'region' ? '#f8fafc' : 'rgba(226, 232, 240, 0.82)'
          ctx.font = node.type === 'region' ? '600 13px system-ui, sans-serif' : '11px system-ui, sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText(node.label, node.x, node.y + node.radius + 18)
        }
      }

      ctx.restore()
    }

    function frame(now: number): void {
      const dt = Math.min(32, now - last)
      last = now
      physics()
      draw()
      void dt
      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [data, paused, selectedId])

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function screenToWorld(event: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const transform = transformRef.current
    return {
      x: (event.clientX - rect.left - transform.x) / transform.k,
      y: (event.clientY - rect.top - transform.y) / transform.k,
    }
  }

  function hitNode(point: { x: number; y: number }): SimNode | null {
    for (let i = nodesRef.current.length - 1; i >= 0; i -= 1) {
      const node = nodesRef.current[i]!
      if (!node.visible) continue
      const dx = point.x - node.x
      const dy = point.y - node.y
      if (dx * dx + dy * dy <= (node.radius + 6) ** 2) return node
    }
    return null
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = screenToWorld(event)
    const node = hitNode(point)
    dragRef.current = {
      nodeId: node?.id ?? null,
      moved: false,
      startX: event.clientX,
      startY: event.clientY,
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current
    if (drag === null) return
    if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > 4) {
      drag.moved = true
    }
    const point = screenToWorld(event)
    if (drag.nodeId !== null) {
      const node = nodesRef.current.find((item) => item.id === drag.nodeId)
      if (node !== undefined && !node.fixed) {
        node.x = point.x
        node.y = point.y
        node.vx = 0
        node.vy = 0
      }
    } else {
      const transform = transformRef.current
      transform.x += event.movementX
      transform.y += event.movementY
    }
  }

  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current
    dragRef.current = null
    if (drag === null || drag.moved) return
    const point = screenToWorld(event)
    const node = hitNode(point)
    setSelectedId(node?.id ?? null)
  }

  function onWheel(event: ReactWheelEvent<HTMLCanvasElement>): void {
    const canvas = canvasRef.current
    if (canvas === null) return
    const rect = canvas.getBoundingClientRect()
    const transform = transformRef.current
    const mouseX = event.clientX - rect.left
    const mouseY = event.clientY - rect.top
    const factor = event.deltaY < 0 ? 1.12 : 0.89
    const nextK = Math.min(3, Math.max(0.35, transform.k * factor))
    transform.x = mouseX - ((mouseX - transform.x) / transform.k) * nextK
    transform.y = mouseY - ((mouseY - transform.y) / transform.k) * nextK
    transform.k = nextK
  }

  return (
    <div className="graph-modal">
      <div className="graph-shell">
        <header className="graph-header">
          <div>
            <h2>记忆脑图</h2>
            <p>一条记忆一个节点，大小和外圈表示还剩多少印象</p>
          </div>
          <div className="graph-actions">
            <button type="button" className="ghost" onClick={() => setPaused((value) => !value)}>
              {paused ? '继续布局' : '暂停布局'}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setError(null)
                setNonce((value) => value + 1)
              }}
            >
              重新读取
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => fitViewRef.current()}
            >
              重置视角
            </button>
            <button type="button" className="primary" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>

        {error !== null && <div className="banner">{error}</div>}

        <div className="graph-toolbar">
          <input
            className="search"
            placeholder="搜索记忆…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'active' | 'archived' | 'all')}>
            <option value="active">生效中</option>
            <option value="archived">已归档</option>
            <option value="all">全部</option>
          </select>
          <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
            <option value="all">全部类型</option>
            <option value="episode">事件</option>
            <option value="fact">事实</option>
            <option value="preference">偏好</option>
            <option value="boundary">边界</option>
            <option value="promise">承诺</option>
            <option value="chapter">阶段</option>
            <option value="self_fact">她自己</option>
          </select>
          <label className="graph-check">
            <input type="checkbox" checked={showMessages} onChange={(event) => setShowMessages(event.target.checked)} />
            显示消息
          </label>
          <label className="graph-check">
            <input type="checkbox" checked={showInner} onChange={(event) => setShowInner(event.target.checked)} />
            显示内心
          </label>
          <div className="graph-stats">
            {data === null ? (
              <span>加载中…</span>
            ) : (
              <span>
                节点 {data.stats.nodes} · 连线 {data.stats.links} · 记忆 {data.stats.activeMemories} 生效 /{' '}
                {data.stats.archivedMemories} 归档 · 联想 {data.stats.edges} · 内心{' '}
                {data.stats.thoughts + data.stats.reflections + data.stats.intentions}
              </span>
            )}
          </div>
        </div>

        <div className="graph-body" ref={containerRef}>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onWheel={onWheel}
          />

          <aside className="graph-legend">
            <h3>脑区</h3>
            {data?.regions.map((region) => (
              <div className="legend-item" key={region.id}>
                <strong>{region.label}</strong>
                <span>{region.description}</span>
              </div>
            ))}
            <h3>图例</h3>
            <div className="legend-colors">
              <span><i className="dot" style={{ background: KIND_COLORS.episode }} />事件</span>
              <span><i className="dot" style={{ background: KIND_COLORS.fact }} />事实</span>
              <span><i className="dot" style={{ background: KIND_COLORS.preference }} />偏好</span>
              <span><i className="dot" style={{ background: KIND_COLORS.boundary }} />边界</span>
              <span><i className="dot" style={{ background: KIND_COLORS.promise }} />承诺</span>
              <span><i className="dot" style={{ background: KIND_COLORS.chapter }} />阶段</span>
              <span><i className="dot" style={{ background: KIND_COLORS.self_fact }} />她自己</span>
              <span><i className="dot" style={{ background: '#60a5fa' }} />用户消息</span>
              <span><i className="dot" style={{ background: '#fbbf24' }} />AI 回复</span>
              <span><i className="dot" style={{ background: TYPE_COLORS.reflection }} />反思</span>
              <span><i className="dot" style={{ background: TYPE_COLORS.intention }} />意图</span>
              <span><i className="dot" style={{ background: TYPE_COLORS.thought }} />想法</span>
            </div>
            <h3>遗忘与加深</h3>
            <div className="legend-notes">
              <p>节点越大越亮：记忆强度越高，越不容易忘</p>
              <p>外圈实线弧：还剩多少印象，弧越短衰减越多</p>
              <p>圈外白点：被强化过的次数，最多显示 6 个</p>
              <p>黄色虚线圈：置顶记忆，不参与自动归档</p>
              <p>灰色半透明：已归档，可调到“全部”查看</p>
            </div>
          </aside>

          <aside className="graph-details">
            {selectedNode === null ? (
              <p>点击节点查看详情。拖拽移动，滚轮缩放，背景拖动平移。</p>
            ) : selectedNode.type === 'region' ? (
              <div>
                <h3>{selectedNode.label}</h3>
                <p>{selectedNode.description}</p>
                <div className="detail-list">
                  <span>脑区节点</span>
                  <span>{data?.regions.find((region) => region.id === selectedNode.id)?.id ?? selectedNode.id}</span>
                </div>
              </div>
            ) : (
              <div>
                <h3>{selectedNode.label}</h3>
                <p>{selectedNode.text ?? selectedNode.description}</p>
                {selectedNode.type === 'memory' && <MemoryStrength node={selectedNode} color={nodeColor(selectedNode)} />}
                <div className="detail-list">
                  <span>类型</span>
                  <span>{selectedNode.type}</span>
                  <span>ID</span>
                  <span>{selectedNode.id}</span>
                  {selectedNode.kind ? (
                    <>
                      <span>子类型</span>
                      <span>{selectedNode.kind}</span>
                    </>
                  ) : null}
                  {selectedNode.status ? (
                    <>
                      <span>状态</span>
                      <span>{selectedNode.status === 'active' ? '生效' : selectedNode.status === 'archived' ? '已归档' : selectedNode.status}</span>
                    </>
                  ) : null}
                  {selectedNode.salience !== undefined ? (
                    <>
                      <span>显著性</span>
                      <span>{selectedNode.salience.toFixed(2)}</span>
                    </>
                  ) : null}
                  {selectedNode.confidence !== undefined ? (
                    <>
                      <span>置信度</span>
                      <span>{selectedNode.confidence.toFixed(2)}</span>
                    </>
                  ) : null}
                  {selectedNode.pinned !== undefined ? (
                    <>
                      <span>置顶</span>
                      <span>{selectedNode.pinned ? '是' : '否'}</span>
                    </>
                  ) : null}
                  {selectedNode.unresolved !== undefined ? (
                    <>
                      <span>未解决</span>
                      <span>{selectedNode.unresolved ? '是' : '否'}</span>
                    </>
                  ) : null}
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}

function MemoryStrength({ node, color }: { node: BrainNode; color: string }): ReactElement {
  const curve = node.curve ?? []
  const strength = node.strength ?? 0
  const peak = Math.max(1, ...curve)
  const points = curve
    .map((value, index) => {
      const x = 8 + (index / Math.max(1, curve.length - 1)) * 204
      const y = 54 - (value / peak) * 44
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <div className="memory-strength">
      <div className="strength-head">
        <span>当前记忆强度</span>
        <strong>{Math.round(strength * 100)}%</strong>
      </div>
      <div className="strength-bar">
        <i style={{ width: `${clamp(strength, 0, 1) * 100}%`, background: color }} />
      </div>
      {curve.length > 1 && (
        <>
          <svg className="strength-curve" viewBox="0 0 220 60" role="img" aria-label="如果不强化，这条记忆的遗忘曲线">
            <line x1="8" y1="54" x2="212" y2="54" stroke="rgba(148,163,184,0.35)" strokeWidth="1" />
            <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
          </svg>
          <p className="curve-caption">
            {CURVE_DAYS.map((day, index) => {
              const value = Math.round(((curve[index] ?? 0) / peak) * 100)
              return `${day === 0 ? '现在' : `+${day} 天`} ${value}%`
            }).join(' · ')}
          </p>
          <p className="curve-note">按现在的强度往回推：如果不再被想起或提到，印象会掉到这些水平</p>
        </>
      )}
      <div className="detail-list">
        <span>强化次数</span>
        <span>{node.accessCount ?? 0} 次</span>
        <span>最后强化</span>
        <span>{node.lastReinforced ? `${node.lastReinforced.slice(0, 10)} 已强化` : '从未主动强化，只靠新近度'}</span>
        <span>距今</span>
        <span>{node.ageDays ?? 0} 天</span>
        <span>半衰期</span>
        <span>{node.halfLifeDays ?? 90} 天{node.kind === 'episode' ? '（事件忘得快）' : '（长期事实）'}</span>
      </div>
    </div>
  )
}
