// ====== ErrorBoundary —— 错误边界 ======
// 页面级崩溃不再白屏：显示友好错误页，可重试/返回首页
// 根级包裹整个应用（main.tsx），页面级包裹每个路由（Layout）

import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  children: ReactNode
  /** 页面级边界显示"返回首页"；根级显示"重新加载" */
  level?: 'root' | 'page'
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 上报预留位：未来可写入 events 表或远端
    console.error('[ErrorBoundary]', this.props.level ?? 'page', error.message, info.componentStack)
  }

  private reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const isRoot = this.props.level === 'root'
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <div className="bg-white border border-red-100 rounded-2xl shadow-sm p-6 max-w-md w-full text-center">
          <div className="text-4xl mb-3">{isRoot ? '🧠' : '🧯'}</div>
          <h2 className="text-base font-bold text-gray-800 mb-1">
            {isRoot ? '应用启动遇到问题' : '这个页面出了点问题'}
          </h2>
          <p className="text-xs text-gray-400 mb-1">数据保存在本地数据库中，并未丢失。</p>
          <pre className="text-[10px] text-red-400 bg-red-50 rounded-lg p-2 mb-4 break-all whitespace-pre-wrap max-h-24 overflow-y-auto">
            {error.message}
          </pre>
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={this.reset}
              className="px-4 py-2 bg-blue-500 text-white rounded-xl text-xs font-medium hover:bg-blue-600"
            >
              重试
            </button>
            <button
              onClick={() => { window.location.hash = '#/'; this.reset() }}
              className="px-4 py-2 bg-gray-100 text-gray-600 rounded-xl text-xs hover:bg-gray-200"
            >
              返回首页
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 text-gray-400 text-xs hover:text-gray-600"
            >
              整页刷新
            </button>
          </div>
        </div>
      </div>
    )
  }
}

/** 页面级边界（Layout 的 Outlet 使用） */
export function PageErrorBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary level="page">{children}</ErrorBoundary>
}
