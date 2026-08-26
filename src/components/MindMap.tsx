// ====== MindMap —— 知识标签思维导图 ======
// 层级：根(📚 知识) → 1级标签 → 2级标签 → 3级知识条目（标题）
// 横向树形布局，SVG 贝塞尔连线，只读展示

interface L2Node {
  name: string
  items: string[]
  summaries?: string[]
}

interface Branch {
  name: string
  children: L2Node[]
}

interface Props {
  root?: string
  branches: Branch[]
  onLeafClick?: (title: string) => void
}

const ROW_H = 26
const NODE_W = { l1: 130, l2: 150, item: 190 }
const GAP_X = { a: 60, b: 60, c: 60 }
const PAD = 16

export default function MindMap({ root = '📚 知识', branches, onLeafClick }: Props) {
  // 布局计算：叶子 = 3级条目（空 l2 按 1 个叶子算）
  const rows: { y: number; level: 1 | 2 | 3; text: string; summary?: string; branchIdx: number; l2Idx: number; itemIdx: number }[] = []
  let y = PAD

  const branchY: number[] = []
  const l2Y: Record<string, number> = {}

  branches.forEach((b, bi) => {
    const l2s = b.children.length > 0 ? b.children : [{ name: '（空）', items: [] }]
    const branchStart = y
    l2s.forEach((l2, li) => {
      const items = l2.items.length > 0 ? l2.items : ['']
      const l2Start = y
      items.forEach((title, ii) => {
        const summary = l2.summaries?.[ii] ?? ''
        rows.push({ y, level: 3, text: title || '（空笔记）', summary: summary.slice(0, 30), branchIdx: bi, l2Idx: li, itemIdx: ii })
        y += ROW_H
      })
      l2Y[`${bi}:${li}`] = (l2Start + y - ROW_H) / 2
      rows.push({ y: l2Y[`${bi}:${li}`], level: 2, text: l2.name + (l2.items.length ? ` (${l2.items.length})` : ''), branchIdx: bi, l2Idx: li, itemIdx: -1 })
      y += 8
    })
    branchY[bi] = (branchStart + y - 8) / 2
    y += 16
  })

  const height = Math.max(240, y + PAD)
  const x1 = PAD
  const x2 = x1 + NODE_W.l1 + GAP_X.a
  const x3 = x2 + NODE_W.l2 + GAP_X.b
  const width = x3 + NODE_W.item + PAD

  const link = (x1e: number, y1: number, x2e: number, y2: number) =>
    `M ${x1e} ${y1} C ${x1e + GAP_X.a / 2} ${y1}, ${x2e - GAP_X.a / 2} ${y2}, ${x2e} ${y2}`

  const rootY = (branchY[0] + branchY[branches.length - 1]) / 2 || height / 2

  return (
    <div className="overflow-x-auto bg-gray-50 dark:bg-[#0f1115] rounded-xl">
      <svg width={width} height={height} className="min-w-full">
        {/* 连线：根→1级 */}
        {branches.map((_, bi) => (
          <path key={`rb${bi}`} d={link(x1 + NODE_W.l1, rootY, x2, branchY[bi])} stroke="#c7d2fe" strokeWidth={1.5} fill="none" />
        ))}
        {/* 连线：1级→2级 */}
        {rows.filter(r => r.level === 2).map(r => {
          const prevL2 = rows.filter(x => x.level === 2 && x.branchIdx === r.branchIdx && x.y < r.y).pop()
          const fromY = prevL2 ? prevL2.y : branchY[r.branchIdx]
          return <path key={`l2${r.y}`} d={link(x2 + NODE_W.l2, fromY, x3, r.y)} stroke="#ddd6fe" strokeWidth={1} fill="none" />
        })}
        {/* 连线：2级→3级 */}
        {rows.filter(r => r.level === 3).map((r, idx) => {
          const l2Row = rows.filter(x => x.level === 2 && x.branchIdx === r.branchIdx && x.l2Idx === r.l2Idx)[0]
          return <path key={`l3${idx}`} d={link(x3 + NODE_W.item, l2Row?.y ?? r.y, x3 + NODE_W.item + 20, r.y)} stroke="#e5e7eb" strokeWidth={1} fill="none" />
        })}

        {/* 根节点 */}
        <rect x={x1} y={rootY - 18} rx={9} width={NODE_W.l1} height={36} fill="#4f46e5" />
        <text x={x1 + NODE_W.l1 / 2} y={rootY} textAnchor="middle" dominantBaseline="central" fill="white" fontSize={13} fontWeight={600}>
          {root}
        </text>

        {/* 1级节点 */}
        {branches.map((b, bi) => (
          <g key={`b${bi}`}>
            <rect x={x2} y={branchY[bi] - 15} rx={7} width={NODE_W.l1} height={30} fill="#eef2ff" stroke="#c7d2fe" />
            <text x={x2 + 10} y={branchY[bi]} textAnchor="start" dominantBaseline="central" fill="#3730a3" fontSize={12} fontWeight={600}>
              {b.name.length > 12 ? b.name.slice(0, 12) + '…' : b.name}
            </text>
          </g>
        ))}

        {/* 2级节点 */}
        {rows.filter(r => r.level === 2).map((r, i) => (
          <g key={`l2n${i}`}>
            <rect x={x3} y={r.y - 12} rx={6} width={NODE_W.l2} height={24} fill="#f5f3ff" stroke="#ddd6fe" />
            <text x={x3 + 8} y={r.y} textAnchor="start" dominantBaseline="central" fill="#6d28d9" fontSize={11}>
              {r.text.length > 16 ? r.text.slice(0, 16) + '…' : r.text}
            </text>
          </g>
        ))}

        {/* 3级条目标题 + 内容摘要（可点击） */}
        {rows.filter(r => r.level === 3 && r.text !== '（空笔记）').map((r, i) => (
          <g key={`l3n${i}`} className={onLeafClick ? 'cursor-pointer' : ''} onClick={() => onLeafClick?.(r.text)}>
            <text x={x3 + NODE_W.item + 26} y={r.y} textAnchor="start" dominantBaseline="central" fill="#475569" fontSize={11}>
              {r.text.length > 24 ? r.text.slice(0, 24) + '…' : r.text}
            </text>
            {r.summary && (
              <text x={x3 + NODE_W.item + 26} y={r.y + 12} textAnchor="start" dominantBaseline="central" fill="#94a3b8" fontSize={9}>
                {r.summary.length > 28 ? r.summary.slice(0, 28) + '…' : r.summary}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  )
}
