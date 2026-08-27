// ====== Card — 带全局主题的卡片容器 ======
// 自动应用卡片背景主题，支持覆盖 className

import { useCardTheme } from '../hooks/useCardTheme'

interface CardProps {
  children: React.ReactNode
  className?: string
  /** 覆盖背景色（如渐变卡片不需要主题色时传入） */
  bg?: string
}

export default function Card({ children, className = '', bg }: CardProps) {
  const theme = useCardTheme()
  const bgClass = bg ?? `${theme.bg} ${theme.border}`
  return (
    <div className={`${bgClass} rounded-2xl shadow-sm ${className}`}>
      {children}
    </div>
  )
}
