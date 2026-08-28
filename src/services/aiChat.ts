// ====== AI Chat API 服务层 ======
// 兼容 OpenAI / DeepSeek / 通义千问 / 豆包 / Kimi / 智谱 等 OpenAI 兼容格式
// Claude 走 Anthropic 格式，单独适配

import { getAiSettings } from '../config/aiProviders'

interface ChatRequest {
  messages: { role: string; content: string }[]
  signal?: AbortSignal
}

interface ChatChunk {
  content: string
  done: boolean
}

/** 流式调用 AI Chat Completions */
export async function* streamChat(request: ChatRequest): AsyncGenerator<ChatChunk> {
  const settings = getAiSettings()
  if (!settings.apiKey) throw new Error('请先在 AI 设置中配置 API Key')

  const isClaude = settings.providerId === 'claude'

  if (isClaude) {
    yield* streamClaude(request)
    return
  }

  // OpenAI 兼容格式（DeepSeek / 通义 / 豆包 / Kimi / 智谱 / OpenAI）
  const url = `${settings.baseUrl.replace(/\/$/, '')}/chat/completions`

  const body: Record<string, any> = {
    model: settings.model,
    messages: request.messages,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    top_p: settings.topP,
    stream: true,
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: request.signal,
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`API 错误 ${res.status}: ${err.slice(0, 200)}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('无法读取响应流')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') {
        yield { content: '', done: true }
        return
      }
      try {
        const parsed = JSON.parse(data)
        const delta = parsed.choices?.[0]?.delta?.content
        if (delta) {
          yield { content: delta, done: false }
        }
      } catch {}
    }
  }
  yield { content: '', done: true }
}

/** Claude Anthropic 格式 */
async function* streamClaude(request: ChatRequest): AsyncGenerator<ChatChunk> {
  const settings = getAiSettings()
  const url = `${settings.baseUrl.replace(/\/$/, '')}/v1/messages`

  const body: Record<string, any> = {
    model: settings.model,
    messages: request.messages.filter(m => m.role !== 'system'),
    max_tokens: settings.maxTokens,
    temperature: settings.temperature,
    top_p: settings.topP,
    stream: true,
  }

  // Claude system prompt 单独传
  const sysMsg = request.messages.find(m => m.role === 'system')
  if (sysMsg) body.system = sysMsg.content

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: request.signal,
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`Claude API 错误 ${res.status}: ${err.slice(0, 200)}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('无法读取响应流')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      try {
        const parsed = JSON.parse(data)
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          yield { content: parsed.delta.text, done: false }
        }
        if (parsed.type === 'message_stop') {
          yield { content: '', done: true }
          return
        }
      } catch {}
    }
  }
  yield { content: '', done: true }
}

/** 非流式调用（简单场景） */
export async function chatOnce(userMessage: string, systemPrompt?: string): Promise<string> {
  const messages: { role: string; content: string }[] = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  messages.push({ role: 'user', content: userMessage })

  let result = ''
  for await (const chunk of streamChat({ messages })) {
    if (!chunk.done) result += chunk.content
  }
  return result
}
