// ====== useCardTheme — 卡片背景主题 React Hook ======
// 监听 evan-card-theme-change 事件，切换后自动触发重渲染

import { useState, useEffect } from 'react'
import { getCardTheme } from '../config/constants'

export function useCardTheme() {
  const [theme, setTheme] = useState(getCardTheme)

  useEffect(() => {
    const handler = () => setTheme(getCardTheme())
    window.addEventListener('evan-card-theme-change', handler)
    return () => window.removeEventListener('evan-card-theme-change', handler)
  }, [])

  return theme
}
