import { useState, useRef, useEffect } from 'react'
import { X, Lightbulb, CheckSquare, Link, StickyNote, Send } from 'lucide-react'
import { useStore } from '../store'

const captureTypes = [
  { type: 'quick_note' as const, icon: StickyNote, label: '快速笔记', placeholder: '记录一个想法...' },
  { type: 'task' as const, icon: CheckSquare, label: '任务', placeholder: '添加一个待办事项...' },
  { type: 'idea' as const, icon: Lightbulb, label: '灵感', placeholder: '捕捉一个灵感...' },
  { type: 'link' as const, icon: Link, label: '链接', placeholder: '粘贴一个链接...' },
]

export default function QuickCapture() {
  const { app, toggleQuickCapture, addToInbox, addTask } = useStore()
  const [content, setContent] = useState('')
  const [activeType, setActiveType] = useState<'quick_note' | 'task' | 'idea' | 'link'>('quick_note')
  const [toast, setToast] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (app.quickCaptureOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [app.quickCaptureOpen])

  const handleSubmit = () => {
    if (!content.trim()) return
    if (activeType === 'task') {
      addTask({ title: content.trim() })
    } else {
      addToInbox(content.trim(), activeType)
    }
    setContent('')
    setToast(true)
    setTimeout(() => {
      setToast(false)
      toggleQuickCapture()
    }, 600)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      toggleQuickCapture()
    }
  }

  if (!app.quickCaptureOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={toggleQuickCapture} />
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl p-5">
        {/* 头部 */}
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm font-semibold text-gray-700">📥 全局收集</span>
          <button onClick={toggleQuickCapture} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* 类型选择 */}
        <div className="flex gap-2 mb-3">
          {captureTypes.map(t => (
            <button
              key={t.type}
              onClick={() => setActiveType(t.type)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-colors ${
                activeType === t.type
                  ? 'bg-blue-100 text-blue-700 font-medium'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              <t.icon size={14} />
              {t.label}
            </button>
          ))}
        </div>

        {/* 输入 */}
        <input
          ref={inputRef}
          type="text"
          value={content}
          onChange={e => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={captureTypes.find(t => t.type === activeType)?.placeholder}
          className="w-full px-4 py-3 bg-gray-50 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-200 focus:bg-white transition-all"
        />

        {/* 操作 */}
        <div className="flex justify-between items-center mt-4">
          <span className="text-[11px] text-gray-400">Enter 捕获 · Esc 取消</span>
          <button
            onClick={handleSubmit}
            disabled={!content.trim() || toast}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {toast ? (
              <>✓ 已捕获</>
            ) : (
              <>
                <Send size={14} />
                捕获
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
