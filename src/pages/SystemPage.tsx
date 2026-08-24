// ====== SystemPage — v1.0 系统架构总览 ======
// 四层数据库实时视图 + 设计原则声明 + 全链路健康检查

import { useState, useEffect, useCallback } from 'react'
import { Database, RefreshCw, ShieldCheck, Layers3 } from 'lucide-react'
import { db } from '../db'
import { DATA_LAYERS, layerOf, syncSystemRegistry, type LayerKey } from '../services/systemRegistry'

const layerMeta: Record<LayerKey, { title: string; subtitle: string; color: string }> = {
  layer1_core_objects: { title: '第一层 · 核心对象', subtitle: '人生 / 工作 / 生活的业务实体', color: 'text-blue-600' },
  layer2_system_relations: { title: '第二层 · 系统关系', subtitle: '一切对象之间的连接与审计流', color: 'text-violet-600' },
  layer3_ai: { title: '第三层 · AI', subtitle: '记忆 / 工具 / 权限 / 上下文快照', color: 'text-amber-600' },
  layer4_automation: { title: '第四层 · 自动化', subtitle: '工作流（含版本与步骤）+ 审批', color: 'text-emerald-600' },
}

const tableLabels: Record<string, string> = {
  goals: '目标', domains: '领域', projects: '项目', tasks: '任务',
  customers: '客户', opportunities: '商机', orders: '订单', communications: '沟通',
  knowledge: '知识', inspirations: '想法', questions: '问题', research: '研究',
  experiments: '实验', decisions: '决策', reviews: '复盘', processes: 'SOP',
  agents: '智能体配置',
  relations: '关系', events: '事件',
  memories: 'AI 记忆', agentRuns: 'Agent 运行', agentTools: 'Agent 工具',
  agentPermissions: 'Agent 权限', contexts: '上下文快照',
  workflows: '工作流', workflowVersions: '工作流版本', workflowSteps: '工作流步骤',
  workflowRuns: '工作流运行', approvals: '审批',
}

export default function SystemPage() {
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [syncInfo, setSyncInfo] = useState('')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const sync = await syncSystemRegistry()
      setSyncInfo(`工具 ${sync.tools} 个 · 权限规则 ${sync.permissions} 条已同步持久化`)
      const allTables = Object.values(DATA_LAYERS).flat() as string[]
      const entries = await Promise.all(allTables.map(async t => {
        try {
          return [t, await (db as any)[t].count()] as const
        } catch {
          return [t, -1] as const
        }
      }))
      setCounts(Object.fromEntries(entries))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Database size={22} className="text-slate-500" />
          <h1 className="text-xl font-bold text-gray-800">系统架构</h1>
          <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded-full text-[10px] font-bold">v1.0</span>
        </div>
        <button onClick={refresh} className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs hover:bg-gray-200">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
      </div>
      <p className="text-xs text-gray-400 mb-5">四层数据库实时视图 —— 每一张表都属于且只属于一层。</p>

      {/* 设计原则 */}
      <div className="bg-gradient-to-r from-slate-50 to-blue-50 border border-blue-200 rounded-2xl p-4 mb-6">
        <div className="flex items-start gap-2.5">
          <ShieldCheck size={18} className="text-blue-500 mt-0.5 shrink-0" />
          <div>
            <div className="text-sm font-bold text-gray-800 mb-1">核心设计原则</div>
            <p className="text-xs text-gray-600 leading-relaxed">
              AI 永远不直接操作数据库。所有智能动作必须经过：
              <code className="mx-1 px-1.5 py-0.5 bg-white rounded border border-blue-200 text-[11px]">Tool / Command → Permission → Repository → Database → Event</code>
              因此无论 AI 多么强大，核心数据始终在用户掌控之下。
            </p>
          </div>
        </div>
      </div>

      {/* 四层 */}
      <div className="grid gap-4 lg:grid-cols-2 mb-6">
        {(Object.keys(DATA_LAYERS) as LayerKey[]).map(layerKey => {
          const meta = layerMeta[layerKey]
          const tables = DATA_LAYERS[layerKey]
          return (
            <div key={layerKey} className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <Layers3 size={15} className={meta.color} />
                <h3 className={`text-sm font-bold ${meta.color}`}>{meta.title}</h3>
                <span className="ml-auto text-[10px] text-gray-300">{tables.length} 张表</span>
              </div>
              <p className="text-[11px] text-gray-400 mb-3">{meta.subtitle}</p>
              <div className="space-y-1">
                {tables.map(t => (
                  <div key={t} className="flex items-center gap-2 text-xs">
                    <code className="text-[10px] text-gray-400 w-36 shrink-0">{t}</code>
                    <span className="text-gray-500 truncate flex-1">{tableLabels[t] ?? t}</span>
                    <span className={`font-mono text-[11px] ${counts[t] === -1 ? 'text-red-400' : counts[t] > 0 ? 'text-gray-700 font-medium' : 'text-gray-300'}`}>
                      {counts[t] === -1 ? '缺失' : counts[t]}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* 同步状态 */}
      <div className="bg-white border border-gray-200 rounded-2xl p-4">
        <h3 className="text-sm font-bold text-gray-700 mb-2">注册中心同步</h3>
        <p className="text-xs text-gray-500">{syncInfo || '点击刷新同步工具与权限注册表…'}</p>
        <p className="text-[10px] text-gray-400 mt-2">
          三大主线：知识 Inbox→Knowledge→Problem→Research→Experiment→Decision→SOP；
          AI Data→Relation→Event→Context→Memory→Agent→Workflow→Action→Result→Review；
          业务 Customer→Opportunity→Quote→Order→Communication→After-sales→Repeat。
        </p>
      </div>
    </div>
  )
}
