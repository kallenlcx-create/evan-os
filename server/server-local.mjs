// ====== Evan OS 本地服务器（SQLite-free，纯 JSON 存储）======
// 无需 MySQL/better-sqlite3，直接用 JSON 文件做持久化
// 启动: cd server && npm i express && node server-local.mjs

import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.env.PORT || 3000
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex')
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30
const DATA_DIR = path.join(process.cwd(), 'data')
const UPLOAD_DIR = path.join(process.cwd(), 'uploads')

// 确保目录存在
for (const d of [DATA_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

// ====== JSON 持久化 ======
function readJSON(name) {
  const fp = path.join(DATA_DIR, `${name}.json`)
  if (!fs.existsSync(fp)) return []
  return JSON.parse(fs.readFileSync(fp, 'utf8'))
}
function writeJSON(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(data, null, 2))
}
function readUsers() { return readJSON('users') }
function writeUsers(u) { writeJSON('users', u) }
function readData() { return readJSON('data') }
function writeData(d) { writeJSON('data', d) }
function readFiles() { return readJSON('files') }
function writeFiles(f) { writeJSON('files', f) }

// ====== Express ======
const app = express()
app.use(express.json({ limit: '2mb' }))
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-evan-token')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// ====== Auth ======
function hashPass(pass, salt) { return crypto.scryptSync(pass, salt, 32).toString('hex') }
function signToken(username) {
  const exp = Date.now() + TOKEN_TTL_MS
  const payload = `${username}.${exp}`
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
  return `${Buffer.from(payload).toString('base64url')}.${sig}`
}
function verifyToken(token) {
  try {
    const [b64, sig] = token.split('.')
    if (!b64 || !sig) return null
    const payload = Buffer.from(b64, 'base64url').toString()
    const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
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
  if (!user) return res.status(401).json({ error: '未登录' })
  req.user = user
  next()
}

// ====== 登录 ======
app.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body ?? {}
  if (!username || !password) return res.status(400).json({ error: '需要 username/password' })
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(username))) {
    return res.status(400).json({ error: '用户名仅允许字母、数字、_ 和 -' })
  }
  const users = readUsers()
  const existing = users.find(u => u.username === username)
  if (!existing) {
    const salt = crypto.randomBytes(16).toString('hex')
    users.push({ username, passhash: hashPass(password, salt), salt })
    writeUsers(users)
  } else {
    if (existing.passhash !== hashPass(password, existing.salt)) {
      return res.status(401).json({ error: '用户名或密码错误' })
    }
  }
  res.json({ token: signToken(username) })
}))

// ====== 同步 ======
app.get('/changes', auth, wrap(async (req, res) => {
  const since = String(req.query.since ?? '1970-01-01T00:00:00.000Z')
  const allData = readData()
  const userRows = allData.filter(r => r.username === req.user)
  const changes = []
  const deletions = []
  for (const row of userRows) {
    if (row.updated_at > since) {
      if (row.deleted) {
        deletions.push({ tableName: row.table_name, rowId: row.row_id, deletedAt: row.updated_at })
      } else {
        const existing = changes.find(c => c.table === row.table_name)
        const parsed = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
        if (existing) existing.rows.push(parsed)
        else changes.push({ table: row.table_name, rows: [parsed] })
      }
    }
  }
  res.json({ serverNow: new Date().toISOString(), changes, deletions })
}))

app.post('/upsert/:table', auth, wrap(async (req, res) => {
  const tableName = String(req.params.table).replace(/[^a-z_]/gi, '')
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : []
  const allData = readData()
  let accepted = 0
  for (const row of rows.slice(0, 500)) {
    if (!row?.id) continue
    const updatedAt = row.updatedAt || row.createdAt || new Date().toISOString()
    const idx = allData.findIndex(r => r.username === req.user && r.table_name === tableName && r.row_id === row.id)
    if (idx >= 0 && allData[idx].updated_at >= updatedAt) continue
    const entry = { username: req.user, table_name: tableName, row_id: row.id, data: JSON.stringify(row), updated_at: updatedAt, deleted: 0 }
    if (idx >= 0) allData[idx] = entry
    else allData.push(entry)
    accepted++
  }
  writeData(allData)
  res.json({ ok: true, accepted })
}))

app.post('/deletions', auth, wrap(async (req, res) => {
  const list = Array.isArray(req.body?.deletions) ? req.body.deletions : []
  const allData = readData()
  for (const d of list.slice(0, 500)) {
    if (!d.tableName || !d.rowId) continue
    const deletedAt = (d.deletedAt || new Date().toISOString()).slice(0, 23)
    const idx = allData.findIndex(r => r.username === req.user && r.table_name === d.tableName && r.row_id === d.rowId)
    if (idx >= 0 && allData[idx].updated_at >= deletedAt) continue
    allData.push({ username: req.user, table_name: d.tableName, row_id: d.rowId, data: JSON.stringify({ _deleted: true, id: d.rowId }), updated_at: deletedAt, deleted: 1 })
  }
  writeData(allData)
  res.json({ ok: true })
}))

// ====== CORS 代理 ======
app.post('/ai-proxy', wrap(async (req, res) => {
  const { targetUrl, method = 'POST', headers = {}, body: reqBody } = req.body ?? {}
  if (!targetUrl || typeof targetUrl !== 'string') return res.status(400).json({ error: '需要 targetUrl' })
  try {
    const u = new URL(targetUrl)
    if (u.protocol !== 'https:') return res.status(400).json({ error: '仅支持 https' })
  } catch { return res.status(400).json({ error: 'URL 无效' }) }
  const upstream = await fetch(targetUrl, {
    method, headers,
    body: typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody),
  })
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream')
  res.setHeader('Cache-Control', 'no-cache')
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
  } else { res.status(upstream.status).end() }
}))

// ====== 文件存储 ======
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
    const body = part.slice(headerEnd + 4, part.length - 2)
    const nameMatch = header.match(/name="([^"]+)"/)
    const filenameMatch = header.match(/filename="([^"]+)"/)
    const mimeMatch = header.match(/Content-Type:\s*(.+)/i)
    parts.push({
      name: nameMatch?.[1], filename: filenameMatch?.[1],
      mime: mimeMatch?.[1]?.trim() || 'application/octet-stream', data: body,
    })
    pos = next
  }
  return parts
}

app.post('/files/upload', auth, wrap(async (req, res) => {
  const ct = req.headers['content-type'] || ''
  const boundaryMatch = ct.match(/boundary=(.+)/)
  if (!boundaryMatch) return res.status(400).json({ error: '需要 multipart/form-data' })
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)
  const parts = parseMultipart(raw, boundaryMatch[1])
  const filePart = parts.find(p => p.filename)
  if (!filePart) return res.status(400).json({ error: '未找到文件' })
  const id = crypto.randomUUID()
  const ext = path.extname(filePart.filename) || ''
  const storedName = `${id}${ext}`
  const userDir = path.join(UPLOAD_DIR, req.user)
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true })
  fs.writeFileSync(path.join(userDir, storedName), filePart.data)
  const files = readFiles()
  files.push({ id, username: req.user, name: filePart.filename, stored: storedName, mime: filePart.mime, size: filePart.data.length, createdAt: new Date().toISOString() })
  writeFiles(files)
  res.json({ id, name: filePart.filename, size: filePart.data.length, mime: filePart.mime })
}))

app.get('/files', auth, wrap(async (req, res) => {
  const files = readFiles().filter(f => f.username === req.user)
    .map(f => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, createdAt: f.createdAt }))
    .reverse()
  res.json(files)
}))

app.get('/files/:id', auth, wrap(async (req, res) => {
  const files = readFiles()
  const f = files.find(x => x.id === req.params.id && x.username === req.user)
  if (!f) return res.status(404).json({ error: '文件不存在' })
  const fp = path.join(UPLOAD_DIR, req.user, f.stored)
  if (!fs.existsSync(fp)) return res.status(404).json({ error: '文件丢失' })
  res.setHeader('Content-Type', f.mime)
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`)
  res.setHeader('Content-Length', f.size)
  fs.createReadStream(fp).pipe(res)
}))

app.delete('/files/:id', auth, wrap(async (req, res) => {
  const files = readFiles()
  const idx = files.findIndex(x => x.id === req.params.id && x.username === req.user)
  if (idx === -1) return res.status(404).json({ error: '文件不存在' })
  try { fs.unlinkSync(path.join(UPLOAD_DIR, req.user, files[idx].stored)) } catch {}
  files.splice(idx, 1)
  writeFiles(files)
  res.json({ ok: true })
}))

// ====== 错误兜底 ======
app.use((err, req, res, next) => {
  console.error('[server] 错误:', err?.message ?? err)
  if (res.headersSent) return
  res.status(500).json({ error: '服务器内部错误' })
})

app.listen(PORT, () =>
  console.log(`[evan-server] listening on :${PORT} (JSON storage, no MySQL)`))
