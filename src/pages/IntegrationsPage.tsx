// ====== IntegrationsPage — 外部集成 ======
// 展示 Tool Layer：每个集成的工具清单与权限等级
// 演示 Gmail 导入链路、Shopify 同步、Hermes 未回复客户分析

import { useState, useEffect, useCallback } from 'react'
import { Plug, Play, ShieldAlert, CheckCircle2 } from 'lucide-react'
import { INTEGRATIONS, callIntegrationTool } from '../services/integrations/adapters'
import { commandBus } from '../services/integrations/commandBus'
import { agentRuntime } from '../services/agentRuntime'
import {
  buildVaultFiles, writeToDirectory, downloadFile,
  mergeVaultToSingleFile, generateSqlDump, markdownToKnowledge,
  type WritableDirHandle,
} from '../services/vaultSync'

// ---------- Obsidian / SQL 操作 ----------

async function pickDirectory(): Promise<WritableDirHandle | null> {
  const w = window as any
  if (typeof w.showDirectoryPicker !== 'function') return null
  try {
    return await w.showDirectoryPicker({ mode: 'readwrite' }) as WritableDirHandle
  } catch {
    return null // 用户取消或不支持
  }
}

async function syncToObsidian() {
  const files = await buildVaultFiles()
  if (files.length === 0) return { ok: true, note: '知识库为空，没有可同步的笔记' }
  const dir = await pickDirectory()
  if (dir) {
    const n = await writeToDirectory(dir, files)
    return { ok: true, mode: 'directory', written: n }
  }
  downloadFile('EvanOS-Vault.md', mergeVaultToSingleFile(files), 'text/markdown')
  return { ok: true, mode: 'fallback-single-file', merged: files.length, note: '当前浏览器不支持目录写入，已合并为单文件下载' }
}

async function importFromObsidian() {
  const dir = await pickDirectory()
  if (!dir) throw new Error('需要选择 Obsidian 库文件夹（Chrome/Edge 支持）')
  let imported = 0, skipped = 0
  // @ts-expect-error 异步迭代器在部分类型版本未声明
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.md')) continue
    const file = await handle.getFile()
    const content = await file.text()
    const parsed = markdownToKnowledge(content)
    if (!parsed) { skipped++; continue }
    const r = await commandBus.execute('obsidian', 'knowledge.upsert', {
      id: parsed.id, title: parsed.title, content: parsed.body,
      tags: parsed.tags, category: parsed.category, source: 'obsidian',
    })
    if (r.ok) imported++; else skipped++
  }
  return { imported, skipped }
}

async function exportSql() {
  const sql = await generateSqlDump()
  downloadFile('evan-os-export.sql', sql, 'application/sql')
  const tables = (sql.match(/CREATE TABLE/g) ?? []).length
  const inserts = (sql.match(/REPLACE INTO/g) ?? []).length
  return { tables, inserts }
}

const levelCls: Record<string, string> = {
  L1_auto: 'bg-green-100 text-green-700',
  L2_suggest: 'bg-amber-100 text-amber-700',
  L3_approval: 'bg-red-100 text-red-700',
}

export default function IntegrationsPage() {
  const [output, setOutput] = useState<string[]>([])
  const [busy, setBusy] = useState('')

  const log = useCallback((line: string) => {
    setOutput(prev => [...prev.slice(-30), `[${new Date().toLocaleTimeString()}] ${line}`])
  }, [])

  useEffect(() => {
    log(`命令总线就绪，审计日志 ${commandBus.getRecentCommands().length} 条`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async (key: string, fn: () => Promise<any>, label: string) => {
    setBusy(key)
    try {
      const r = await fn()
      log(`${label} → ${JSON.stringify(r).slice(0, 220)}`)
    } catch (e) {
      log(`${label} 异常: ${String(e).slice(0, 160)}`)
    } finally {
      setBusy('')
    }
  }

  // Hermes 演示：分析 → 草稿 → 提交 L3 发送审批（在 Agents 页批准+执行）
  const demoHermesFlow = async () => {
    setBusy('hermes-demo')
    try {
      const found = await callIntegrationTool('hermes', 'hermes.find_unreplied', { days: 7 })
      if (found.ok === false) { log('Hermes 分析失败'); return }
      const list = found.data?.customers ?? []
      log(`Hermes 分析：过去 7 天未回复客户 ${list.length} 个`)
      if (list.length === 0) { log('没有需要跟进的客户 🎉'); return }
      const first = list[0]
      const draft = await callIntegrationTool('hermes', 'hermes.draft_email', {
        customerTitle: first.customerTitle,
        customerId: first.customerId,
        to: first.email,
        points: ['New catalog attached', 'Special price for repeat orders'],
      })
      if (draft.ok === false) return
      log(`已草拟邮件给 ${first.customerTitle}：《${draft.data.draft.subject}》`)
      // 提交 L3 审批（在 Agents 页批准并显式执行）
      const approval = await agentRuntime.submitApproval({
        agentId: 'project_assistant',
        actionType: 'external_call',
        summary: `Hermes 发送跟进邮件 → ${first.email}`,
        payload: {
          tool: 'hermes.send_email',
          customerId: draft.data.draft.customerId,
          to: draft.data.draft.to,
          subject: draft.data.draft.subject,
          body: draft.data.draft.body,
        },
      })
      log(`L3 发送审批已提交（${approval.id.slice(0, 8)}…），请到 Agents 页批准并执行`)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <Plug size={22} className="text-cyan-500" />
        <h1 className="text-xl font-bold text-gray-800">外部集成</h1>
      </div>
      <p className="text-xs text-gray-400 mb-5">
        所有外部数据经统一 Tool Layer 进入：<code className="text-gray-500">Tool → Integration CommandBus → Repository → Event</code>。
        高风险外呼动作必须经人工审批。
      </p>

      {/* 集成卡片 */}
      <div className="grid gap-3 sm:grid-cols-2 mb-6">
        {INTEGRATIONS.map(intg => (
          <div key={intg.id} className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-2xl">{intg.emoji}</span>
              <h3 className="font-bold text-gray-800 text-sm">{intg.name}</h3>
            </div>
            <p className="text-xs text-gray-400 mb-2">{intg.description}</p>
            <div className="flex flex-wrap gap-1">
              {intg.tools.map(t => (
                <span key={t.name} title={t.description} className={`px-1.5 py-0.5 rounded text-[10px] font-medium cursor-help ${
                  t.level === 'L3_approval' ? levelCls.L3_approval : levelCls[t.level] ?? 'bg-gray-100 text-gray-500'
                }`}>
                  {t.name}{t.level === 'L3_approval' ? ' 🔒' : ''}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 演示操作 */}
      <div className="bg-white border border-gray-200 rounded-2xl p-4 mb-5">
        <h2 className="text-sm font-bold text-gray-700 mb-3">演示链路（Mock 数据）</h2>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => run('gmail', async () => {
            const msgs = await callIntegrationTool('gmail', 'gmail.fetch_messages')
            const r1 = await callIntegrationTool('gmail', 'gmail.import_message', { messageId: 'gm-1' })
            const r2 = await callIntegrationTool('gmail', 'gmail.import_message', { messageId: 'gm-2' })
            return { total: (msgs.data as any)?.length, imported: [r1.data, r2.data] }
          }, 'Gmail 导入 2 封来信')} disabled={!!busy}
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs hover:bg-blue-100 disabled:opacity-50">
            <Play size={12} /> Gmail 导入
          </button>

          <button onClick={() => run('shopify-p', () => callIntegrationTool('shopify', 'shopify.sync_products'), 'Shopify 产品同步')}
            disabled={!!busy}
            className="flex items-center gap-1 px-3 py-1.5 bg-green-50 text-green-600 rounded-lg text-xs hover:bg-green-100 disabled:opacity-50">
            <Play size={12} /> Shopify 同步产品
          </button>

          <button onClick={() => run('shopify-m', () => callIntegrationTool('shopify', 'shopify.sync_metrics'), 'Shopify 指标同步')}
            disabled={!!busy}
            className="flex items-center gap-1 px-3 py-1.5 bg-green-50 text-green-600 rounded-lg text-xs hover:bg-green-100 disabled:opacity-50">
            <Play size={12} /> Shopify 同步指标
          </button>

          <button onClick={demoHermesFlow} disabled={!!busy}
            className="flex items-center gap-1 px-3 py-1.5 bg-violet-50 text-violet-600 rounded-lg text-xs hover:bg-violet-100 disabled:opacity-50">
            <Play size={12} /> Hermes：未回复客户 + 草稿 + 送审
          </button>

          <button onClick={() => run('obsidian-out', syncToObsidian, 'Obsidian 同步到库')}
            disabled={!!busy}
            className="flex items-center gap-1 px-3 py-1.5 bg-purple-50 text-purple-600 rounded-lg text-xs hover:bg-purple-100 disabled:opacity-50">
            📓 → Obsidian 库
          </button>

          <button onClick={() => run('obsidian-in', importFromObsidian, 'Obsidian 从库导入')}
            disabled={!!busy}
            className="flex items-center gap-1 px-3 py-1.5 bg-purple-50 text-purple-600 rounded-lg text-xs hover:bg-purple-100 disabled:opacity-50">
            📓 ← Obsidian 库
          </button>

          <button onClick={() => run('sql', exportSql, 'MySQL 脚本导出')}
            disabled={!!busy}
            className="flex items-center gap-1 px-3 py-1.5 bg-sky-50 text-sky-600 rounded-lg text-xs hover:bg-sky-100 disabled:opacity-50">
            🐬 导出 MySQL 脚本
          </button>
        </div>
      </div>

      {/* 输出 */}
      <div className="bg-gray-900 text-gray-100 rounded-xl p-4 text-[11px] leading-relaxed min-h-[120px] max-h-[280px] overflow-y-auto font-mono">
        {output.length === 0 ? <span className="text-gray-500">点击上方按钮运行集成链路…</span> :
          output.map((line, i) => (
            <div key={i} className={
              line.includes('"ok":false') || line.includes('异常') ? 'text-red-300' :
              line.includes('审批') ? 'text-amber-300' : ''
            }>{line}</div>
          ))}
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-gray-400">
        <ShieldAlert size={12} className="text-red-400" />
        hermes.send_email / n8n.trigger 为 L3 工具 —— 直接调用被拒绝，必须走 Approval → Human → Execute。
        <CheckCircle2 size={12} className="text-green-400" />
        所有写入均产生 Event 审计。
      </div>
    </div>
  )
}
