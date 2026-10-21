import { useEffect, useRef, useState } from 'react'
import type { Customer } from '../types'
import { getCustomerNote, setCustomerNote } from '../services/customerNotes'

type Props = {
  customer: Customer
  onSaved?: (note: string) => void
  className?: string
  placeholder?: string
  title?: string
  multiline?: boolean
}

/**
 * 客户备注内联编辑器。
 * 事实源 = customers.notes；失焦/回车即保存，保存后广播 CUSTOMERS_UPDATED，
 * 跟进表与客户界面「AI 客户画像」双向实时同步。
 */
export default function CustomerNoteInput({ customer, onSaved, className, placeholder, title, multiline }: Props) {
  const [value, setValue] = useState<string>(() => getCustomerNote(customer))
  const [saving, setSaving] = useState(false)
  const dirty = useRef(false)

  // 外部（云同步 / 其它页面）改动 notes 时同步回输入框，但不覆盖正在编辑的内容
  useEffect(() => {
    if (!dirty.current) setValue(getCustomerNote(customer))
  }, [customer.id, customer.notes])

  const commit = async () => {
    dirty.current = false
    const next = value.replace(/\s+$/g, '')
    if (next === getCustomerNote(customer)) return
    setSaving(true)
    try {
      await setCustomerNote(customer.id, next)
      onSaved?.(next)
    } finally {
      setSaving(false)
    }
  }

  const cls = className || 'border rounded px-1 py-0.5 text-[11px] w-full'
  const tip = title || '人工备注：跟进表与 AI 画像共用同一份数据，AI 分析会读取'

  if (multiline) {
    return (
      <textarea
        value={value}
        title={tip}
        placeholder={placeholder || '填写客户备注（例：只做批量徽章、预算 5k 以内、需先出效果图）'}
        disabled={saving}
        onChange={e => { dirty.current = true; setValue(e.target.value) }}
        onBlur={() => { void commit() }}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            const el = e.target as HTMLTextAreaElement
            el.blur()
          }
        }}
        rows={3}
        className={cls + ' resize-y'}
      />
    )
  }

  return (
    <input
      value={value}
      title={tip}
      placeholder={placeholder || '备注…'}
      disabled={saving}
      onChange={e => { dirty.current = true; setValue(e.target.value) }}
      onBlur={() => { void commit() }}
      onKeyDown={e => {
        const el = e.target as HTMLInputElement
        if (e.key === 'Enter') {
          e.preventDefault()
          el.blur()
        }
        if (e.key === 'Escape') {
          dirty.current = false
          setValue(getCustomerNote(customer))
          el.blur()
        }
      }}
      className={cls + (saving ? ' opacity-60' : '')}
    />
  )
}
