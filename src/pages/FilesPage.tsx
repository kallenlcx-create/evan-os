// ====== 文件管理页 ======
import { useState, useEffect, useRef, useCallback } from 'react'
import { Upload, Trash2, Download, Eye, Search, File, Grid, List, X } from 'lucide-react'
import {
  uploadFile, listFiles, deleteFile, getFileUrl,
  formatFileSize, getFileIcon, type FileRecord
} from '../services/fileStorage'
import { useConfirm } from '../components/ConfirmModal'

type ViewMode = 'grid' | 'list'

export default function FilesPage() {
  const [files, setFiles] = useState<FileRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [search, setSearch] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [previewFile, setPreviewFile] = useState<FileRecord | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [confirmModal, confirm] = useConfirm()
  const dragRef = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await listFiles()
      setFiles(list)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList?.length) return
    setUploading(true)
    try {
      for (const f of Array.from(fileList)) {
        await uploadFile(f)
      }
      await load()
    } catch (e: any) {
      alert(e.message || '上传失败')
    } finally { setUploading(false) }
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    await handleUpload(e.dataTransfer.files)
  }

  const handleDelete = async (f: FileRecord) => {
    if (!await confirm(`确认删除「${f.name}」？`)) return
    await deleteFile(f.id)
    setFiles(prev => prev.filter(x => x.id !== f.id))
    if (previewFile?.id === f.id) setPreviewFile(null)
  }

  const filtered = files.filter(f =>
    !search || f.name.toLowerCase().includes(search.toLowerCase())
  )

  const isImage = (f: FileRecord) => f.mime.startsWith('image/')

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4">
      {confirmModal}

      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <File size={22} className="text-blue-500" /> 文件存储
          </h1>
          <p className="text-xs text-gray-400 mt-0.5">
            上传文件到服务器，多设备同步查看
            {files.length > 0 && <span className="ml-2">共 {files.length} 个文件</span>}
          </p>
        </div>
      </div>

      {/* 工具栏 */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索文件..."
            className="w-full pl-9 pr-4 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          <Upload size={15} /> {uploading ? '上传中...' : '上传'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => handleUpload(e.target.files)}
        />
        <button
          onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
          className="p-2 rounded-xl border border-gray-200 text-gray-500 hover:bg-gray-50"
          title={viewMode === 'grid' ? '切换列表' : '切换网格'}
        >
          {viewMode === 'grid' ? <List size={16} /> : <Grid size={16} />}
        </button>
      </div>

      {/* 拖拽上传区域 */}
      <div
        ref={dragRef}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-2xl transition-colors ${
          dragOver ? 'border-blue-400 bg-blue-50/50' : 'border-gray-200'
        }`}
      >
        {loading ? (
          <div className="text-center py-16 text-gray-400 text-sm">加载中...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-5xl mb-4 opacity-40">📁</div>
            <p className="text-gray-400 text-sm mb-2">
              {search ? '没有匹配的文件' : '拖拽文件到这里，或点击上方「上传」按钮'}
            </p>
            <p className="text-gray-300 text-xs">支持 Word / Excel / PPT / PDF / 图片 / 压缩包 等所有格式</p>
          </div>
        ) : viewMode === 'grid' ? (
          /* 网格视图 */
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 p-4">
            {filtered.map(f => (
              <div
                key={f.id}
                className={`group relative rounded-xl border transition-colors cursor-pointer ${
                  isImage(f) ? 'border-gray-100 bg-white hover:border-blue-300' : 'border-gray-100 bg-white hover:border-blue-300'
                }`}
                onClick={() => setPreviewFile(f)}
              >
                {/* 预览区 */}
                <div className="aspect-square flex items-center justify-center overflow-hidden rounded-t-xl bg-gray-50">
                  {isImage(f) ? (
                    <img
                      src={getFileUrl(f.id)}
                      alt={f.name}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="text-4xl">{getFileIcon(f.mime, f.name)}</span>
                  )}
                </div>
                {/* 信息 */}
                <div className="p-2.5">
                  <p className="text-xs font-medium text-gray-700 truncate">{f.name}</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">{formatFileSize(f.size)}</p>
                </div>
                {/* 操作按钮 */}
                <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={e => { e.stopPropagation(); setPreviewFile(f) }}
                    className="p-1.5 bg-white/90 rounded-lg shadow-sm hover:bg-blue-50 text-gray-500 hover:text-blue-600"
                    title="预览"
                  >
                    <Eye size={13} />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); window.open(getFileUrl(f.id), '_blank') }}
                    className="p-1.5 bg-white/90 rounded-lg shadow-sm hover:bg-green-50 text-gray-500 hover:text-green-600"
                    title="下载"
                  >
                    <Download size={13} />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); void handleDelete(f) }}
                    className="p-1.5 bg-white/90 rounded-lg shadow-sm hover:bg-red-50 text-gray-500 hover:text-red-500"
                    title="删除"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* 列表视图 */
          <div className="divide-y divide-gray-100">
            {filtered.map(f => (
              <div
                key={f.id}
                className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors"
                onClick={() => setPreviewFile(f)}
              >
                <span className="text-2xl flex-shrink-0">{getFileIcon(f.mime, f.name)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-700 truncate">{f.name}</p>
                  <p className="text-[11px] text-gray-400">
                    {formatFileSize(f.size)} · {new Date(f.createdAt).toLocaleDateString('zh-CN')}
                  </p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={e => { e.stopPropagation(); window.open(getFileUrl(f.id), '_blank') }}
                    className="p-1.5 text-gray-400 hover:text-blue-600 rounded-lg hover:bg-blue-50"
                    title="下载"
                  >
                    <Download size={14} />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); void handleDelete(f) }}
                    className="p-1.5 text-gray-400 hover:text-red-500 rounded-lg hover:bg-red-50"
                    title="删除"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 预览弹窗 */}
      {previewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setPreviewFile(null)}>
          <div className="bg-white rounded-2xl max-w-4xl max-h-[90vh] w-full overflow-hidden shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xl">{getFileIcon(previewFile.mime, previewFile.name)}</span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-800 truncate">{previewFile.name}</p>
                  <p className="text-[11px] text-gray-400">{formatFileSize(previewFile.size)} · {previewFile.mime}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <a
                  href={getFileUrl(previewFile.id)}
                  target="_blank"
                  rel="noopener"
                  className="flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs hover:bg-blue-100"
                >
                  <Download size={13} /> 下载
                </a>
                <button onClick={() => setPreviewFile(null)} className="p-1.5 text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto flex items-center justify-center bg-gray-50 p-4 min-h-[300px]">
              {isImage(previewFile) ? (
                <img
                  src={getFileUrl(previewFile.id)}
                  alt={previewFile.name}
                  className="max-w-full max-h-[70vh] object-contain rounded-lg shadow"
                />
              ) : previewFile.mime.includes('pdf') ? (
                <iframe
                  src={getFileUrl(previewFile.id)}
                  className="w-full h-[70vh] rounded-lg border-0"
                  title={previewFile.name}
                />
              ) : (
                <div className="text-center py-12">
                  <span className="text-6xl block mb-4">{getFileIcon(previewFile.mime, previewFile.name)}</span>
                  <p className="text-sm text-gray-500 mb-1">{previewFile.name}</p>
                  <p className="text-xs text-gray-400 mb-4">此文件类型不支持在线预览</p>
                  <a
                    href={getFileUrl(previewFile.id)}
                    target="_blank"
                    rel="noopener"
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm hover:bg-blue-700"
                  >
                    <Download size={14} /> 下载查看
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
