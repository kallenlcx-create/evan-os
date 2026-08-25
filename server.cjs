// ====== Evan OS Sync Server ======
// 运行在旧笔记本上，作为 Evan OS 的 Web 服务器 + 数据同步中心
// 所有设备通过 Tailscale IP 访问，数据通过 /api/sync 同步

const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = 3456  // Evan OS 同步服务器端口
const PUBLIC_DIR = path.join(__dirname, 'dist')
const DATA_DIR = path.join(__dirname, 'data')
const BACKUP_FILE = path.join(DATA_DIR, 'backup.json')
const HISTORY_DIR = path.join(DATA_DIR, 'history') // 保留最近 10 个版本

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true })

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(data))
}

function readJsonFile(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf-8')) }
  catch { return null }
}

function writeJsonFile(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8')
}

// 保存历史版本（最多 10 个）
function saveHistory(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const historyFile = path.join(HISTORY_DIR, `backup-${timestamp}.json`)
  writeJsonFile(historyFile, data)
  
  // 清理旧版本
  const files = fs.readdirSync(HISTORY_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
  if (files.length > 10) {
    files.slice(0, files.length - 10).forEach(f => {
      fs.unlinkSync(path.join(HISTORY_DIR, f))
    })
  }
}

// ====== API 路由 ======

function handleAPI(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // GET /api/sync/pull — 拉取最新数据
  if (url.pathname === '/api/sync/pull' && req.method === 'GET') {
    const data = readJsonFile(BACKUP_FILE)
    if (!data) {
      return json(res, { ok: true, data: null, message: '暂无同步数据' })
    }
    const stat = fs.statSync(BACKUP_FILE)
    return json(res, { 
      ok: true, 
      data, 
      syncedAt: stat.mtime.toISOString(),
      size: stat.size 
    })
  }

  // POST /api/sync/push — 推送数据
  if (url.pathname === '/api/sync/push' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try {
        const payload = JSON.parse(body)
        const data = payload.data || payload
        
        // 保存历史版本
        const oldData = readJsonFile(BACKUP_FILE)
        if (oldData) saveHistory(oldData)
        
        // 写入新数据
        writeJsonFile(BACKUP_FILE, data)
        
        const stat = fs.statSync(BACKUP_FILE)
        json(res, { 
          ok: true, 
          message: '同步成功', 
          syncedAt: new Date().toISOString(),
          size: stat.size 
        })
      } catch (e) {
        json(res, { ok: false, error: `数据格式错误: ${e.message}` }, 400)
      }
    })
    return
  }

  // GET /api/sync/status — 同步状态
  if (url.pathname === '/api/sync/status' && req.method === 'GET') {
    if (!fs.existsSync(BACKUP_FILE)) {
      return json(res, { ok: true, hasData: false })
    }
    const stat = fs.statSync(BACKUP_FILE)
    const historyFiles = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'))
    return json(res, {
      ok: true,
      hasData: true,
      syncedAt: stat.mtime.toISOString(),
      size: stat.size,
      historyCount: historyFiles.length
    })
  }

  // GET /api/sync/history — 历史版本列表
  if (url.pathname === '/api/sync/history' && req.method === 'GET') {
    const files = fs.readdirSync(HISTORY_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .map(f => {
        const fp = path.join(HISTORY_DIR, f)
        const stat = fs.statSync(fp)
        return { name: f, time: stat.mtime.toISOString(), size: stat.size }
      })
    return json(res, { ok: true, history: files })
  }

  // GET /api/sync/history/:name — 恢复历史版本
  if (url.pathname.startsWith('/api/sync/history/') && req.method === 'GET') {
    const name = decodeURIComponent(url.pathname.replace('/api/sync/history/', ''))
    const filepath = path.join(HISTORY_DIR, name)
    if (!fs.existsSync(filepath)) {
      return json(res, { ok: false, error: '版本不存在' }, 404)
    }
    const data = readJsonFile(filepath)
    return json(res, { ok: true, data, version: name })
  }

  // 404
  json(res, { ok: false, error: '未知 API 路径' }, 404)
}

// ====== 静态文件服务 ======

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url
  filePath = path.join(PUBLIC_DIR, filePath)
  
  // 安全：防止路径遍历
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  const ext = path.extname(filePath)
  const contentType = MIME[ext] || 'application/octet-stream'

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: 所有非文件请求返回 index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, fallback) => {
        if (err2) {
          res.writeHead(500)
          res.end('Internal Server Error')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(fallback)
      })
      return
    }
    res.writeHead(200, { 'Content-Type': contentType })
    res.end(data)
  })
}

// ====== 启动服务器 ======

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    handleAPI(req, res)
  } else {
    serveStatic(req, res)
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log('')
  console.log('  🧠 Evan OS Sync Server')
  console.log('  ┌─────────────────────────────────────┐')
  console.log(`  │  Web:      http://0.0.0.0:${PORT}          │`)
  console.log(`  │  Sync API: http://0.0.0.0:${PORT}/api/sync │`)
  console.log(`  │  Data:     ${DATA_DIR}`)
  console.log('  └─────────────────────────────────────┘')
  console.log('')
})