// ====== useAskText —— 页内输入弹窗（替代原生 prompt） ======
// 用法：
//   const [askModal, askText] = useAskText()
//   return (<>{askModal} ...</>)
//   const name = await askText('标题', '默认值', '占位提示')   // 取消返回 null

import { useState, useRef, type ReactNode } from 'react'

export function useAskText(): [
  ReactNode,
  (title: string, defaultValue?: string, placeholder?: string) => Promise<string | null>,
] {
  const [state, setState] = useState<{ title: string; value: string; placeholder?: string } | null>(null)
  const resolveRef = useRef<((v: string | null) => void) | null>(null)

  const askText = (title: string, defaultValue = '', placeholder?: string) => {
    // 如果上一个弹窗还没关闭，先 reject 掉
    resolveRef.current?.(null)
    return new Promise<string | null>(resolve => {
      resolveRef.current = resolve
      setState({ title, value: defaultValue, placeholder })
    })
  }

  const close = (result: string | null) => {
    resolveRef.current?.(result)
    resolveRef.current = null
    setState(null)
  }

  const modal: ReactNode = state ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => close(null)}>
      <div className="bg-white rounded-2xl shadow-xl border border-gray-100 w-full max-w-sm p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <h4 className="text-sm font-semibold text-gray-700">{state.title}</h4>
        <input
          autoFocus
          type="text"
          value={state.value}
          placeholder={state.placeholder}
          onChange={e => setState({ ...state, value: e.target.value })}
          onKeyDown={e => {
            if (e.key === 'Enter') close(state.value)
            if (e.key === 'Escape') close(null)
          }}
          className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:ring-2 focus:ring-blue-100"
        />
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={() => close(null)} className="px-3 py-1.5 text-xs bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200">取消</button>
          <button onClick={() => close(state.value)} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700">确定</button>
        </div>
      </div>
    </div>
  ) : null

  return [modal, askText]
}
