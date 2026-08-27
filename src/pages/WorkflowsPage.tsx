// ====== WorkflowsPage — 自动化工作流管理 ======
// 展示/运行/启停工作流，处理工作流审批（高风险动作必须人工批准+显式执行）

import { useState, useEffect, useCallback } from 'react'
import {
  Zap, Play, PauseCircle, CheckCircle, ChevronDown, ChevronRight,
  ShieldAlert, History, Plus, RefreshCw,
} from 'lucide-react'
import { workflowEngine, WORKFLOW_TEMPLATES } from '../services/workflowEngine'
import type { WorkflowDefinition, WorkflowRunRecord, ApprovalRecord } from '../types'

const statusBadge: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  paused: 'bg-amber-100 text-amber-700',
  draft: 'bg-gray-100 text-gray-500',
  archived: 'bg-blue-50 text-blue-500',
}

const actionLabels: Record<string, string> = {
  create_object: '创建对象', update_object: '更新对象', create_relation: '创建关系',
  run_agent: '运行 Agent', send_notification: '发送通知',
  external_mock: '外部调用(Mock)', delete_object: '删除对象',
}

const triggerDesc = (t: WorkflowDefinition['trigger']) =>
  t.type === 'event' ? `事件 · ${t.eventType}` :
  t.type === 'time' ? `定时 · ${t.atTime ? `每日 ${t.atTime}` : `每 ${t.intervalMinutes} 分钟`}` : '手动'

function RunLogs({ run }: { run: WorkflowRunRecord }) {
  return (
    <div className="ml-4 mt-1 mb-2 px-3 py-2 bg-gray-900 text-gray-100 rounded-lg text-[10px] leading-relaxed overflow-x-auto">
      <div>v{run.workflowVersion} · {run.triggerInfo.type}{run.triggerInfo.source ? `(${run.triggerInfo.source})` : ''} · {run.status}</div>
      {run.logs.map((l, i) => (
        <div key={i} className={
          l.status === 'success' ? 'text-green-300' :
          l.status === 'failed' ? 'text-red-300' :
          l.status === 'awaiting_approval' ? 'text-amber-300' : 'text-gray-400'
        }>
          ↳ [{l.attempts}x] {l.name}: {l.status}{l.error ? ` — ${l.error}` : ''}
        </div>
      ))}
      {run.error && <div className="text-red-400">✗ {run.error}</div>}
    </div>
  )
}

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([])
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([])
  const [expanded, setExpanded] = useState('')
  const [expandedRun, setExpandedRun] = useState('')

  const refresh = useCallback(async () => {
    setWorkflows(await workflowEngine.list())
    setApprovals(await workflowEngine.getWorkflowApprovals())
    setRuns(await workflowEngine.getAllRuns(15))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleToggle = async (wf: WorkflowDefinition) => {
    await workflowEngine.setStatus(wf.id, wf.status === 'active' ? 'paused' : 'active')
    refresh()
  }

  const handleRun = async (id: string) => {
    await workflowEngine.triggerManual(id)
    refresh()
  }

  const handleInstallTemplates = async () => {
    for (const tpl of WORKFLOW_TEMPLATES) {
      await workflowEngine.register({ ...tpl, status: 'draft' })
    }
    refresh()
  }

  const handleApprove = async (a: ApprovalRecord) => {
    await workflowEngine.approve(a.id)
    // L2 批准即执行；L3 停在 approved 等待显式执行
    refresh()
  }

  const handleReject = async (a: ApprovalRecord) => {
    await workflowEngine.reject(a.id, '用户拒绝')
    refresh()
  }

  const handleExecuteL3 = async (a: ApprovalRecord) => {
    await workflowEngine.executeApproved(a.id, 'human-confirmed')
    refresh()
  }

  const pending = approvals.filter(a => a.status === 'pending')
  const approvedL3 = approvals.filter(a => a.status === 'approved' && !a.executedAt && a.level === 'L3_approval')

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Zap size={22} className="text-yellow-500" />
          <h1 className="text-xl font-bold text-gray-800">自动化</h1>
        </div>
        {workflows.length === 0 && (
          <button onClick={handleInstallTemplates} className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-50 text-yellow-600 rounded-lg text-xs font-medium hover:bg-yellow-100">
            <Plus size={14} /> 安装示例工作流
          </button>
        )}
      </div>
      <p className="text-xs text-gray-400 mb-5">
        基于 Event / Agent / Relation 的内部自动化引擎。支持事件、定时、手动三种触发；AND/OR/NOT 条件；高风险动作强制人工批准。
      </p>

      {/* 审批队列 */}
      {(pending.length > 0 || approvedL3.length > 0) && (
        <div className="bg-white border border-gray-200 rounded-2xl p-4 mb-5">
          <div className="flex items-center gap-2 mb-3">
            <ShieldAlert size={16} className="text-amber-500" />
            <h2 className="text-sm font-bold text-gray-700">工作流审批</h2>
          </div>
          <div className="space-y-2">
            {pending.map(a => (
              <div key={a.id} className={`border rounded-xl p-3 ${a.level === 'L3_approval' ? 'border-red-200 bg-red-50/40' : 'border-amber-200 bg-amber-50/40'}`}>
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <code className="text-[10px] text-gray-400">{a.workflowId} / {actionLabels[a.actionType as string] ?? a.actionType}</code>
                  {a.level === 'L3_approval' && (
                    <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-[10px] font-bold">L3 高风险</span>
                  )}
                </div>
                <p className="text-xs text-gray-700">{a.summary}</p>
                {a.level === 'L3_approval' && <p className="text-[10px] text-red-500 mt-1">批准后还需点击「执行」才会真正生效</p>}
                <div className="flex gap-1.5 mt-2">
                  <button onClick={() => handleApprove(a)} className="px-2.5 py-1.5 bg-green-500 text-white rounded-lg text-xs hover:bg-green-600">批准</button>
                  <button onClick={() => handleReject(a)} className="px-2.5 py-1.5 bg-gray-100 text-gray-500 rounded-lg text-xs hover:bg-gray-200">拒绝</button>
                </div>
              </div>
            ))}
            {approvedL3.map(a => (
              <div key={a.id} className="border border-blue-300 bg-blue-50/50 rounded-xl p-3 flex items-center gap-2">
                <span className="text-xs text-gray-700 flex-1">{a.summary}（已批准，等待执行）</span>
                <button onClick={() => handleExecuteL3(a)} className="px-2.5 py-1.5 bg-blue-500 text-white rounded-lg text-xs hover:bg-blue-600">执行</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 工作流列表 */}
      {workflows.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-3 opacity-40">⚡</div>
          <p className="text-sm text-gray-400">还没有工作流，点击右上角安装示例</p>
        </div>
      ) : (
        <div className="space-y-3 mb-6">
          {workflows.map(wf => (
            <div key={wf.id} className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <span className="text-2xl">{wf.emoji ?? '⚡'}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-bold text-gray-800 text-sm">{wf.name}</h3>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${statusBadge[wf.status]}`}>{wf.status}</span>
                    <span className="text-[10px] text-gray-400">v{wf.version}</span>
                    <span className="text-[10px] text-gray-400">{triggerDesc(wf.trigger)}</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">{wf.description}</p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {wf.steps.map((s, i) => (
                      <span key={s.id} className="flex items-center gap-1">
                        {i > 0 && <ChevronRight size={11} className="text-gray-300" />}
                        <code className={`px-1.5 py-0.5 rounded text-[10px] ${
                          ['external_mock', 'delete_object'].includes(s.action)
                            ? 'bg-red-50 text-red-600'
                            : s.requireApproval ? 'bg-amber-50 text-amber-600' : 'bg-gray-100 text-gray-500'
                        }`}>
                          {actionLabels[s.action] ?? s.action}
                          {(['external_mock', 'delete_object'].includes(s.action) || s.requireApproval) ? ' 🔒' : ''}
                        </code>
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    onClick={() => handleToggle(wf)}
                    disabled={wf.status === 'archived'}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-gray-50 text-gray-600 rounded-lg text-xs hover:bg-gray-100 disabled:opacity-40"
                  >
                    {wf.status === 'active' ? <><PauseCircle size={12} /> 暂停</> : <><CheckCircle size={12} /> 启用</>}
                  </button>
                  <button
                    onClick={() => handleRun(wf.id)}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-500 text-white rounded-lg text-xs hover:bg-blue-600"
                  >
                    <Play size={12} /> 运行
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 运行历史 */}
      <div className="bg-white border border-gray-200 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <History size={16} className="text-gray-400" />
            <h2 className="text-sm font-bold text-gray-700">执行记录</h2>
          </div>
          <button onClick={refresh} className="p-1 text-gray-400 hover:text-gray-600"><RefreshCw size={13} /></button>
        </div>
        {runs.length === 0 ? (
          <p className="text-xs text-gray-400">暂无执行记录</p>
        ) : (
          <div className="space-y-1.5">
            {runs.map(r => {
              const wfName = workflows.find(w => w.id === r.workflowId)?.name ?? r.workflowId
              return (
                <div key={r.id}>
                  <button
                    onClick={() => setExpandedRun(e => e === r.id ? '' : r.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 rounded-lg text-left"
                  >
                    {r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'awaiting_approval' ? '⏸️' : '⏳'}
                    <span className="text-xs font-medium text-gray-700">{wfName}</span>
                    <span className="text-[10px] text-gray-400">v{r.workflowVersion}</span>
                    <span className="ml-auto text-[10px] text-gray-400 truncate max-w-[45%]">{r.error ?? `${r.logs.length} 步`}</span>
                  </button>
                  {expandedRun === r.id && <RunLogs run={r} />}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 展开的工作流详情（条件树） */}
      {expanded && null}
      <details className="mt-4" onToggle={e => setExpanded((e.target as HTMLDetailsElement).open ? 'cond' : '')}>
        <summary className="cursor-pointer text-xs text-gray-500 flex items-center gap-1">
          {expanded === 'cond' ? <ChevronDown size={12} /> : <ChevronRight size={12} />} 条件语法说明
        </summary>
        <div className="mt-2 text-[11px] text-gray-500 bg-gray-50 rounded-xl p-3 leading-relaxed">
          条件为可嵌套树：<code>{'{ kind:"group", op:"and"|"or"|"not", children:[...] }'}</code>，
          叶子节点 <code>{'{ kind:"leaf", field:"event.payload.title", operator:"eq|ne|contains|gt|lt|exists|missing", value }'}</code>。
          步骤参数支持模板插值 <code>{'{{event.objectId}}'}</code>。
        </div>
      </details>
    </div>
  )
}
