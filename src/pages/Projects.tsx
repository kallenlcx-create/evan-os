import React, { useState } from 'react'
import { useStore } from '../store'
import { useConfirm } from '../components/ConfirmModal'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import {
  DndContext, closestCorners, DragOverlay, useDraggable, useDroppable,
  type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core'
import type { Project, ProjectStatus } from '../types'
import { useAskText } from '../components/PromptModal'

const statusColumns: { status: ProjectStatus; label: string; emoji: string; color: string }[] = [
  { status: 'idea', label: '想法', emoji: '💡', color: 'bg-yellow-50 border-yellow-200' },
  { status: 'planning', label: '规划中', emoji: '📋', color: 'bg-blue-50 border-blue-200' },
  { status: 'in_progress', label: '进行中', emoji: '🚀', color: 'bg-green-50 border-green-200' },
  { status: 'waiting', label: '等待中', emoji: '⏳', color: 'bg-orange-50 border-orange-200' },
  { status: 'blocked', label: '已阻塞', emoji: '🚫', color: 'bg-red-50 border-red-200' },
  { status: 'done', label: '已完成', emoji: '✅', color: 'bg-gray-50 border-gray-200' },
  { status: 'archived', label: '已归档', emoji: '📦', color: 'bg-gray-50 border-gray-200' },
]

const templates = [
  { title: '独立站建设项目', desc: 'Shopify 建站、SEO、内容营销', tags: ['独立站', '外贸'] },
  { title: '学习项目', desc: '学习新技能、阅读、课程', tags: ['学习', '成长'] },
  { title: 'AI 实验', desc: '探索 AI 工具、自动化工作流', tags: ['AI', '实验'] },
  { title: '客户开发', desc: '开发新客户、维护老客户', tags: ['外贸', '客户'] },
]

function DraggableCard({ project, askText, confirm }: { project: Project; askText: (title: string, defaultValue?: string) => Promise<string | null>; confirm: (msg: string) => Promise<boolean> }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: project.id, data: project })
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} style={style} className={`bg-white rounded-xl p-3 shadow-sm border border-gray-100 cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow ${isDragging ? 'opacity-50 z-50' : ''}`}>
      <div className="flex items-center gap-2">
        <span className="text-lg">{project.emoji || '📌'}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-800 truncate">{project.title}</p>
          {project.description && <p className="text-xs text-gray-400 truncate mt-0.5">{project.description}</p>}
        </div>
        <div className="flex flex-col gap-0.5 shrink-0">
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); void (async () => {
              const title = await askText('修改项目名', project.title ?? ''); if (title === null || !title.trim()) return
              const progress = await askText('修改进度 %（0-100）', String(project.progress ?? 0)); if (progress === null) return
              useStore.getState().updateObject('project', project.id, { title: title.trim(), progress: Math.min(100, Math.max(0, Number(progress) || 0)) })
            })() }}
            className="p-1 text-gray-300 hover:text-blue-500" title="编辑"
          >
            <Pencil size={12} />
          </button>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={async (e) => {
              e.stopPropagation()
              if (!await confirm(`删除项目「${project.title}」？此操作不可恢复`)) return
              useStore.getState().deleteObject('project', project.id)
            }}
            className="p-1 text-gray-300 hover:text-red-500" title="删除"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {project.tags.length > 0 && (
        <div className="flex gap-1 mt-2 flex-wrap">
          {project.tags.map(tag => (
            <span key={tag} className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded-full">{tag}</span>
          ))}
        </div>
      )}
      {project.progress > 0 && (
        <div className="mt-2 w-full h-1 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full" style={{ width: `${project.progress}%` }} />
        </div>
      )}
    </div>
  )
}

function DroppableColumn({ col, children }: { col: typeof statusColumns[0]; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: col.status })
  return (
    <div ref={setNodeRef} className={`flex-shrink-0 w-64 rounded-xl border-2 p-2 ${col.color} ${isOver ? 'border-blue-400 bg-blue-50/50' : 'border-transparent'} transition-colors`}>
      <div className="flex items-center justify-between px-2 py-1.5 mb-2">
        <span className="text-xs font-semibold text-gray-600">{col.emoji} {col.label}</span>
        <span className="text-[10px] text-gray-400">{React.Children.count(children)}</span>
      </div>
      <div className="space-y-2 min-h-[60px]">{children}</div>
    </div>
  )
}

export default function ProjectsPage() {
  const { projects, addObject, updateProjectStatus } = useStore()
  const [showForm, setShowForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [askModal, askText] = useAskText()
  const [confirmModal, confirm] = useConfirm()

  const handleAdd = (title?: string, tags?: string[], desc?: string) => {
    const t = title || newTitle.trim()
    if (!t) return
    addObject('project', { title: t, status: 'idea', progress: 0, tags: tags || [], description: desc || '' })
    setNewTitle('')
    setShowForm(false)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    const newStatus = over.id as ProjectStatus
    if (statusColumns.some(c => c.status === newStatus)) {
      updateProjectStatus(active.id as string, newStatus)
    }
  }

  const grouped = statusColumns.map(col => ({
    ...col,
    items: projects.filter(p => p.status === col.status),
  }))

  return (
    <div className="space-y-6">
      {askModal}
      {confirmModal}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">🚀 项目</h1>
          <p className="text-sm text-gray-400 mt-0.5">拖拽卡片到不同列来改变状态</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowForm(!showForm)} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors">
            <Plus size={16} /> 新建项目
          </button>
        </div>
      </div>

      {/* 新建表单 */}
      {showForm && (
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
          <div className="flex gap-3 flex-wrap items-end mb-3">
            <div className="flex-1 min-w-[200px]">
              <label className="text-xs text-gray-400 mb-1 block">项目名称</label>
              <input type="text" value={newTitle} onChange={e => setNewTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()} placeholder="输入项目名称..." className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200" autoFocus />
            </div>
            <button onClick={() => handleAdd()} disabled={!newTitle.trim()} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50">添加</button>
          </div>
          {/* 模板 */}
          <div>
            <label className="text-xs text-gray-400 mb-2 block">或选择模板</label>
            <div className="flex gap-2 flex-wrap">
              {templates.map(tmpl => (
                <button key={tmpl.title} onClick={() => handleAdd(tmpl.title, tmpl.tags, tmpl.desc)} className="px-3 py-2 rounded-xl bg-gray-50 border border-gray-100 hover:border-blue-300 hover:bg-blue-50 transition-all text-left">
                  <div className="text-sm font-medium text-gray-700">{tmpl.title}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{tmpl.desc}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 看板 */}
      <DndContext collisionDetection={closestCorners} onDragStart={(e: DragStartEvent) => setActiveProject(e.active.data.current as Project)} onDragEnd={handleDragEnd}>
        <div className="flex gap-4 overflow-x-auto pb-4">
          {grouped.map(col => (
            <DroppableColumn key={col.status} col={col}>
              {col.items.map(project => (
                <DraggableCard key={project.id} project={project} askText={askText} confirm={confirm} />
              ))}
            </DroppableColumn>
          ))}
        </div>
        <DragOverlay>
          {activeProject && (
            <div className="bg-white rounded-xl p-3 shadow-lg border border-blue-200 rotate-2">
              <span className="text-lg">{activeProject.emoji || '📌'}</span>
              <span className="text-sm font-medium ml-2">{activeProject.title}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
