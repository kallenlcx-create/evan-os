// ====== AgentsPage — Agent 运行台 ======
// 展示 4 个 Agent 的标准结构（身份/目标/指令/Context/Memory/Tools/Permissions/Triggers/Actions/ApprovalPolicy）
// 支持手动运行、查看运行记录、处理审批队列（L2 确认 / L3 批准+显式执行）

import { useState, useEffect, useCallback } from 'react'
import {
  Bot, Play, Check, X, ChevronDown, ChevronRight,
  ShieldAlert, ShieldCheck, History, Zap,
} from 'lucide-react'
import { agentRuntime } from '../services/agentRuntime'
import '../services/agents' // 触发注册
import type { AgentDefinition, AgentRunRecord, ApprovalRecord } from '../types'

const levelBadge: Record<string, { label: string; cls: string }> = {
  L1_auto: { label: 'L1 自动', cls: 'bg-green-100 text-green-700' },
  L2_suggest: { label: 'L2 建议', cls: 'bg-amber-100 text-amber-700' },
  L3_approval: { label: 'L3 人工批准', cls: 'bg-red-100 text-red-700' },
}

const triggerLabel: Record<string, string> = {
  manual: '手动', on_event: '事件触发', schedule: '定时',
}

function AgentCard({ def, onRun }: { def: AgentDefinition; onRun: (id: string) => void }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="p-4 flex items-start gap-3">
        <span className="text-3xl">{def.emoji}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold text-gray-800">{def.name}</h3>
            {def.triggers.map((t, i) => (
              <span key={i} className="px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded text-[10px]">
                {triggerLabel[t.type]}{t.eventType ? `·${t.eventType}` : ''}
              </span>
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-0.5">{def.role}</p>
          <p className="text-xs text-gray-400 mt-0.5">🎯 {def.goal}</p>
        </div>
        <button
          onClick={() => onRun(def.id)}
          className="flex items-center gap-1 px-3 py-1.5 bg-blue-500 text-white rounded-lg text-xs font-medium hover:bg-blue-600 shrink-0"
        >
          <Play size={13} /> 运行
        </button>
      </div>

      {/* 权限徽章行 */}
      <div className="px-4 pb-3 flex flex-wrap gap-1.5">
        {def.actions.map((a, i) => {
          const lvl =
            a.type === 'external_call' || a.type === 'destructive' ? 'L3_approval' :
            ['inbox_annotate', 'relation_suggest', 'summary_generate'].includes(a.type) ? 'L1_auto' :
            'L2_suggest'
          const meta = levelBadge[lvl]
          return (
            <span key={i} className={`px-2 py-0.5 rounded-md text-[10px] font-medium ${meta.cls}`}>
              {a.description}
            </span>
          )
        })}
      </div>

      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-center gap-1 py-2 border-t border-gray-100 text-[11px] text-gray-400 hover:text-gray-600"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        标准结构详情
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-2 text-xs text-gray-600 bg-gray-50/60 pt-2">
          <Section title="指令"><ul className="list-disc ml-4 space-y-0.5">{def.instructions.map((s, i) => <li key={i}>{s}</li>)}</ul></Section>
          <Section title={`Tools (${def.tools.length})`}>
            <div className="flex flex-wrap gap-1">{def.tools.map(t => (
              <code key={t} className="px-1.5 py-0.5 bg-white border rounded text-[10px]">{t}</code>
            ))}</div>
          </Section>
          <Section title="Context / Memory">
            记忆注入：{def.contextPolicy.includeMemories ? '开' : '关'} · 目标注入：{def.contextPolicy.includeGoals ? '开' : '关'} ·
            Memory 范围：{def.memoryScope.length ? def.memoryScope.join(',') : '全部'} · 事件窗口：{def.contextPolicy.recentEventsLimit}
          </Section>
          <Section title="Approval Policy">
            自动执行 ≤ {levelBadge[def.approvalPolicy.autoExecuteBelow].label}
            {def.approvalPolicy.requireHumanConfirm.length > 0 && `；强制人工确认：${def.approvalPolicy.requireHumanConfirm.join('、')}`}
          </Section>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">{title}</div>
      <div>{children}</div>
    </div>
  )
}

export default function AgentsPage() {
  const [defs, setDefs] = useState<AgentDefinition[]>([])
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([])
  const [runs, setRuns] = useState<AgentRunRecord[]>([])
  const [busy, setBusy] = useState('')
  const [expandedRun, setExpandedRun] = useState('')

  const refresh = useCallback(async () => {
    setDefs(agentRuntime.listAgents())
    const allApprovals = await agentRuntime.getAllApprovals(50)
    setApprovals(allApprovals.filter(a => a.source !== 'workflow'))
    try {
      const { db } = await import('../db')
      setRuns(await db.agentRuns.orderBy('startedAt').reverse().limit(10).toArray())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleRun = async (agentId: string) => {
    setBusy(agentId)
    try {
      await agentRuntime.run(agentId as never, { trigger: 'manual' })
    } finally {
      setBusy('')
      refresh()
    }
  }

  const handleApprove = async (id: string) => {
    await agentRuntime.approve(id)
    // L3 批准后仍需显式执行——此处由用户再次点击执行按钮完成
    const rec = (await agentRuntime.getAllApprovals(50)).find(a => a.id === id)
    if (rec && rec.level === 'L2_suggest') await agentRuntime.executeApproved(id).catch(() => {})
    refresh()
  }

  const handleReject = async (id: string) => {
    await agentRuntime.reject(id)
    refresh()
  }

  const handleExecuteL3 = async (id: string) => {
    await agentRuntime.executeApproved(id, 'human-confirmed')
    refresh()
  }

  const pending = approvals.filter(a => a.status === 'pending')

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <Bot size={22} className="text-violet-500" />
        <h1 className="text-xl font-bold text-gray-800">AI Agents</h1>
        <span className="text-xs text-gray-400">第一批 · 4 个</span>
      </div>
      <p className="text-xs text-gray-400 mb-5">
        三级权限：L1 自动执行（整理/摘要/建议关系）→ L2 AI 建议、用户确认 → L3 必须人工批准并显式执行。
      </p>

      {/* 审批队列 */}
      <div className="bg-white border border-gray-200 rounded-2xl p-4 mb-5">
        <div className="flex items-center gap-2 mb-3">
          <ShieldCheck size={16} className="text-amber-500" />
          <h2 className="text-sm font-bold text-gray-700">审批队列</h2>
          {pending.length > 0 && (
            <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded-full text-[10px] font-bold">{pending.length}</span>
          )}
        </div>
        {pending.length === 0 ? (
          <p className="text-xs text-gray-400">没有待审批的动作。运行 Agent 后，L2/L3 动作会出现在这里。</p>
        ) : (
          <div className="space-y-2">
            {pending.map(a => (
              <div key={a.id} className={`border rounded-xl p-3 ${a.level === 'L3_approval' ? 'border-red-200 bg-red-50/40' : 'border-amber-200 bg-amber-50/40'}`}>
                <div className="flex items-start gap-2">
                  {a.level === 'L3_approval'
                    ? <ShieldAlert size={15} className="text-red-500 mt-0.5 shrink-0" />
                    : <ShieldCheck size={15} className="text-amber-500 mt-0.5 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${levelBadge[a.level].cls}`}>{levelBadge[a.level].label}</span>
                      <code className="text-[10px] text-gray-400">{a.agentId} / {a.actionType}</code>
                    </div>
                    <p className="text-xs text-gray-700 mt-1">{a.summary}</p>
                    {a.level === 'L3_approval' && (
                      <p className="text-[10px] text-red-500 mt-1">⚠ 该动作涉及外部影响或数据删除，批准后还需点击「执行」才会生效</p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => handleApprove(a.id)} className="flex items-center gap-1 px-2.5 py-1.5 bg-green-500 text-white rounded-lg text-xs hover:bg-green-600">
                      <Check size={12} /> 批准
                    </button>
                    <button onClick={() => handleReject(a.id)} className="flex items-center gap-1 px-2.5 py-1.5 bg-gray-100 text-gray-500 rounded-lg text-xs hover:bg-gray-200">
                      <X size={12} /> 拒绝
                    </button>
                  </div>
                </div>
                {/* L3 已批准待执行 */}
              </div>
            ))}
            {/* 已批准未执行的 L3 */}
            {approvals.filter(a => a.status === 'approved' && !a.executedAt && a.level === 'L3_approval').map(a => (
              <div key={a.id} className="border border-blue-300 bg-blue-50/50 rounded-xl p-3 flex items-center gap-2">
                <Zap size={14} className="text-blue-500 shrink-0" />
                <span className="text-xs text-gray-700 flex-1">{a.summary}（已批准，等待人工执行）</span>
                <button onClick={() => handleExecuteL3(a.id)} className="px-2.5 py-1.5 bg-blue-500 text-white rounded-lg text-xs hover:bg-blue-600">
                  执行
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Agent 卡片 */}
      <div className="space-y-3 mb-6">
        {defs.map(def => (
          <AgentCard key={def.id} def={def} onRun={handleRun} />
        ))}
      </div>

      {/* 运行历史 */}
      <div className="bg-white border border-gray-200 rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <History size={16} className="text-gray-400" />
          <h2 className="text-sm font-bold text-gray-700">最近运行</h2>
        </div>
        {runs.length === 0 ? (
          <p className="text-xs text-gray-400">暂无运行记录</p>
        ) : (
          <div className="space-y-1.5">
            {runs.map(r => (
              <div key={r.id}>
                <button
                  onClick={() => setExpandedRun(e => e === r.id ? '' : r.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 rounded-lg text-left"
                >
                  {r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : '⏳'}
                  <span className="text-xs font-medium text-gray-700">{defs.find(d => d.id === r.agentId)?.emoji} {defs.find(d => d.id === r.agentId)?.name ?? r.agentId}</span>
                  <span className="text-[10px] text-gray-400">{triggerLabel[r.trigger]} · {new Date(r.startedAt).toLocaleTimeString()}</span>
                  <span className="ml-auto text-[10px] text-gray-400 truncate max-w-[45%]">{r.error ?? r.summary ?? `${r.actions.length} 个动作`}</span>
                </button>
                {expandedRun === r.id && (
                  <div className="ml-4 mt-1 mb-2 px-3 py-2 bg-gray-900 text-gray-100 rounded-lg text-[10px] leading-relaxed overflow-x-auto">
                    {r.steps.map((s, i) => <div key={i}>{s}</div>)}
                    {r.actions.map((a, i) => (
                      <div key={`a${i}`} className={a.mode === 'auto_executed' ? 'text-green-300' : 'text-amber-300'}>
                        ↳ {a.type} [{a.level}] → {a.mode}{a.approvalId ? ` (${a.approvalId.slice(0, 8)})` : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
