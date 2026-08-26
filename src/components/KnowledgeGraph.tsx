// ====== KnowledgeGraph — SVG 交互式知识图谱 ======
// 从 Relation 数据实时生成，不创建第二套知识数据库

import { useState, useEffect, useRef, useCallback } from 'react'
import { ZoomIn, ZoomOut, Maximize2, RefreshCw, Network } from 'lucide-react'
import { relationQueryService, type GraphData, type GraphNode } from '../services/relationQueryService'
import type { ObjectType } from '../types'

// ====== 类型标签和颜色 ======

const typeColors: Record<string, string> = {
  goal: '#3b82f6',
  project: '#8b5cf6',
  task: '#10b981',
  customer: '#f59e0b',
  opportunity: '#ec4899',
  order: '#ef4444',
  communication: '#06b6d4',
  knowledge: '#6366f1',
  inspiration: '#eab308',
  question: '#f97316',
  research: '#14b8a6',
  experiment: '#a855f7',
  decision: '#64748b',
  review: '#0ea5e9',
  process: '#84cc16',
}

const typeLabels: Record<string, string> = {
  goal: '目标', project: '项目', task: '任务', customer: '客户',
  opportunity: '商机', order: '订单', communication: '沟通',
  knowledge: '知识', inspiration: '灵感', question: '问题',
  research: '研究', experiment: '实验', decision: '决策',
  review: '复盘', process: '流程',
}

// ====== 力导向布局（简化版）======

interface PositionedNode extends GraphNode {
  x: number
  y: number
  vx: number
  vy: number
}

export function applyForceLayout(
  data: GraphData,
  width: number,
  height: number,
  iterations = 100
): PositionedNode[] {
  // 确定性圆环初始布局：比随机散点收敛更稳定（同数据每次渲染布局一致），
  // 且初始间距更大，力导向迭代后节点不易重叠
  const radius = Math.min(width, height) / 3
  const cx = width / 2
  const cy = height / 2
  const nodes: PositionedNode[] = data.nodes.map((n, i) => {
    const angle = (i / Math.max(1, data.nodes.length)) * Math.PI * 2 - Math.PI / 2
    return {
      ...n,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    }
  })

  const nodeMap = new Map(nodes.map(n => [n.id, n]))

  for (let iter = 0; iter < iterations; iter++) {
    // 斥力（所有节点之间）
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x
        const dy = nodes[i].y - nodes[j].y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = 3000 / (dist * dist)
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        nodes[i].vx += fx
        nodes[i].vy += fy
        nodes[j].vx -= fx
        nodes[j].vy -= fy
      }
    }

    // 引力（有边的节点之间）
    for (const edge of data.edges) {
      const s = nodeMap.get(edge.source)
      const t = nodeMap.get(edge.target)
      if (!s || !t) continue
      const dx = t.x - s.x
      const dy = t.y - s.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const force = (dist - 120) * 0.05
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      s.vx += fx
      s.vy += fy
      t.vx -= fx
      t.vy -= fy
    }

    // 中心引力
    for (const node of nodes) {
      node.vx += (width / 2 - node.x) * 0.01
      node.vy += (height / 2 - node.y) * 0.01
    }

    // 更新位置
    for (const node of nodes) {
      node.x += node.vx * 0.1
      node.y += node.vy * 0.1
      node.vx *= 0.8
      node.vy *= 0.8
      // 边界
      node.x = Math.max(40, Math.min(width - 40, node.x))
      node.y = Math.max(40, Math.min(height - 40, node.y))
    }
  }

  return nodes
}

// ====== 组件 ======

interface KnowledgeGraphProps {
  centerId?: string
  depth?: number
  height?: number
  onNodeClick?: (node: GraphNode) => void
}

export default function KnowledgeGraph({
  centerId,
  depth = 1,
  height = 500,
  onNodeClick,
}: KnowledgeGraphProps) {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], edges: [] })
  const [positioned, setPositioned] = useState<PositionedNode[]>([])
  const [loading, setLoading] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const isDragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0 })

  const width = 800

  // 加载图谱数据
  const loadGraph = useCallback(async () => {
    setLoading(true)
    try {
      let data: GraphData
      if (centerId) {
        data = await relationQueryService.getNeighborhood('knowledge', centerId, depth)
      } else {
        data = await relationQueryService.getKnowledgeGraph(undefined, depth)
      }
      setGraphData(data)
      // 计算布局
      const positioned = applyForceLayout(data, width, height)
      setPositioned(positioned)
    } catch (e) {
      console.warn('[KnowledgeGraph] 加载失败:', e)
    } finally {
      setLoading(false)
    }
  }, [centerId, depth, height])

  useEffect(() => {
    loadGraph()
  }, [loadGraph])

  // 鼠标交互
  const handleMouseDown = (e: React.MouseEvent) => {
    isDragging.current = true
    dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging.current) return
    setPan({
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y,
    })
  }

  const handleMouseUp = () => {
    isDragging.current = false
  }

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    setZoom(z => Math.max(0.3, Math.min(3, z + delta)))
  }

  const handleNodeClick = (node: PositionedNode) => {
    setSelectedNode(node.id)
    if (onNodeClick) onNodeClick(node)
  }

  const resetView = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setSelectedNode(null)
  }

  // 节点位置映射（含缩放和平移）
  const transform = (x: number, y: number) => ({
    cx: x * zoom + pan.x,
    cy: y * zoom + pan.y,
  })

  const nodeMap = new Map(positioned.map(n => [n.id, n]))
  const selectedNodeData = selectedNode ? nodeMap.get(selectedNode) : null

  return (
    <div className="relative bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      {/* 工具栏 */}
      <div className="absolute top-3 left-3 z-10 flex gap-1">
        <button
          onClick={() => setZoom(z => Math.min(3, z + 0.2))}
          className="p-2 bg-white border border-gray-200 rounded-lg shadow-sm hover:bg-gray-50 text-gray-500"
          title="放大"
        >
          <ZoomIn size={16} />
        </button>
        <button
          onClick={() => setZoom(z => Math.max(0.3, z - 0.2))}
          className="p-2 bg-white border border-gray-200 rounded-lg shadow-sm hover:bg-gray-50 text-gray-500"
          title="缩小"
        >
          <ZoomOut size={16} />
        </button>
        <button
          onClick={resetView}
          className="p-2 bg-white border border-gray-200 rounded-lg shadow-sm hover:bg-gray-50 text-gray-500"
          title="重置视图"
        >
          <Maximize2 size={16} />
        </button>
        <button
          onClick={loadGraph}
          className="p-2 bg-white border border-gray-200 rounded-lg shadow-sm hover:bg-gray-50 text-gray-500"
          title="刷新"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      {/* 统计信息 */}
      <div className="absolute top-3 right-3 z-10 flex gap-2">
        <span className="px-2 py-1 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-500 shadow-sm">
          {graphData.nodes.length} 节点
        </span>
        <span className="px-2 py-1 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-500 shadow-sm">
          {graphData.edges.length} 关系
        </span>
      </div>

      {/* SVG 图谱 */}
      <svg
        ref={svgRef}
        width="100%"
        height={height}
        className="cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        {/* 背景 */}
        <rect width="100%" height="100%" fill="#fafafa" />

        {loading ? (
          <text x="50%" y="50%" textAnchor="middle" fill="#999" fontSize="14">
            加载中...
          </text>
        ) : graphData.nodes.length === 0 ? (
          <text x="50%" y="50%" textAnchor="middle" fill="#999" fontSize="14">
            暂无知识关系数据
          </text>
        ) : (
          <>
            {/* 边 */}
            <g>
              {graphData.edges.map(edge => {
                const s = nodeMap.get(edge.source)
                const t = nodeMap.get(edge.target)
                if (!s || !t) return null
                const sp = transform(s.x, s.y)
                const tp = transform(t.x, t.y)
                const isHighlighted =
                  selectedNode === edge.source || selectedNode === edge.target ||
                  hoveredNode === edge.source || hoveredNode === edge.target

                return (
                  <g key={edge.id}>
                    <line
                      x1={sp.cx} y1={sp.cy}
                      x2={tp.cx} y2={tp.cy}
                      stroke={isHighlighted ? '#6366f1' : '#d1d5db'}
                      strokeWidth={isHighlighted ? 2 : 1}
                      strokeDasharray={edge.direction === 'incoming' ? '4 2' : 'none'}
                    />
                    {isHighlighted && (
                      <text
                        x={(sp.cx + tp.cx) / 2}
                        y={(sp.cy + tp.cy) / 2 - 4}
                        textAnchor="middle"
                        fill="#6366f1"
                        fontSize="9"
                        className="pointer-events-none"
                      >
                        {edge.label}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>

            {/* 节点 */}
            <g>
              {positioned.map(node => {
                const pos = transform(node.x, node.y)
                const isSelected = selectedNode === node.id
                const isHovered = hoveredNode === node.id
                const color = typeColors[node.type] || '#999'
                const radius = 12 + Math.min(node.degree * 3, 12)

                return (
                  <g
                    key={node.id}
                    transform={`translate(${pos.cx}, ${pos.cy})`}
                    className="cursor-pointer"
                    onClick={() => handleNodeClick(node)}
                    onMouseEnter={() => setHoveredNode(node.id)}
                    onMouseLeave={() => setHoveredNode(null)}
                  >
                    {/* 节点光圈 */}
                    {(isSelected || isHovered) && (
                      <circle r={radius + 6} fill={color} opacity={0.15} />
                    )}
                    {/* 节点圆 */}
                    <circle
                      r={radius}
                      fill={color}
                      opacity={isSelected ? 1 : 0.8}
                      stroke="white"
                      strokeWidth={2}
                    />
                    {/* Emoji */}
                    <text
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={radius}
                      className="pointer-events-none select-none"
                    >
                      {node.emoji}
                    </text>
                    {/* 标题 */}
                    <text
                      y={radius + 14}
                      textAnchor="middle"
                      fill="#374151"
                      fontSize="11"
                      fontWeight={isSelected ? 600 : 400}
                      className="pointer-events-none select-none"
                    >
                      {node.title.length > 12 ? node.title.slice(0, 12) + '…' : node.title}
                    </text>
                    {/* 度数 */}
                    {node.degree > 0 && (
                      <text
                        x={radius - 2}
                        y={-radius + 2}
                        textAnchor="middle"
                        fill="#9ca3af"
                        fontSize="8"
                        className="pointer-events-none"
                      >
                        {node.degree}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          </>
        )}
      </svg>

      {/* 选中节点详情 */}
      {selectedNodeData && (
        <div className="absolute bottom-3 left-3 right-3 z-10 bg-white border border-gray-200 rounded-xl p-3 shadow-lg">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{selectedNodeData.emoji}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-800 truncate">
                {selectedNodeData.title}
              </div>
              <div className="text-xs text-gray-400">
                {typeLabels[selectedNodeData.type] || selectedNodeData.type} · 度数 {selectedNodeData.degree}
              </div>
            </div>
            {onNodeClick && (
              <button
                onClick={() => onNodeClick(selectedNodeData)}
                className="px-3 py-1 bg-blue-50 text-blue-600 rounded-lg text-xs hover:bg-blue-100"
              >
                查看详情
              </button>
            )}
          </div>
        </div>
      )}

      {/* 图例 */}
      {!loading && graphData.nodes.length > 0 && (
        <div className="absolute bottom-3 right-3 z-10 bg-white/90 border border-gray-200 rounded-lg p-2 shadow-sm">
          <div className="text-[10px] text-gray-400 mb-1">类型</div>
          <div className="flex flex-wrap gap-1.5 max-w-[200px]">
            {Array.from(new Set(graphData.nodes.map(n => n.type))).map(type => (
              <div key={type} className="flex items-center gap-1">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: typeColors[type] || '#999' }}
                />
                <span className="text-[10px] text-gray-500">
                  {typeLabels[type] || type}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
