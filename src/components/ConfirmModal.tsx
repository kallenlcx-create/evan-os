// ====== useConfirm —— 页内确认弹窗（替代原生 confirm） ======
// 用法：
//   const [confirmModal, confirm] = useConfirm()
//   return (<>{confirmModal} ...</>)
//   const ok = await confirm('确定删除？')

import { useState, useRef, type ReactNode } from 'react'

export function useConfirm(): [
  ReactNode,
  (message: string, title?: string) => Promise<boolean>,
] {
  const [state, setState] = useState<{ message: string; title: string } | null>(null)
  const resolveRef = useRef<((v: boolean) => void) | null>(null)

  const confirm = (message: string, title = '确认操作') =>
    new Promise<boolean>(resolve => {
      resolveRef.current = resolve
      setState({ message, title })
    })

  const close = (result: boolean) => {
    resolveRef.current?.(result)
    resolveRef.current = null
    setState(null)
  }

  const modal: ReactNode = state ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => close(false)}>
      <div className="bg-white rounded-2xl shadow-xl border border-gray-100 w-full max-w-sm p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <h4 className="text-sm font-semibold text-gray-700">{state.title}</h4>
        <p className="text-sm text-gray-500">{state.message}</p>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={() => close(false)} className="px-3 py-1.5 text-xs bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200">取消</button>
          <button onClick={() => close(true)} className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700">确定</button>
        </div>
      </div>
    </div>
  ) : null

  return [modal, confirm]
}
