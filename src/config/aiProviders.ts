// ====== AI 模型提供商配置 ======
// 预设国内外主流大模型，全部兼容 OpenAI Chat Completions 格式

export interface AiProvider {
  id: string
  name: string
  baseUrl: string
  models: string[]
  defaultModel: string
  /** 该提供商的默认生成参数 */
  defaults: { temperature: number; maxTokens: number; topP: number }
}

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    defaultModel: 'deepseek-v4-flash',
    defaults: { temperature: 0.7, maxTokens: 4096, topP: 0.9 },
  },
  {
    id: 'qwen',
    name: '通义千问（Qwen）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.6-plus', 'qwen3-max', 'qwen-turbo'],
    defaultModel: 'qwen3.6-plus',
    defaults: { temperature: 0.7, maxTokens: 4096, topP: 0.9 },
  },
  {
    id: 'doubao',
    name: '豆包（字节跳动）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-pro-256k', 'doubao-lite-128k'],
    defaultModel: 'doubao-pro-256k',
    defaults: { temperature: 0.7, maxTokens: 4096, topP: 0.9 },
  },
  {
    id: 'kimi',
    name: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
    defaultModel: 'moonshot-v1-128k',
    defaults: { temperature: 0.7, maxTokens: 4096, topP: 0.9 },
  },
  {
    id: 'zhipu',
    name: '智谱清言（GLM）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-flash', 'glm-4-air'],
    defaultModel: 'glm-4-plus',
    defaults: { temperature: 0.7, maxTokens: 4096, topP: 0.9 },
  },
  {
    id: 'openai',
    name: 'OpenAI（GPT）',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    defaultModel: 'gpt-4o-mini',
    defaults: { temperature: 0.7, maxTokens: 4096, topP: 1 },
  },
  {
    id: 'claude',
    name: 'Claude（Anthropic）',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
    defaultModel: 'claude-sonnet-4-20250514',
    defaults: { temperature: 0.7, maxTokens: 4096, topP: 1 },
  },
  {
    id: 'mimo',
    name: 'MiMo（小米）',
    baseUrl: 'https://api.xiaomimimo.com',
    models: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-flash'],
    defaultModel: 'mimo-v2.5-pro',
    defaults: { temperature: 0.7, maxTokens: 4096, topP: 0.9 },
  },
  {
    id: 'ark-coding',
    name: '火山方舟 Coding Plan',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    models: ['ark-code-latest', 'doubao-seed-2.0-code', 'doubao-seed-2.0-pro', 'kimi-k2.5', 'glm-4.7', 'deepseek-v3.2'],
    defaultModel: 'ark-code-latest',
    defaults: { temperature: 0.7, maxTokens: 4096, topP: 0.9 },
  },
  {
    id: 'relay',
    name: '中转 API 接口',
    baseUrl: '',
    models: [],
    defaultModel: '',
    defaults: { temperature: 0.7, maxTokens: 4096, topP: 0.9 },
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseUrl: '',
    models: [],
    defaultModel: '',
    defaults: { temperature: 0.7, maxTokens: 4096, topP: 0.9 },
  },
]

// ====== AI 设置存储 ======

export interface AiSettings {
  providerId: string
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  topP: number
  /** 系统提示词 */
  systemPrompt: string
}

const LS_KEY = 'evan-os-ai-settings'

export function getAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return { ...getDefaultSettings(), ...JSON.parse(raw) }
  } catch {}
  return getDefaultSettings()
}

export function setAiSettings(settings: AiSettings) {
  // 规范化 baseUrl：去掉可能重复拼接的路径后缀，防止 /chat/completions/chat/completions
  let baseUrl = settings.baseUrl.replace(/\/$/, '')
  baseUrl = baseUrl.replace(/\/chat\/completions$/i, '')
  baseUrl = baseUrl.replace(/\/v1\/messages$/i, '')
  localStorage.setItem(LS_KEY, JSON.stringify({ ...settings, baseUrl }))
}

function getDefaultSettings(): AiSettings {
  const p = AI_PROVIDERS[0]
  return {
    providerId: p.id,
    apiKey: '',
    baseUrl: p.baseUrl,
    model: p.defaultModel,
    temperature: p.defaults.temperature,
    maxTokens: p.defaults.maxTokens,
    topP: p.defaults.topP,
    systemPrompt: '你是 Evan OS 的 AI 助手。请用中文回答，简洁专业。',
  }
}

// ====== 对话历史存储 ======

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

const LS_SESSIONS = 'evan-os-ai-sessions'

export function getChatSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(LS_SESSIONS)
    if (raw) return JSON.parse(raw)
  } catch {}
  return []
}

export function saveChatSessions(sessions: ChatSession[]) {
  localStorage.setItem(LS_SESSIONS, JSON.stringify(sessions))
}

export function createChatSession(title?: string): ChatSession {
  const session: ChatSession = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: title ?? '新对话',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const sessions = getChatSessions()
  sessions.unshift(session)
  saveChatSessions(sessions)
  return session
}

export function appendMessage(sessionId: string, msg: ChatMessage) {
  const sessions = getChatSessions()
  const s = sessions.find(s => s.id === sessionId)
  if (s) {
    s.messages.push(msg)
    s.updatedAt = Date.now()
    if (s.messages.length === 1 && msg.role === 'user') {
      s.title = msg.content.slice(0, 30) + (msg.content.length > 30 ? '…' : '')
    }
    saveChatSessions(sessions)
  }
}

export function deleteChatSession(id: string) {
  const sessions = getChatSessions().filter(s => s.id !== id)
  saveChatSessions(sessions)
}
