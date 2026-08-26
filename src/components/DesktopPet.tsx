// 桌宠组件 - 浮动在桌面上的动画角色
// 功能：拖拽移动、点击交互、通知气泡、动画状态

import { useState, useEffect, useRef, useCallback } from 'react'

interface PetNotification {
  type: 'water' | 'sedentary' | 'offwork' | 'info'
  message: string
  timestamp: number
}

// 桌宠动画帧
const PET_FRAMES: Record<string, string[]> = {
  idle: ['🐱', '😺', '🐱', '😸'],
  happy: ['😻', '🎉', '😺', '🥳'],
  warning: ['🙀', '⚠️', '😺', '⏰'],
  sleep: ['😴', '💤', '😺', '💤'],
}

// 通知类型对应的表情和颜色
const NOTIFY_CONFIG: Record<string, { emoji: string; color: string; bg: string }> = {
  water: { emoji: '💧', color: '#0ea5e9', bg: '#f0f9ff' },
  sedentary: { emoji: '🪑', color: '#f59e0b', bg: '#fffbeb' },
  offwork: { emoji: '🎉', color: '#10b981', bg: '#ecfdf5' },
  info: { emoji: 'ℹ️', color: '#6366f1', bg: '#eef2ff' },
}

export default function DesktopPet() {
  const [frame, setFrame] = useState(0)
  const [notification, setNotification] = useState<PetNotification | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [isSleeping, setIsSleeping] = useState(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)

  // 动画循环
  useEffect(() => {
    const interval = setInterval(() => {
      setFrame(f => (f + 1) % 4)
    }, isSleeping ? 2000 : 500)
    return () => clearInterval(interval)
  }, [isSleeping])

  // 监听 Electron 通知
  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api?.onPetNotification) return

    api.onPetNotification((data: { type: string; message: string }) => {
      setNotification({ ...data, type: data.type as PetNotification['type'], timestamp: Date.now() })
      setIsSleeping(false)
      // 5 秒后自动隐藏
      setTimeout(() => setNotification(null), 5000)
    })
  }, [])

  // 空闲 5 分钟后进入睡眠
  useEffect(() => {
    const timer = setTimeout(() => setIsSleeping(true), 5 * 60 * 1000)
    return () => clearTimeout(timer)
  }, [notification])

  // 拖拽处理
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setIsDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY }
    const api = (window as any).electronAPI
    api?.petIgnoreMouse?.(true)
  }, [])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStart.current.x
      const dy = e.clientY - dragStart.current.y
      dragStart.current = { x: e.clientX, y: e.clientY }
      const api = (window as any).electronAPI
      api?.petDrag?.(dx, dy)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      const api = (window as any).electronAPI
      api?.petIgnoreMouse?.(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  // 点击处理
  const handleClick = () => {
    if (isDragging) return
    const api = (window as any).electronAPI
    api?.petClick?.()
  }

  // 获取当前动画帧
  const getCurrentEmoji = () => {
    const state = isSleeping ? 'sleep' : notification ? 'warning' : isHovered ? 'happy' : 'idle'
    return PET_FRAMES[state][frame]
  }

  // 获取通知配置
  const getNotifyConfig = () => {
    if (!notification) return null
    return NOTIFY_CONFIG[notification.type] || NOTIFY_CONFIG.info
  }

  const notifyConfig = getNotifyConfig()

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 select-none"
      style={{ cursor: isDragging ? 'grabbing' : 'default' }}
    >
      {/* 通知气泡 */}
      {notification && notifyConfig && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 rounded-xl shadow-lg max-w-[180px] animate-bounce"
          style={{
            backgroundColor: notifyConfig.bg,
            border: `1px solid ${notifyConfig.color}40`,
            animationDuration: '1s',
          }}
        >
          <div className="text-xs font-medium" style={{ color: notifyConfig.color }}>
            {notifyConfig.emoji} {notification.message}
          </div>
          {/* 气泡箭头 */}
          <div
            className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0"
            style={{
              borderLeft: '6px solid transparent',
              borderRight: '6px solid transparent',
              borderTop: `6px solid ${notifyConfig.bg}`,
            }}
          />
        </div>
      )}

      {/* 桌宠主体 */}
      <div
        className="absolute bottom-4 right-4 cursor-pointer transition-transform"
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        style={{
          transform: isHovered ? 'scale(1.1)' : 'scale(1)',
          filter: isSleeping ? 'grayscale(0.5) opacity(0.8)' : 'none',
        }}
      >
        {/* 角色光晕 */}
        {notification && (
          <div
            className="absolute inset-0 rounded-full animate-ping"
            style={{
              backgroundColor: `${notifyConfig?.color}30`,
              animationDuration: '2s',
            }}
          />
        )}

        {/* 角色主体 */}
        <div className="relative text-6xl drop-shadow-lg">
          {getCurrentEmoji()}
        </div>

        {/* 状态标签 */}
        {isHovered && (
          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[8px] text-gray-500 whitespace-nowrap">
            {isSleeping ? '💤 休息中' : '拖拽移动 · 点击打开'}
          </div>
        )}
      </div>
    </div>
  )
}
