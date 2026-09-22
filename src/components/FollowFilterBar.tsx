import { useState, useMemo, useRef, useEffect } from 'react'
import { FOLLOW_FILTER_FIELDS, defaultFilterValue, chipLabel, type FilterChip, type FilterFieldDef, type FilterValue } from '../services/followFilters'

function FieldPicker({ onPick, onClose }: { onPick: (f: FilterFieldDef)=>void; onClose: ()=>void }){
  const [q, setQ] = useState('')
  const list = useMemo(()=> FOLLOW_FILTER_FIELDS.filter(f=> !q || f.label.includes(q) || f.id.includes(q.toLowerCase())), [q])
  return (
    <div className="absolute z-40 left-0 top-9 w-72 bg-white border rounded-xl shadow-xl p-2">
      <input autoFocus value={q} onChange={e=> setQ(e.target.value)} placeholder="请输入筛选字段…"
        className="w-full px-2 py-1.5 border rounded text-sm mb-1"/>
      <div className="max-h-64 overflow-y-auto">
        {list.map(f=>(
          <button key={f.id} onClick={()=> onPick(f)}
            className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-blue-50">{f.label}</button>
        ))}
        {!list.length && <div className="text-xs text-gray-400 p-2">无匹配字段</div>}
      </div>
      <button onClick={onClose} className="mt-1 w-full text-xs text-gray-400 py-1">关闭</button>
    </div>
  )
}

function FilterValueEditor({ def, value, onChange, onDone }: {
  def: FilterFieldDef
  value: FilterValue
  onChange: (v: FilterValue)=>void
  onDone: ()=>void
}){
  if(value.kind === 'range'){
    return (
      <div className="absolute z-40 left-0 top-9 w-64 bg-white border rounded-xl shadow-xl p-3 space-y-2">
        <input type="number" value={value.min ?? ''} onChange={e=> onChange({ ...value, min: e.target.value===''?null:Number(e.target.value) })}
          placeholder="最小" className="w-20 px-2 py-1 border rounded text-sm"/>
        <span className="text-gray-400">–</span>
        <input type="number" value={value.max ?? ''} onChange={e=> onChange({ ...value, max: e.target.value===''?null:Number(e.target.value) })}
          placeholder="最大" className="w-20 px-2 py-1 border rounded text-sm"/>
        <label className="flex items-center gap-1 text-xs text-gray-600">
          <input type="checkbox" checked={!!value.includeEmpty} onChange={e=> onChange({ ...value, includeEmpty: e.target.checked })}/>
          空（未填写）
        </label>
        <button onClick={onDone} className="w-full py-1.5 bg-blue-600 text-white rounded text-xs">确定</button>
      </div>
    )
  }
  if(value.kind === 'date'){
    return (
      <div className="absolute z-40 left-0 top-9 w-72 bg-white border rounded-xl shadow-xl p-3 space-y-2">
        <input type="date" value={value.from||''} onChange={e=> onChange({ ...value, from: e.target.value })} className="w-full px-2 py-1 border rounded text-xs"/>
        <input type="date" value={value.to||''} onChange={e=> onChange({ ...value, to: e.target.value })} className="w-full px-2 py-1 border rounded text-xs"/>
        <label className="flex items-center gap-1 text-xs text-gray-600">
          <input type="checkbox" checked={!!value.includeEmpty} onChange={e=> onChange({ ...value, includeEmpty: e.target.checked })}/>
          空（未填写）
        </label>
        <button onClick={onDone} className="w-full py-1.5 bg-blue-600 text-white rounded text-xs">确定</button>
      </div>
    )
  }
  if(value.kind === 'enum'){
    const opts = def.options || []
    return (
      <EnumMulti options={opts} value={value.values} onChange={(vals)=> onChange({ kind:'enum', values: vals })} onDone={onDone}/>
    )
  }
  if(value.kind === 'bool'){
    return (
      <div className="absolute z-40 left-0 top-9 w-40 bg-white border rounded-xl shadow-xl p-2 space-y-1">
        {([['是', true],['否', false],['不限', null]] as const).map(([l,v])=>(
          <button key={l} onClick={()=> { onChange({ kind:'bool', value: v }); onDone() }}
            className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-blue-50">{l}</button>
        ))}
      </div>
    )
  }
  return (
    <div className="absolute z-40 left-0 top-9 w-64 bg-white border rounded-xl shadow-xl p-2 flex gap-1">
      <input value={value.kind==='text'?value.value:''} onChange={e=> onChange({ kind:'text', op:'contains', value: e.target.value })}
        placeholder={def.label} className="flex-1 px-2 py-1 border rounded text-sm"/>
      <button onClick={onDone} className="px-2 bg-blue-600 text-white rounded text-xs">确定</button>
    </div>
  )
}

function EnumMulti({ options, value, onChange, onDone }: {
  options: string[]; value: string[]; onChange: (v: string[])=>void; onDone: ()=>void
}){
  const [q, setQ] = useState('')
  const list = options.filter(o=> !q || o.includes(q))
  return (
    <div className="absolute z-40 left-0 top-9 w-72 bg-white border rounded-xl shadow-xl p-2 space-y-1">
      <input autoFocus value={q} onChange={e=> setQ(e.target.value)} placeholder={`请输入${'属性名'}…`}
        className="w-full px-2 py-1.5 border rounded text-sm"/>
      <label className="flex items-center gap-2 px-1 py-1 text-sm border-t">
        <input type="checkbox" checked={value.length===options.length && options.length>0}
          onChange={e=> onChange(e.target.checked ? [...options] : [])}/>
        全选({value.length}/{options.length})
      </label>
      <div className="max-h-48 overflow-y-auto">
        {list.map(o=>(
          <label key={o} className="flex items-center gap-2 px-1 py-1 text-sm">
            <input type="checkbox" checked={value.includes(o)}
              onChange={e=> onChange(e.target.checked ? [...value, o] : value.filter(x=> x!==o))}/>
            {o}
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onDone} className="px-3 py-1 border rounded text-xs">取消</button>
        <button onClick={onDone} className="px-3 py-1 bg-orange-500 text-white rounded text-xs">确定</button>
      </div>
    </div>
  )
}

export default function FilterBar({ search, onSearch, chips, onChips }: {
  search: string
  onSearch: (s: string)=>void
  chips: FilterChip[]
  onChips: (c: FilterChip[])=>void
}){
  const [openPicker, setOpenPicker] = useState(false)
  const [openChip, setOpenChip] = useState<number | null>(null)
  const [draft, setDraft] = useState<FilterValue | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(()=>{
    const h = (e: MouseEvent)=>{
      if(wrapRef.current && !wrapRef.current.contains(e.target as any)){
        setOpenPicker(false); setOpenChip(null)
      }
    }
    document.addEventListener('mousedown', h)
    return ()=> document.removeEventListener('mousedown', h)
  },[])

  return (
    <div ref={wrapRef} className="flex items-center gap-2 flex-wrap mb-3">
      <div className="relative">
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
        <input value={search} onChange={e=> onSearch(e.target.value)}
          placeholder="搜索客户/邮箱/公司"
          className="pl-7 pr-2 py-1.5 border rounded-lg text-xs w-48"/>
      </div>
      {chips.map((chip, i)=>(
        <div key={i} className="relative">
          <button onClick={()=>{ setOpenChip(openChip===i?null:i); setOpenPicker(false); setDraft(chip.value) }}
            className="px-2 py-1.5 border rounded-lg text-xs bg-white hover:border-blue-300 inline-flex items-center gap-1">
            <span className="text-gray-700">{chipLabel(chip)}</span>
            <span className="text-gray-400">▾</span>
          </button>
          <button onClick={()=> onChips(chips.filter((_,j)=> j!==i))} className="ml-1 text-gray-400 hover:text-rose-500 text-xs">×</button>
          {openChip===i && draft && (
            <FilterValueEditor
              def={FOLLOW_FILTER_FIELDS.find(f=> f.id===chip.field)!}
              value={draft}
              onChange={setDraft}
              onDone={()=>{
                onChips(chips.map((c,j)=> j===i ? { ...c, value: draft } : c))
                setOpenChip(null)
              }}
            />
          )}
        </div>
      ))}
      <div className="relative">
        <button onClick={()=>{ setOpenPicker(v=>!v); setOpenChip(null) }}
          className="w-8 h-8 border rounded-lg text-lg text-gray-500 hover:border-blue-300 hover:text-blue-600 bg-white"
          title="添加筛选条件">＋</button>
        {openPicker && (
          <FieldPicker onPick={(f)=>{
            const v = defaultFilterValue(f)
            onChips([...chips, { field: f.id, value: v }])
            setOpenPicker(false)
            setOpenChip(chips.length)
            setDraft(v)
          }} onClose={()=> setOpenPicker(false)}/>
        )}
      </div>
      {chips.length>0 && (
        <button onClick={()=> onChips([])} className="text-xs text-gray-500 hover:text-rose-600 px-2">🗑 清空筛选</button>
      )}
    </div>
  )
}
