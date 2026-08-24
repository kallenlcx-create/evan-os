import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Eye, Edit3 } from 'lucide-react'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  minHeight?: string
}

export default function MarkdownEditor({ value, onChange, placeholder, minHeight = '300px' }: Props) {
  const [preview, setPreview] = useState(false)

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPreview(false)}
            className={`px-3 py-1 text-xs rounded-md transition-colors flex items-center gap-1.5 ${
              !preview ? 'bg-white text-blue-600 shadow-sm font-medium' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Edit3 size={14} /> 编辑
          </button>
          <button
            onClick={() => setPreview(true)}
            className={`px-3 py-1 text-xs rounded-md transition-colors flex items-center gap-1.5 ${
              preview ? 'bg-white text-blue-600 shadow-sm font-medium' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Eye size={14} /> 预览
          </button>
        </div>
        <div className="text-[10px] text-gray-400">
          支持 Markdown · [[链接]] · #标签
        </div>
      </div>

      {/* Content */}
      {preview ? (
        <div
          className="p-4 prose prose-sm max-w-none overflow-auto"
          style={{ minHeight }}
        >
          {value.trim() ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {value}
            </ReactMarkdown>
          ) : (
            <p className="text-gray-300 italic">暂无内容</p>
          )}
        </div>
      ) : (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder || '开始写... 支持 Markdown 语法'}
          className="w-full p-4 text-sm resize-none outline-none font-mono"
          style={{ minHeight }}
        />
      )}
    </div>
  )
}