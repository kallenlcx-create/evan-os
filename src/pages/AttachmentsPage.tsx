import { useState, useEffect, useCallback } from 'react'
import { Search, Image, Download, ExternalLink, RefreshCw } from 'lucide-react'
import { searchAttachments, type AttachmentSearchItem } from '../repositories/emailRepository'

function fmtSize(n: number){
  if(!n) return '—'
  if(n < 1024) return `${n} B`
  if(n < 1024*1024) return `${(n/1024).toFixed(1)} KB`
  return `${(n/1024/1024).toFixed(2)} MB`
}
function isImage(a: AttachmentSearchItem){
  const m = String(a.mime||'').toLowerCase()
  if(m.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filename||'')
}

export default function AttachmentsPage(){
  const [q, setQ] = useState('')
  const [type, setType] = useState<'image'|'all'>('image')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [items, setItems] = useState<AttachmentSearchItem[]>([])
  const [preview, setPreview] = useState<AttachmentSearchItem|null>(null)

  const load = useCallback(async (kw?: string, t?: 'image'|'all')=>{
    setLoading(true); setError('')
    try{
      const list = await searchAttachments((kw ?? q).trim(), t ?? type, 80)
      setItems(list)
    }catch(e:any){
      setError(String(e?.message||e).slice(0,120))
      setItems([])
    }finally{ setLoading(false) }
  },[q, type])

  useEffect(()=>{ void load('') },[]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold text-gray-800">附件库 · 图片检索</h1>
        <span className="text-xs text-gray-400">{loading?'检索中…':`${items.length} 个附件`}</span>
        <button onClick={()=> void load()} className="ml-auto px-2 py-1 text-xs border rounded-lg text-gray-500 hover:bg-gray-50 flex items-center gap-1">
          <RefreshCw size={12}/> 刷新
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300"/>
          <input
            value={q}
            onChange={e=> setQ(e.target.value)}
            onKeyDown={e=>{ if(e.key==='Enter') void load() }}
            placeholder="按附件名检索..."
            className="w-full pl-9 pr-3 py-2 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-blue-300"
          />
        </div>
        <div className="flex rounded-xl border overflow-hidden bg-white">
          {([['image','图片'],['all','全部']] as const).map(([k,label])=>(
            <button key={k}
              onClick={()=>{ setType(k); void load(q, k) }}
              className={`px-3 py-2 text-xs ${type===k?'bg-blue-600 text-white':'text-gray-600 hover:bg-gray-50'}`}
            >{label}</button>
          ))}
        </div>
        <button onClick={()=> void load()} className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm hover:bg-blue-700">搜索</button>
      </div>

      {error && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {items.map(a=>{
          const img = isImage(a)
          return (
            <div key={`${a.accountId}-${a.uid}-${a.filename}`} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden flex flex-col">
              <div className="p-3 flex items-start gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-gray-50 border flex items-center justify-center shrink-0 text-gray-400">
                  {img ? <Image size={16}/> : <span className="text-base">📎</span>}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-gray-800 truncate" title={a.filename}>{a.filename}</div>
                  <div className="text-[11px] text-gray-400">{fmtSize(a.size)} · 图像设计</div>
                </div>
              </div>
              {img && (
                <div className="px-3">
                  <img src={a.url} alt={a.filename} loading="lazy"
                    className="w-full h-36 object-cover rounded-lg border bg-gray-50"/>
                </div>
              )}
              <div className="m-3 mt-2 rounded-lg bg-gray-50 border border-gray-100 px-2.5 py-2 text-[11px]">
                <div className="text-gray-500 truncate" title={a.subject}>来源: {a.subject || '(无主题)'}</div>
                <div className="text-gray-400 truncate mt-0.5">发件: {a.from || '—'}</div>
              </div>
              <div className="px-3 pb-3 flex items-center gap-2 text-[11px] text-gray-400">
                <span>{a.date ? new Date(a.date).toLocaleDateString() : ''}</span>
                <span className="ml-auto flex items-center gap-2">
                  <button onClick={()=> setPreview(a)} className="text-gray-500 hover:text-blue-600 flex items-center gap-0.5">预览</button>
                  <a href={a.url} target="_blank" rel="noreferrer" className="text-gray-500 hover:text-blue-600 flex items-center gap-0.5">
                    <Download size={11}/> 下载
                  </a>
                  <a href={a.url} target="_blank" rel="noreferrer" className="text-gray-500 hover:text-blue-600 flex items-center gap-0.5">
                    <ExternalLink size={11}/> 递送
                  </a>
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {!loading && items.length===0 && (
        <div className="p-10 text-center text-sm text-gray-300">
          {q ? '无匹配附件' : '暂无已下载附件（可先在邮件中心点「入库」补附件）'}
        </div>
      )}

      {preview && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6" onClick={()=> setPreview(null)}>
          <div className="bg-white rounded-2xl max-w-3xl max-h-[90vh] overflow-auto p-4" onClick={e=> e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2">
              <div className="font-medium text-sm truncate flex-1">{preview.filename}</div>
              <button onClick={()=> setPreview(null)} className="text-gray-400 hover:text-gray-700 text-sm">✕</button>
            </div>
            {isImage(preview) ? (
              <img src={preview.url} alt={preview.filename} className="max-w-full max-h-[70vh] rounded-lg border"/>
            ) : (
              <a href={preview.url} className="text-blue-600 text-sm">下载查看 {preview.filename}</a>
            )}
            <div className="mt-2 text-[11px] text-gray-400">{preview.subject} · {preview.from}</div>
          </div>
        </div>
      )}
    </div>
  )
}
