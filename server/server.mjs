// ====== Evan OS Sync Server (参考实现) ======
// Express + MySQL。任何云服务器可部署；同库多实例 = 多地区。
//
// 启动:
//   cd server && npm i express mysql2
//   DB_HOST=... DB_USER=... DB_PASS=... DB_NAME=evan_sync SECRET=任意长随机串 node server.mjs
//
// 协议:
//   POST /login                {username,password} → {token}   （账号不存在则自动注册）
//   GET  /changes?since=ISO    header x-evan-token
//                              → {serverNow, changes:[{table,rows}], deletions:[...]}
//   POST /upsert/:table        {rows:[...]}                     → {ok,accepted}
//   POST /deletions            {deletions:[{tableName,rowId,deletedAt}]} → {ok}
//
// 存储：每表统一 data JSON 列 + updated_at 索引列 —— 免 schema 迁移，
//      需要时可用 MySQL JSON_EXTRACT 建视图查询。

import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'

const PORT = process.env.PORT || 3000
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex')
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 天

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'evan_sync',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
})

const app = express()
// 认证/写入路由单独限制 body 大小（全局 20mb 过宽，易被单请求吃内存）
app.use(express.json({ limit: '2mb' }))
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*') // 上线后建议改为你的 Pages 域名
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-evan-token,x-evan-file-id')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// async 错误统一转发给兜底中间件（Express4 不捕获 async rejection）
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// ---------- 登录限流（内存滑动窗口，按 IP+用户名） ----------
const loginHits = new Map()
const LOGIN_WINDOW_MS = 10 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 10
function loginRateLimited(key) {
  const nowMs = Date.now()
  const arr = (loginHits.get(key) ?? []).filter(t => nowMs - t < LOGIN_WINDOW_MS)
  arr.push(nowMs)
  loginHits.set(key, arr)
  return arr.length > LOGIN_MAX_ATTEMPTS
}

// ---------- 初始化 ----------
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username VARCHAR(64) PRIMARY KEY,
      passhash VARCHAR(128) NOT NULL,
      salt VARCHAR(64) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS data (
      username VARCHAR(64) NOT NULL,
      table_name VARCHAR(64) NOT NULL,
      row_id VARCHAR(80) NOT NULL,
      data JSON NOT NULL,
      updated_at TIMESTAMP(3) NOT NULL,
      deleted TINYINT DEFAULT 0,
      PRIMARY KEY (username, table_name, row_id),
      INDEX idx_updated (username, updated_at)
    ) CHARACTER SET utf8mb4`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id VARCHAR(80) PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      stored_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(128) NOT NULL,
      size BIGINT NOT NULL,
      path VARCHAR(512) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (username)
    ) CHARACTER SET utf8mb4`)
  // 确保上传目录存在
  const uploadDir = path.join(process.cwd(), 'uploads')
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })
  console.log('[sync-server] storage ready')
}

// ---------- 认证 ----------
function hashPass(pass, salt) {
  return crypto.scryptSync(pass, salt, 32).toString('hex')
}
function signToken(username) {
  const exp = Date.now() + TOKEN_TTL_MS
  const payload = `${username}.${exp}`
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
  return `${Buffer.from(payload).toString('base64url')}.${sig}`
}
function verifyToken(token) {
  try {
    const [b64, sig] = token.split('.')
    if (!b64 || !sig || sig.length !== crypto.createHmac('sha256', SECRET).update('x').digest('hex').length) return null
    const payload = Buffer.from(b64, 'base64url').toString()
    const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
    // username 可能含 '.'：以最后一个 '.' 分隔（exp 恒为数字段）
    const sep = payload.lastIndexOf('.')
    if (sep <= 0) return null
    const username = payload.slice(0, sep)
    const exp = Number(payload.slice(sep + 1))
    if (!Number.isFinite(exp) || exp < Date.now()) return null
    return username
  } catch { return null }
}

function auth(req, res, next) {
  const token = req.headers['x-evan-token']
  const user = verifyToken(String(token ?? ''))
  if (!user) return res.status(401).json({ error: '未登录或令牌过期' })
  req.user = user
  next()
}

app.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body ?? {}
  if (!username || !password) return res.status(400).json({ error: '需要 username/password' })
  // 用户名白名单：字母/数字/下划线/短横线，防 '.' 等字符破坏令牌解析，也挡注入类输入
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(username))) {
    return res.status(400).json({ error: '用户名仅允许字母、数字、_ 和 -（1-64 位）' })
  }
  const rlKey = `${req.socket.remoteAddress}:${username}`
  if (loginRateLimited(rlKey)) {
    return res.status(429).json({ error: '尝试过于频繁，请 10 分钟后再试' })
  }
  const [rows] = await pool.query('SELECT passhash, salt FROM users WHERE username = ?', [username])
  if (rows.length === 0) {
    // 自动注册
    const salt = crypto.randomBytes(16).toString('hex')
    await pool.query('INSERT INTO users (username, passhash, salt) VALUES (?,?,?)',
      [username, hashPass(password, salt), salt])
  } else {
    if (rows[0].passhash !== hashPass(password, rows[0].salt)) {
      // 统一失败文案，不区分「用户不存在/密码错误」，防止用户名枚举
      return res.status(401).json({ error: '用户名或密码错误' })
    }
  }
  res.json({ token: signToken(username) })
}))

// ---------- 拉取变更 ----------
app.get('/changes', auth, wrap(async (req, res) => {
  const since = String(req.query.since ?? '1970-01-01T00:00:00.000Z')
  const serverNow = new Date().toISOString()

  const [dataRows] = await pool.query(
    'SELECT table_name, row_id, data FROM data WHERE username = ? AND updated_at > ? AND deleted = 0',
    [req.user, since])
  const [delRows] = await pool.query(
    'SELECT table_name, row_id, updated_at AS deleted_at FROM data WHERE username = ? AND updated_at > ? AND deleted = 1',
    [req.user, since])

  const changesMap = new Map()
  for (const row of dataRows) {
    if (!changesMap.has(row.table_name)) changesMap.set(row.table_name, [])
    const parsed = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
    changesMap.get(row.table_name).push(parsed)
  }
  const deletions = delRows.map(d => ({
    tableName: d.table_name,
    rowId: d.row_id,
    deletedAt: new Date(d.deleted_at).toISOString(),
  }))

  res.json({
    serverNow,
    changes: [...changesMap.entries()].map(([table, rows]) => ({ table, rows })),
    deletions,
  })
}))

// ---------- 推送行 ----------
app.post('/upsert/:table', auth, wrap(async (req, res) => {
  const tableName = String(req.params.table).replace(/[^a-z_]/gi, '')
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : []
  let accepted = 0

  for (const row of rows.slice(0, 500)) {
    if (!row?.id) continue
    const updatedAt = row.updatedAt || row.createdAt || new Date().toISOString()

    // LWW 服务端守门：只接受比已存记录更新的版本
    const [existing] = await pool.query(
      'SELECT updated_at FROM data WHERE username=? AND table_name=? AND row_id=?',
      [req.user, tableName, row.id])
    if (existing.length > 0 && new Date(existing[0].updated_at).getTime() >= Date.parse(updatedAt)) {
      continue
    }

    await pool.query(
      `INSERT INTO data (username, table_name, row_id, data, updated_at, deleted)
       VALUES (?,?,?,?,?,0)
       ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at), deleted = 0`,
      [req.user, tableName, row.id, JSON.stringify({ ...row }), updatedAt.slice(0, 23)])
    accepted++
  }
  res.json({ ok: true, accepted })
}))

// ---------- 推送删除 ----------
app.post('/deletions', auth, wrap(async (req, res) => {
  const list = Array.isArray(req.body?.deletions) ? req.body.deletions : []
  for (const d of list.slice(0, 500)) {
    if (!d.tableName || !d.rowId) continue
    const deletedAt = (d.deletedAt || new Date().toISOString()).slice(0, 23)
    const [existing] = await pool.query(
      'SELECT updated_at FROM data WHERE username=? AND table_name=? AND row_id=?',
      [req.user, d.tableName, d.rowId])
    if (existing.length > 0 && new Date(existing[0].updated_at).getTime() >= Date.parse(deletedAt)) {
      continue
    }
    await pool.query(
      `INSERT INTO data (username, table_name, row_id, data, updated_at, deleted)
       VALUES (?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE deleted = 1, updated_at = VALUES(updated_at), data = JSON_OBJECT('_deleted', true, 'id', VALUES(row_id))`,
      [req.user, d.tableName, d.rowId, JSON.stringify({ _deleted: true, id: d.rowId }), deletedAt])
  }
  res.json({ ok: true })
}))

// ---------- AI CORS 代理 ----------
// POST /ai-proxy  { targetUrl, method, headers, body }
// 转发请求到目标 API，解决浏览器跨域问题
app.post('/ai-proxy', wrap(async (req, res) => {
  const { targetUrl, method = 'POST', headers = {}, body: reqBody } = req.body ?? {}
  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: '需要 targetUrl' })
  }
  // 安全校验：只允许 https 请求
  try {
    const u = new URL(targetUrl)
    if (u.protocol !== 'https:') return res.status(400).json({ error: '仅支持 https 目标' })
  } catch {
    return res.status(400).json({ error: 'targetUrl 格式无效' })
  }

  // 转发请求
  const upstream = await fetch(targetUrl, {
    method,
    headers,
    body: typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody),
  })

  // 流式回传（支持 SSE）
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  if (upstream.body) {
    const reader = upstream.body.getReader()
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) { res.end(); return }
        res.write(value)
      }
    }
    await pump()
  } else {
    res.status(upstream.status).end()
  }
}))

// ---------- 文件存储 ----------
// POST /files/upload   multipart/form-data  → { id, name, size, mime }
// GET  /files           → [{ id, name, size, mime, createdAt }]
// GET  /files/:id       → 文件内容 (Content-Type: 原始 mime)
// DELETE /files/:id     → { ok }

// 简易 multipart 解析（无 multer 依赖）
function parseMultipart(buf, boundary) {
  const parts = []
  const boundaryBuf = Buffer.from('--' + boundary)
  let pos = 0
  while (pos < buf.length) {
    const start = buf.indexOf(boundaryBuf, pos)
    if (start === -1) break
    const next = buf.indexOf(boundaryBuf, start + boundaryBuf.length)
    if (next === -1) break
    const part = buf.slice(start + boundaryBuf.length, next)
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) { pos = next; continue }
    const header = part.slice(0, headerEnd).toString()
    const body = part.slice(headerEnd + 4, part.length - 2) // strip trailing \r\n
    const nameMatch = header.match(/name="([^"]+)"/)
    const filenameMatch = header.match(/filename="([^"]+)"/)
    const mimeMatch = header.match(/Content-Type:\s*(.+)/i)
    parts.push({
      name: nameMatch?.[1],
      filename: filenameMatch?.[1],
      mime: mimeMatch?.[1]?.trim() || 'application/octet-stream',
      data: body,
    })
    pos = next
  }
  return parts
}

app.post('/files/upload', auth, wrap(async (req, res) => {
  const ct = req.headers['content-type'] || ''
  const boundaryMatch = ct.match(/boundary=(.+)/)
  if (!boundaryMatch) return res.status(400).json({ error: '需要 multipart/form-data' })

  // 收集原始 body
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)

  const parts = parseMultipart(raw, boundaryMatch[1])
  const filePart = parts.find(p => p.filename)
  if (!filePart) return res.status(400).json({ error: '未找到文件' })

  const id = crypto.randomUUID()
  const ext = path.extname(filePart.filename) || ''
  const storedName = `${id}${ext}`
  const uploadDir = path.join(process.cwd(), 'uploads', req.user)
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })
  const filePath = path.join(uploadDir, storedName)
  fs.writeFileSync(filePath, filePart.data)

  await pool.query(
    `INSERT INTO files (id, username, original_name, stored_name, mime_type, size, path)
     VALUES (?,?,?,?,?,?,?)`,
    [id, req.user, filePart.filename, storedName, filePart.mime, filePart.data.length, filePath])

  res.json({ id, name: filePart.filename, size: filePart.data.length, mime: filePart.mime })
}))

app.get('/files', auth, wrap(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, original_name AS name, mime_type AS mime, size, created_at AS createdAt, updated_at AS updatedAt FROM files WHERE username = ? ORDER BY created_at DESC',
    [req.user])
  res.json(rows)
}))

app.get('/files/:id', auth, wrap(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT original_name, mime_type, path, size FROM files WHERE id = ? AND username = ?',
    [req.params.id, req.user])
  if (rows.length === 0) return res.status(404).json({ error: '文件不存在' })
  const file = rows[0]
  res.setHeader('Content-Type', file.mime_type)
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`)
  res.setHeader('Content-Length', file.size)
  fs.createReadStream(file.path).pipe(res)
}))

app.delete('/files/:id', auth, wrap(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT path FROM files WHERE id = ? AND username = ?',
    [req.params.id, req.user])
  if (rows.length === 0) return res.status(404).json({ error: '文件不存在' })
  // 删除磁盘文件
  try { fs.unlinkSync(rows[0].path) } catch {}
  await pool.query('DELETE FROM files WHERE id = ? AND username = ?', [req.params.id, req.user])
  res.json({ ok: true })
}))

// 兜底错误中间件：DB 宕机/非法参数等不再悬挂请求，也不泄漏 stack
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[sync-server] 错误:', err?.message ?? err)
  if (res.headersSent) return
  res.status(500).json({ error: '服务器内部错误' })
})

init().then(() => {
  app.listen(PORT, () =>
    console.log(`[sync-server] listening on :${PORT}${process.env.SECRET ? '' : ' (WARNING: SECRET 未设置，已用随机值，重启后所有令牌失效)'}`))
})
