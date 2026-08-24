// ====== NotificationCenter —— 通知中心面板 ======
// 展示工作流 send_notification / AI 审批提醒等站内通知
// 支持：未读标记、单条已读、全部已读、清空

import { CheckCheck, Trash2, Bell, X } from 'lucide-react'
import { useStore } from '../store'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export default function NotificationCenter() {
  const { app, setNotificationPanel, notifications, markNotificationRead, markAllNotificationsRead, clearNotifications } = useStore()
  if (!app.notificationPanelOpen) return null

  const sorted = [...notifications].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const unread = sorted.filter(n => !n.read).length

  return (
    <>
      {/* 遮罩 */}
      <div
        className="fixed inset-0 z-40 bg-black/20"
        onClick={() => setNotificationPanel(false)}
      />
      {/* 面板 */}
      <div className="fixed right-3 top-14 z-50 w-[92vw] max-w-sm bg-white border border-gray-200 rounded-2xl shadow-xl overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
          <Bell size={15} className="text-amber-500" />
          <h3 className="text-sm font-bold text-gray-700 flex-1">
            通知{unread > 0 && <span className="ml-1.5 px-1.5 py-0.5 bg-red-500 text-white rounded-full text-[10px] font-bold">{unread}</span>}
          </h3>
          <button onClick={() => setNotificationPanel(false)} className="p-1 text-gray-300 hover:text-gray-500">
            <X size={15} />
          </button>
        </div>

        {/* 列表 */}
        <div className="max-h-[55vh] overflow-y-auto divide-y divide-gray-50">
          {sorted.length === 0 ? (
            <div className="py-10 text-center">
              <Bell size={26} className="mx-auto text-gray-200 mb-2" />
              <p className="text-xs text-gray-400">暂无通知</p>
              <p className="text-[10px] text-gray-300 mt-0.5">工作流通知和 AI 提醒会出现在这里</p>
            </div>
          ) : sorted.map(n => (
            <button
              key={n.id}
              onClick={() => !n.read && markNotificationRead(n.id)}
              className={`w-full text-left px-4 py-3 flex gap-2.5 transition-colors ${
                n.read ? 'opacity-55 hover:bg-gray-50' : 'hover:bg-blue-50/50'
              }`}
            >
              <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${n.read ? 'bg-gray-200' : 'bg-blue-500'}`} />
              <div className="flex-1 min-w-0">
                <div className={`text-xs ${n.read ? 'text-gray-500' : 'text-gray-800 font-medium'}`}>{n.title}</div>
                {n.message && <p className="text-[11px] text-gray-400 mt-0.5 line-clamp-2">{n.message}</p>}
                <span className="text-[10px] text-gray-300">{timeAgo(n.createdAt)}</span>
              </div>
            </button>
          ))}
        </div>

        {/* 底部操作 */}
        {sorted.length > 0 && (
          <div className="flex border-t border-gray-100 divide-x divide-gray-100">
            <button
              onClick={markAllNotificationsRead}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] text-gray-500 hover:bg-gray-50"
            >
              <CheckCheck size={12} /> 全部已读
            </button>
            <button
              onClick={clearNotifications}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] text-gray-400 hover:bg-red-50 hover:text-red-500"
            >
              <Trash2 size={12} /> 清空
            </button>
          </div>
        )}
      </div>
    </>
  )
}
