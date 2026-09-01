// ====== 文件存储服务 ======
// 连接 Tailscale 服务器的文件 API，支持上传/列表/下载/删除

export interface FileRecord {
  id: string
  name: string
  mime: string
  size: number
  createdAt: string
  updatedAt?: string
}

function getToken(): string | null {
  try {
    const raw = localStorage.getItem('evan-os-sync')
    if (!raw) return null
    const cfg = JSON.parse(raw)
    return cfg.token || null
  } catch { return null }
}

function getServerUrl(): string | null {
  try {
    const raw = localStorage.getItem('evan-os-sync')
    if (!raw) return null
    const cfg = JSON.parse(raw)
    return cfg.serverUrl || null
  } catch { return null }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {}
  const token = getToken()
  if (token) h['x-evan-token'] = token
  return h
}

/** 上传文件 */
export async function uploadFile(file: File): Promise<FileRecord> {
  const serverUrl = getServerUrl()
  if (!serverUrl) throw new Error('请先在云同步中配置服务器地址')

  const formData = new FormData()
  formData.append('file', file)

  const res = await fetch(`${serverUrl}/files/upload`, {
    method: 'POST',
    headers: headers(),
    body: formData,
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`上传失败 (${res.status}): ${err.slice(0, 100)}`)
  }
  return res.json()
}

/** 获取文件列表 */
export async function listFiles(): Promise<FileRecord[]> {
  const serverUrl = getServerUrl()
  if (!serverUrl) return []
  const res = await fetch(`${serverUrl}/files`, { headers: headers() })
  if (!res.ok) return []
  return res.json()
}

/** 获取文件下载 URL */
export function getFileUrl(id: string): string {
  const serverUrl = getServerUrl()
  if (!serverUrl) return ''
  const token = getToken()
  return `${serverUrl}/files/${id}${token ? `?token=${token}` : ''}`
}

/** 删除文件 */
export async function deleteFile(id: string): Promise<void> {
  const serverUrl = getServerUrl()
  if (!serverUrl) throw new Error('未配置服务器')
  const res = await fetch(`${serverUrl}/files/${id}`, {
    method: 'DELETE',
    headers: headers(),
  })
  if (!res.ok) throw new Error('删除失败')
}

/** 格式化文件大小 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** 根据 mime 类型返回图标 emoji */
export function getFileIcon(mime: string, name: string): string {
  if (mime.startsWith('image/')) return '🖼️'
  if (mime.includes('pdf')) return '📄'
  if (mime.includes('word') || name.endsWith('.doc') || name.endsWith('.docx')) return '📝'
  if (mime.includes('excel') || mime.includes('spreadsheet') || name.endsWith('.xls') || name.endsWith('.xlsx')) return '📊'
  if (mime.includes('presentation') || name.endsWith('.ppt') || name.endsWith('.pptx')) return '📽️'
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar') || mime.includes('gzip')) return '📦'
  if (mime.includes('video')) return '🎬'
  if (mime.includes('audio')) return '🎵'
  if (mime.includes('text') || mime.includes('json')) return '📃'
  return '📄'
}
