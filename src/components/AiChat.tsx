// ====== AiChat — AI 对话组件 ======
// 消息列表 + 输入框 + 流式输出 + 会话管理

import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Plus, Trash2, Settings, Loader2, Bot, User, ChevronDown } from 'lucide-react'
import {
  getAiSettings, setAiSettings,
  getChatSessions, createChatSession, appendMessage, deleteChatSession,
  AI_PROVIDERS, type AiSettings, type ChatSession, type ChatMessage,
} from '../config/aiProviders'
import { streamChat } from '../services/aiChat'

export default function AiChat() {
  const [sessions, setSessions] = useState<ChatSession[]>(() => getChatSessions())
  const [activeId, setActiveId] = useState<string>('')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showSidebar, setShowSidebar] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // 设置状态
  const [settings, setSettings] = useState<AiSettings>(() => getAiSettings())
  const [providerId, setProviderId] = useState(settings.providerId)

  const activeSession = sessions.find(s => s.id === activeId)
  const messages = activeSession?.messages ?? []

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => { scrollToBottom() }, [messages.length, scrollToBottom])

  // 新建会话
  const handleNew = () => {
    const s = createChatSession()
    setSessions(getChatSessions())
    setActiveId(s.id)
    setShowSidebar(false)
  }

  // 删除会话
  const handleDelete = (id: string) => {
    deleteChatSession(id)
    const next = getChatSessions()
    setSessions(next)
    if (activeId === id) setActiveId(next[0]?.id ?? '')
  }

  // 发送消息
  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return
    if (!activeId) { handleNew(); return }

    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: text, timestamp: Date.now() }
    appendMessage(activeId, userMsg)
    setSessions(getChatSessions())
    setInput('')
    setLoading(true)

    // 构建消息历史
    const session = getChatSessions().find(s => s.id === activeId)
    const history = session?.messages.map(m => ({ role: m.role, content: m.content })) ?? []
    if (settings.systemPrompt) history.unshift({ role: 'system', content: settings.systemPrompt })

    const assistantMsg: ChatMessage = { id: Date.now().toString() + 'a', role: 'assistant', content: '', timestamp: Date.now() }

    try {
      abortRef.current = new AbortController()
      let fullContent = ''
      for await (const chunk of streamChat({ messages: history, signal: abortRef.current.signal })) {
        if (chunk.done) break
        fullContent += chunk.content
        assistantMsg.content = fullContent
        // 实时更新 UI
        setSessions(prev => prev.map(s => {
          if (s.id !== activeId) return s
          const msgs = [...s.messages]
          const last = msgs[msgs.length - 1]
          if (last?.id === assistantMsg.id) {
            msgs[msgs.length - 1] = { ...assistantMsg }
          } else {
            msgs.push({ ...assistantMsg })
          }
          return { ...s, messages: msgs, updatedAt: Date.now() }
        }))
      }
      // 最终保存
      appendMessage(activeId, { ...assistantMsg, content: fullContent })
      setSessions(getChatSessions())
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        appendMessage(activeId, { ...assistantMsg, content: `❌ 错误：${err.message}` })
        setSessions(getChatSessions())
      }
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const stopGeneration = () => { abortRef.current?.abort() }

  // 保存设置
  const saveSettings = () => {
    setAiSettings(settings)
    setShowSettings(false)
  }

  const updateProvider = (id: string) => {
    setProviderId(id)
    const p = AI_PROVIDERS.find(p => p.id === id)
    if (p) {
      setSettings(s => ({
        ...s,
        providerId: id,
        baseUrl: p.baseUrl,
        model: p.defaultModel,
        temperature: p.defaults.temperature,
        maxTokens: p.defaults.maxTokens,
        topP: p.defaults.topP,
      }))
    }
  }

  return (
    <div className="flex h-[calc(100vh-120px)] bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      {/* 侧边栏：会话列表 */}
      {showSidebar && (
        <div className="w-64 border-r border-gray-100 flex flex-col bg-gray-50/50 shrink-0">
          <div className="p-3 border-b border-gray-100 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">对话历史</span>
            <button onClick={() => setShowSidebar(false)} className="text-gray-400 hover:text-gray-600 text-xs">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {sessions.length === 0 && <p className="text-xs text-gray-400 text-center py-4">暂无对话</p>}
            {sessions.map(s => (
              <div key={s.id}
                onClick={() => { setActiveId(s.id); setShowSidebar(false) }}
                className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-sm ${activeId === s.id ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100'}`}>
                <span className="flex-1 truncate">{s.title}</span>
                <button onClick={e => { e.stopPropagation(); handleDelete(s.id) }}
                  className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 shrink-0">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 主区域 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 顶栏 */}
        <div className="h-12 border-b border-gray-100 flex items-center px-4 gap-3 shrink-0">
          {!showSidebar && (
            <button onClick={() => setShowSidebar(true)} className="text-gray-400 hover:text-gray-600">
              <ChevronDown size={16} className="rotate-90" />
            </button>
          )}
          <span className="text-sm font-medium text-gray-700 truncate flex-1">
            {activeSession?.title ?? 'AI 对话'}
          </span>
          <button onClick={handleNew}
            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
            <Plus size={12} /> 新对话
          </button>
          <button onClick={() => setShowSettings(!showSettings)}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100">
            <Settings size={16} />
          </button>
        </div>

        {/* 设置面板 */}
        {showSettings && (
          <div className="border-b border-gray-100 bg-gray-50/80 p-4 space-y-3 max-h-[50vh] overflow-y-auto">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* 模型提供商 */}
              <div>
                <label className="text-[11px] text-gray-500 block mb-1">模型提供商</label>
                <select value={providerId} onChange={e => updateProvider(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200">
                  {AI_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              {/* API Key */}
              <div>
                <label className="text-[11px] text-gray-500 block mb-1">API Key</label>
                <input type="password" value={settings.apiKey} onChange={e => setSettings(s => ({ ...s, apiKey: e.target.value }))}
                  placeholder="sk-..."
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200" />
              </div>
              {/* Base URL */}
              <div>
                <label className="text-[11px] text-gray-500 block mb-1">Base URL</label>
                <input type="text" value={settings.baseUrl} onChange={e => setSettings(s => ({ ...s, baseUrl: e.target.value }))}
                  placeholder="https://api.deepseek.com"
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200" />
              </div>
              {/* 模型名称 */}
              <div>
                <label className="text-[11px] text-gray-500 block mb-1">模型名称</label>
                <input type="text" value={settings.model} onChange={e => setSettings(s => ({ ...s, model: e.target.value }))}
                  placeholder="deepseek-v4-flash"
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200" />
                {providerId !== 'custom' && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {AI_PROVIDERS.find(p => p.id === providerId)?.models.map(m => (
                      <button key={m} onClick={() => setSettings(s => ({ ...s, model: m }))}
                        className={`px-2 py-0.5 rounded text-[10px] border ${settings.model === m ? 'bg-blue-50 border-blue-300 text-blue-600' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Temperature */}
              <div>
                <label className="text-[11px] text-gray-500 block mb-1">
                  Temperature: <span className="text-gray-700">{settings.temperature}</span>
                </label>
                <input type="range" min={0} max={2} step={0.1} value={settings.temperature}
                  onChange={e => setSettings(s => ({ ...s, temperature: Number(e.target.value) }))}
                  className="w-full accent-blue-500" />
              </div>
              {/* Max Tokens */}
              <div>
                <label className="text-[11px] text-gray-500 block mb-1">
                  Max Tokens: <span className="text-gray-700">{settings.maxTokens}</span>
                </label>
                <input type="range" min={256} max={16384} step={256} value={settings.maxTokens}
                  onChange={e => setSettings(s => ({ ...s, maxTokens: Number(e.target.value) }))}
                  className="w-full accent-blue-500" />
              </div>
              {/* Top P */}
              <div>
                <label className="text-[11px] text-gray-500 block mb-1">
                  Top P: <span className="text-gray-700">{settings.topP}</span>
                </label>
                <input type="range" min={0} max={1} step={0.05} value={settings.topP}
                  onChange={e => setSettings(s => ({ ...s, topP: Number(e.target.value) }))}
                  className="w-full accent-blue-500" />
              </div>
              {/* 系统提示词 */}
              <div className="sm:col-span-2">
                <label className="text-[11px] text-gray-500 block mb-1">系统提示词</label>
                <textarea value={settings.systemPrompt} onChange={e => setSettings(s => ({ ...s, systemPrompt: e.target.value }))}
                  rows={2}
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200 resize-none" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={saveSettings}
                className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
                保存设置
              </button>
              <span className="text-[10px] text-gray-400">设置保存在本地浏览器，不会上传</span>
            </div>
          </div>
        )}

        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-4">
                <Bot size={28} className="text-blue-400" />
              </div>
              <h3 className="text-lg font-medium text-gray-700 mb-1">Evan AI 助手</h3>
              <p className="text-sm text-gray-400 max-w-sm">
                {settings.apiKey ? '输入消息开始对话' : '请先点击右上角 ⚙️ 配置 API Key'}
              </p>
              <div className="flex flex-wrap gap-2 mt-4 justify-center">
                {['帮我写一封外贸跟进邮件', '解释 React Hooks', '今天天气怎么样'].map(q => (
                  <button key={q} onClick={() => setInput(q)}
                    className="px-3 py-1.5 bg-gray-100 text-gray-600 rounded-full text-xs hover:bg-gray-200 transition-colors">
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map(msg => (
            <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role !== 'user' && (
                <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot size={16} className="text-blue-500" />
                </div>
              )}
              <div className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white rounded-br-md'
                  : 'bg-gray-100 text-gray-800 rounded-bl-md'
              }`}>
                {msg.content || (loading && msg === messages[messages.length - 1] ? (
                  <span className="flex items-center gap-1.5 text-gray-400">
                    <Loader2 size={14} className="animate-spin" /> 思考中...
                  </span>
                ) : '')}
              </div>
              {msg.role === 'user' && (
                <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center shrink-0 mt-0.5">
                  <User size={16} className="text-gray-500" />
                </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* 输入区 */}
        <div className="border-t border-gray-100 p-3 shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
              rows={1}
              className="flex-1 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-200 resize-none min-h-[40px] max-h-[120px]"
              style={{ height: 'auto' }}
              onInput={e => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px' }}
            />
            {loading ? (
              <button onClick={stopGeneration}
                className="w-10 h-10 rounded-xl bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors shrink-0">
                <div className="w-3 h-3 bg-white rounded-sm" />
              </button>
            ) : (
              <button onClick={handleSend} disabled={!input.trim()}
                className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700 disabled:opacity-40 transition-colors shrink-0">
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
