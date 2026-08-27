// ====== Card — 带全局主题的卡片容器 ======
// 自动应用卡片背景主题（背景色 + 透明度），支持覆盖 className

import { useCardTheme } from '../hooks/useCardTheme'
import { cardBgStyle } from '../config/constants'

interface CardProps {
  children: React.ReactNode
  className?: string
  /** 覆盖背景色（如渐变卡片不需要主题色时传入） */
  bg?: string
}

export default function Card({ children, className = '', bg }: CardProps) {
  useCardTheme() // 订阅主题变化
  const style = bg ? undefined : cardBgStyle()
  return (
    <div className={`${bg ?? 'border border-gray-100'} rounded-2xl shadow-sm ${className}`} style={style}>
      {children}
    </div>
  )
}
