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
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

const PORT = process.env.PORT || 3000
// SECRET 持久化：未配环境变量时落盘 secret.key，重启不丢令牌
function loadSecret(){
  if(process.env.SECRET) return process.env.SECRET
  const p = path.join(process.cwd(), 'secret.key')
  try{ if(fs.existsSync(p)) return fs.readFileSync(p,'utf8').trim() }catch{}
  const s=crypto.randomBytes(32).toString('hex')
  try{ fs.writeFileSync(p,s,'utf8') }catch{}
  return s
}
const SECRET = loadSecret()
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
// 内存降级（MySQL 不可用时）+ 文件持久（重启不丢绑定）
const memUsers = new Map()
const memEmailAccounts = new Map() // username -> accounts[]
let dbReady = true
const EMAIL_ACCOUNTS_FILE = path.join(process.cwd(), 'email_accounts.json')
function loadEmailAccounts(){
  try{ if(fs.existsSync(EMAIL_ACCOUNTS_FILE)){ const j=JSON.parse(fs.readFileSync(EMAIL_ACCOUNTS_FILE,'utf8')); for(const [k,v] of Object.entries(j)) memEmailAccounts.set(k, v) } }catch{}
}
function saveEmailAccounts(){ try{ fs.writeFileSync(EMAIL_ACCOUNTS_FILE, JSON.stringify(Object.fromEntries(memEmailAccounts), null, 2)) }catch{} }
const memData = new Map()
const memDeletions = new Map()
const DATA_FILE = path.join(process.cwd(), 'data.json')
function loadDataFile(){
  try{ if(fs.existsSync(DATA_FILE)){ const j=JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); for(const [user, tables] of Object.entries(j)){ const tm=new Map(); for(const [t, rows] of Object.entries(tables)){ const rm=new Map(); for(const [id, v] of Object.entries(rows)) rm.set(id, v); tm.set(t, rm) } memData.set(user, tm) } } }catch{}
  try{ const p=DATA_FILE.replace('data.json','deletions.json'); if(fs.existsSync(p)){ const jd=JSON.parse(fs.readFileSync(p,'utf8')); for(const [k,v] of Object.entries(jd)) memDeletions.set(k, v) } }catch{}
}
function saveDataFile(){
  try{
    const out={}; for(const [user, tm] of memData) { out[user]={}; for(const [t, rm] of tm) { out[user][t]={}; for(const [id, v] of rm) out[user][t][id]=v } }
    fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2))
    fs.writeFileSync(DATA_FILE.replace('data.json','deletions.json'), JSON.stringify(Object.fromEntries(memDeletions), null, 2))
  }catch{}
}
loadEmailAccounts()
loadDataFile()

const app = express()
// 认证/写入路由单独限制 body 大小（全局 20mb 过宽，易被单请求吃内存）
app.use(express.json({ limit: '2mb' }))
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*') // 上线后建议改为你的 Pages 域名
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-evan-token,x-evan-file-id,Bypass-Tunnel-Reminder')
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

// ---------- 初始化（MySQL 不可用时降级为内存+文件，邮件IMAP仍可用） ----------
async function init() {
  try{
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
  // 邮件账号表（真实IMAP）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_accounts (
      id VARCHAR(80) PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      email VARCHAR(128) NOT NULL,
      provider VARCHAR(20) NOT NULL,
      imap_host VARCHAR(128) NOT NULL,
      imap_port INT NOT NULL,
      smtp_host VARCHAR(128) NOT NULL,
      smtp_port INT NOT NULL,
      auth_enc TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (username)
    ) CHARACTER SET utf8mb4`).catch(()=>{})
  // 服务端邮件库：绑定一次全量入库，之后只增量
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mail_sync_state (
      account_id VARCHAR(80) NOT NULL,
      folder VARCHAR(128) NOT NULL,
      uidvalidity BIGINT DEFAULT 0,
      last_uid BIGINT DEFAULT 0,
      uidnext BIGINT DEFAULT 0,
      full_sync_done TINYINT DEFAULT 0,
      last_sync_at TIMESTAMP(3) NULL,
      PRIMARY KEY (account_id, folder)
    ) CHARACTER SET utf8mb4`).catch(()=>{})
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mail_messages (
      account_id VARCHAR(80) NOT NULL,
      folder VARCHAR(128) NOT NULL,
      uid BIGINT NOT NULL,
      message_id VARCHAR(512) DEFAULT '',
      gmail_msgid VARCHAR(64) DEFAULT '',
      gmail_threadid VARCHAR(64) DEFAULT '',
      subject VARCHAR(1024) DEFAULT '',
      from_addr VARCHAR(512) DEFAULT '',
      from_name VARCHAR(256) DEFAULT '',
      to_addr VARCHAR(1024) DEFAULT '',
      msg_date DATETIME NULL,
      is_read TINYINT DEFAULT 0,
      has_attachment TINYINT DEFAULT 0,
      body_text MEDIUMTEXT,
      body_cached TINYINT DEFAULT 0,
      updated_at TIMESTAMP(3) NOT NULL,
      PRIMARY KEY (account_id, folder, uid),
      INDEX idx_gmail (account_id, gmail_msgid),
      INDEX idx_date (account_id, folder, msg_date),
      FULLTEXT INDEX ft_mail (subject, from_addr, to_addr, body_text) WITH PARSER ngram
    ) CHARACTER SET utf8mb4`).catch(()=>{})
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mail_threads (
      account_id VARCHAR(80) NOT NULL,
      thread_id VARCHAR(64) NOT NULL,
      subject_norm VARCHAR(512) DEFAULT '',
      count INT DEFAULT 0,
      last_date DATETIME NULL,
      PRIMARY KEY (account_id, thread_id)
    ) CHARACTER SET utf8mb4`).catch(()=>{})
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mail_attachments (
      account_id VARCHAR(80) NOT NULL,
      folder VARCHAR(128) NOT NULL,
      uid BIGINT NOT NULL,
      filename VARCHAR(512) DEFAULT '',
      size BIGINT DEFAULT 0,
      mime VARCHAR(128) DEFAULT '',
      path VARCHAR(512) DEFAULT '',
      PRIMARY KEY (account_id, folder, uid, filename(191)),
      INDEX idx_uid (account_id, folder, uid)
    ) CHARACTER SET utf8mb4`).catch(()=>{})
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mail_drafts (
      id VARCHAR(80) PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      account_id VARCHAR(80) NOT NULL,
      to_addr TEXT,
      cc_addr TEXT,
      subject VARCHAR(1024) DEFAULT '',
      body_html MEDIUMTEXT,
      body_text MEDIUMTEXT,
      template_id VARCHAR(80) DEFAULT '',
      updated_at TIMESTAMP(3) NOT NULL,
      INDEX idx_user (username, updated_at)
    ) CHARACTER SET utf8mb4`).catch(()=>{})
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mail_outbox (
      id VARCHAR(80) PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      account_id VARCHAR(80) NOT NULL,
      to_list TEXT NOT NULL,
      subject VARCHAR(1024) DEFAULT '',
      body_html MEDIUMTEXT,
      body_text MEDIUMTEXT,
      status VARCHAR(16) DEFAULT 'queued',
      try_count INT DEFAULT 0,
      next_try_at TIMESTAMP(3) NULL,
      error VARCHAR(512) DEFAULT '',
      idempotency_key VARCHAR(80) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_status (username, status, next_try_at),
      UNIQUE INDEX idx_idem (idempotency_key)
    ) CHARACTER SET utf8mb4`).catch(()=>{})
  console.log('[sync-server] storage ready')
  }catch(e){
    dbReady=false
    console.log('[sync-server] MySQL 未连接，使用内存+文件模式（邮件IMAP正常）')
  }
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
  if(dbReady){
    const [rows] = await pool.query('SELECT passhash, salt FROM users WHERE username = ?', [username])
    if (rows.length === 0) {
      const salt = crypto.randomBytes(16).toString('hex')
      await pool.query('INSERT INTO users (username, passhash, salt) VALUES (?,?,?)', [username, hashPass(password, salt), salt])
    } else {
      if (rows[0].passhash !== hashPass(password, rows[0].salt)) return res.status(401).json({ error: '用户名或密码错误' })
    }
  } else {
    const rec = memUsers.get(username)
    if (!rec) { const salt=crypto.randomBytes(16).toString('hex'); memUsers.set(username,{passhash:hashPass(password,salt), salt}) }
    else if (rec.passhash !== hashPass(password, rec.salt)) return res.status(401).json({ error: '用户名或密码错误' })
  }
  res.json({ token: signToken(username) })
}))

// ---------- 拉取变更 ----------
app.get('/changes', auth, wrap(async (req, res) => {
  if(!dbReady){
    const since = String(req.query.since ?? '1970-01-01T00:00:00.000Z')
    const tm = memData.get(req.user) || new Map()
    const changes=[]
    for(const [table, rm] of tm){
      const rows=[...rm.values()].filter(r=> r.updatedAt>since && !r.deleted).map(r=> r.data)
      if(rows.length) changes.push({ table, rows })
    }
    const dels=(memDeletions.get(req.user)||[]).filter(d=> d.deletedAt>since)
    return res.json({ serverNow: new Date().toISOString(), changes, deletions: dels })
  }
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
  if(!dbReady){
    const tableName = String(req.params.table).replace(/[^a-z_]/gi, '')
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : []
    let tm = memData.get(req.user); if(!tm){ tm=new Map(); memData.set(req.user, tm) }
    let rm = tm.get(tableName); if(!rm){ rm=new Map(); tm.set(tableName, rm) }
    let accepted=0
    for(const row of rows.slice(0,500)){
      if(!row?.id) continue
      const updatedAt = row.updatedAt || row.createdAt || new Date().toISOString()
      const cur = rm.get(row.id)
      if(cur && cur.updatedAt >= updatedAt) continue
      rm.set(row.id, { data:{...row}, updatedAt, deleted:false })
      accepted++
    }
    saveDataFile()
    return res.json({ ok:true, accepted })
  }
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
  if(!dbReady){
    const list = Array.isArray(req.body?.deletions) ? req.body.deletions : []
    const arr = memDeletions.get(req.user)||[]
    for(const d of list.slice(0,500)){
      if(!d.tableName||!d.rowId) continue
      const tm=memData.get(req.user); const rm=tm?.get(d.tableName)
      if(rm?.has(d.rowId)) rm.set(d.rowId, { data:{_deleted:true, id:d.rowId}, updatedAt: d.deletedAt||new Date().toISOString(), deleted:true })
      arr.push({ tableName:d.tableName, rowId:d.rowId, deletedAt: d.deletedAt||new Date().toISOString() })
    }
    memDeletions.set(req.user, arr)
    saveDataFile()
    return res.json({ ok:true })
  }
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
// GET /ai-proxy-health  代理连通性探针
app.get('/ai-proxy-health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})
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

  // 转发请求（上游 10 分钟总超时：只防 hang 死，不断正常长流）
  let upstream
  try {
    upstream = await fetch(targetUrl, {
      method,
      headers,
      body: typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody),
      signal: AbortSignal.timeout(600000),
    })
  } catch (e) {
    return res.status(502).json({ error: '上游模型 API 不可达或超时：' + String(e.message || e).slice(0, 200) })
  }

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

// ---------- 真实邮件 IMAP ----------
// 加密：用 SECRET 对授权码做 AES-GCM（与前端脱敏一致）
function encAuth(plain){
  const iv=crypto.randomBytes(12)
  const cipher=crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(SECRET).digest(), iv)
  const enc=Buffer.concat([cipher.update(plain,'utf8'), cipher.final()])
  const tag=cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}
function decAuth(encStr){
  try{
    const [ivHex,tagHex,encHex]=String(encStr).split(':')
    const iv=Buffer.from(ivHex,'hex'), tag=Buffer.from(tagHex,'hex'), enc=Buffer.from(encHex,'hex')
    const decipher=crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(SECRET).digest(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  }catch{ return encStr }
}

// 绑定账号（测试连接后入库）
app.post('/email/accounts', auth, wrap(async (req,res)=>{
  const { provider, email, imap_host, imap_port, smtp_host, smtp_port, pass } = req.body||{}
  if(!email||!pass) return res.status(400).json({error:'需要 email 与授权码/应用密码'})
  let ih=imap_host, ip=Number(imap_port||993), sh=smtp_host, sp=Number(smtp_port||465)
  // 校验 IMAP 连通性（5s超时）
  const client=makeImapClient({ host: ih, port: ip, user:email, pass, socketTimeout: 8000 })
  try{ await client.connect(); await client.logout(); }catch(e){ return res.status(400).json({error:'IMAP连接失败：'+(e.message||e)}) }
  // 去重：同邮箱只更新
  if(dbReady){
    const [exists]=await pool.query('SELECT id FROM email_accounts WHERE username=? AND email=?',[req.user, email])
    if(exists.length>0){
      const id=exists[0].id
      await pool.query('UPDATE email_accounts SET auth_enc=?, imap_host=?, imap_port=?, smtp_host=?, smtp_port=? WHERE id=?',[encAuth(String(pass)), ih, ip, sh||'', sp||0, id])
      startMailWatcher(id, req.user)
      return res.json({ id, email, provider })
    }
  } else {
    const arr0=memEmailAccounts.get(req.user)||[]
    const found=arr0.find(a=> a.email.toLowerCase()===email.toLowerCase())
    if(found){ found.auth_enc=encAuth(String(pass)); found.imap_host=ih; found.imap_port=ip; found.smtp_host=sh; found.smtp_port=sp||0; saveEmailAccounts(); return res.json({ id: found.id, email, provider }) }
  }
  const id=crypto.randomUUID()
  if(dbReady){
    await pool.query(`INSERT INTO email_accounts (id, username, email, provider, imap_host, imap_port, smtp_host, smtp_port, auth_enc) VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, req.user, email, provider||'custom', ih, ip, sh||'', sp||0, encAuth(String(pass))])
  } else {
    const arr=memEmailAccounts.get(req.user)||[]; arr.push({ id, email, provider:provider||'custom', imap_host:ih, imap_port:ip, smtp_host:sh, smtp_port:sp||0, auth_enc: encAuth(String(pass)), created_at: new Date().toISOString()}); memEmailAccounts.set(req.user, arr); saveEmailAccounts()
  }
  if(dbReady) startMailWatcher(id, req.user) // 绑定即启动常驻监听
  res.json({ id, email, provider })
}))
app.get('/email/accounts', auth, wrap(async (req,res)=>{
  if(!dbReady){
    const rows=(memEmailAccounts.get(req.user)||[]); return res.json(rows)
  }
  const [rows]=await pool.query('SELECT id,email,provider,imap_host,imap_port,smtp_host,smtp_port,created_at FROM email_accounts WHERE username=? ORDER BY created_at DESC',[req.user])
  res.json(rows)
}))
app.delete('/email/accounts/:id', auth, wrap(async (req,res)=>{
  if(!dbReady){ const arr=(memEmailAccounts.get(req.user)||[]).filter(a=> a.id!==req.params.id); memEmailAccounts.set(req.user,arr); saveEmailAccounts(); return res.json({ok:true}) }
  await pool.query('DELETE FROM email_accounts WHERE id=? AND username=?',[req.params.id, req.user]); stopMailWatcher(req.params.id); res.json({ok:true})
}))
// 预读邮件总数：GET /email/count/:id（默认查 [Gmail]/All Mail 获取全部邮件数）
app.get('/email/count/:id', auth, wrap(async (req,res)=>{
  const accountId=req.params.id
  const folder=String(req.query.folder||'[Gmail]/All Mail')
  let acc=null
  if(dbReady){
    const [rows]=await pool.query('SELECT * FROM email_accounts WHERE id=? AND username=?',[accountId, req.user])
    if(rows.length===0) return res.status(404).json({error:'账号不存在'})
    acc=rows[0]
  } else {
    const arr=memEmailAccounts.get(req.user)||[]
    acc=arr.find(a=> a.id===accountId)
    if(!acc) return res.status(404).json({error:'账号不存在'})
  }
  const pass=decAuth(acc.auth_enc)
  const client=makeImapClient({ host:acc.imap_host, port:acc.imap_port, user:acc.email, pass, socketTimeout:30000 })
  try{
    await client.connect()
    const lock=await client.getMailboxLock(folder)
    try{
      const existsCount=client.mailbox.exists||0
      let searchCount=0
      try{ const r=await client.search('ALL'); if(Array.isArray(r)) searchCount=r.length }catch{}
      const total=Math.max(existsCount, searchCount)
      console.log(`[email-count] ${acc.email} EXISTS=${existsCount} SEARCH=${searchCount} → ${total}`)
      res.json({ total })
    }finally{ lock.release() }
  }catch(e){
    res.status(500).json({error:'获取邮件数失败：'+(e.message||e)})
  }finally{
    await client.logout().catch(()=>{})
  }
}))

// 真实拉取：GET /email/sync/:id?limit=30&folder=INBOX&search=UNSEEN&sinceUid=12345
app.get('/email/sync/:id', auth, wrap(async (req,res)=>{
  const accountId=req.params.id
  let limit = Number(req.query.limit||20)
  if(req.query.limit==='all' || limit===0) limit=1000000
  limit=Math.min(1000000, Math.max(1, limit))
  const offset = Math.max(0, Number(req.query.offset||0))
  const folder=String(req.query.folder||'[Gmail]/All Mail')
  const searchQuery=String(req.query.search||'').trim()
  const sinceUid = Number(req.query.sinceUid)||0 // 新增：增量同步，只拉UID > sinceUid的邮件
  let acc=null
  if(dbReady){
    const [rows]=await pool.query('SELECT * FROM email_accounts WHERE id=? AND username=?',[accountId, req.user])
    if(rows.length===0) return res.status(404).json({error:'账号不存在'})
    acc=rows[0]
  } else {
    const arr=memEmailAccounts.get(req.user)||[]
    acc=arr.find(a=> a.id===accountId)
    if(!acc) return res.status(404).json({error:'账号不存在'})
  }
  const pass=decAuth(acc.auth_enc)
  const client=makeImapClient({ host:acc.imap_host, port:acc.imap_port, user:acc.email, pass, socketTimeout:180000 })
  await client.connect()
  const lock=await client.getMailboxLock(folder)
  try{
    const total=client.mailbox.exists
    const batchSize=500
    const headersOnly = req.query.headersOnly === 'true'
    const fields = headersOnly
      ? { envelope:true, flags:true, uid:true }
      : { envelope:true, source:true, flags:true, uid:true }

    let uids = []
    if(sinceUid > 0){
      // 增量同步模式：只拉UID > sinceUid的邮件
      try{
        const searchResult = await client.search({uid:{since:sinceUid}}, { uid:true })
        // imapflow search+{uid:true} 返回数字UID数组 [123,456,...]，不是对象
        uids = (Array.isArray(searchResult) ? searchResult : []).filter(uid => uid > sinceUid)
        uids.sort((a,b) => b - a)
        uids = uids.slice(offset, offset + limit)
        console.log(`[email-sync] 增量同步 sinceUid=${sinceUid}，找到 ${uids.length} 封新邮件`)
      }catch(e){
        console.log(`[email-sync] 增量搜索失败:`, e.message)
      }
    } else if(searchQuery){
      // IMAP SEARCH 模式：按条件搜索（如 UNSEEN）
      // imapflow 不支持字符串格式，必须转为对象格式
      try{
        const searchCriteria = searchQuery.toUpperCase() === 'UNSEEN' ? {unseen: true} : searchQuery
        const searchResult = await client.search(searchCriteria, { uid:true })
        // imapflow search+{uid:true} 返回数字UID数组
        uids = Array.isArray(searchResult) ? [...searchResult] : []
        uids.sort((a,b) => b - a)
        uids = uids.slice(offset, offset + limit)
        console.log(`[email-sync] SEARCH "${searchQuery}" → ${uids.length} 封`)
      }catch(searchErr){
        console.log(`[email-sync] SEARCH "${searchQuery}" 失败，回退到顺序模式:`, searchErr.message)
        searchQuery.length = 0
      }
    }
    if(!sinceUid && (!searchQuery || uids.length === 0 && !searchQuery)){
      // 顺序模式：从末尾往回拉
      const fetchLimit = Math.min(limit, batchSize)
      const start=Math.max(1, total - offset - fetchLimit +1)
      const end=Math.max(1, total - offset)
      if(start> end) return res.json({ emails: [], total, hasMore:false })
      for(let s=start; s<=end; s+=batchSize){
        const e=Math.min(s+batchSize-1, end)
        for(let uid=s; uid<=e; uid++) uids.push(uid)
      }
    }

    const out=[]
    // 分批 fetch（每批500个UID）
    for(let i=0; i<uids.length; i+=batchSize){
      const batch = uids.slice(i, i+batchSize)
      const seqRange = batch.join(',')
      for await (const msg of client.fetch(seqRange, fields, {uid:true})){
        try{
          if(headersOnly){
            const toAddrs = msg.envelope.to || []
            const toText = toAddrs.map(a => a.address ? `${a.name||''} <${a.address}>` : '').filter(Boolean).join(', ') || acc.email
            out.push({
              id: `${accountId}-${msg.uid}`,
              accountId,
              folder: folder.toLowerCase(),
              from: msg.envelope.from?.[0]?.address ? `${msg.envelope.from[0].name||''} <${msg.envelope.from[0].address}>` : '',
              fromName: msg.envelope.from?.[0]?.name || '',
              to: toText,
              subject: msg.envelope.subject || '(无主题)',
              text: '',
              html: '',
              date: msg.envelope.date?.toISOString() || new Date().toISOString(),
              isRead: msg.flags.has('\\Seen'),
              hasAttachment: false,
            })
          } else {
            const parsed=await simpleParser(msg.source)
            out.push({
              id: `${accountId}-${msg.uid}`,
              accountId,
              folder: folder.toLowerCase(),
              from: parsed.from?.text || msg.envelope.from?.[0]?.address || '',
              fromName: parsed.from?.value?.[0]?.name || '',
              to: parsed.to?.text || acc.email,
              subject: parsed.subject || msg.envelope.subject || '(无主题)',
              text: parsed.text || parsed.html || '',
              html: parsed.html || '',
              date: parsed.date?.toISOString() || new Date().toISOString(),
              isRead: msg.flags.has('\\Seen'),
              hasAttachment: (parsed.attachments||[]).length>0,
            })
          }
        }catch{}
      }
    }
    out.sort((a,b)=> new Date(b.date).getTime() - new Date(a.date).getTime())
    const hasMore = searchQuery
      ? uids.length >= limit  // SEARCH 模式：如果返回了 limit 条，可能还有更多
      : (offset + out.length) < total
    res.json({ emails: out, total, hasMore, nextOffset: offset + out.length })
  }finally{ lock.release(); await client.logout().catch(()=>{}) }
}))

// ====== 服务端邮件库：绑定一次全量入库，之后只增量 ======
async function loadMailAccount(accountId, username){
  if(!dbReady) return null
  const [rows]=await pool.query('SELECT * FROM email_accounts WHERE id=? AND username=?',[accountId, username])
  return rows[0] || null
}
function sqlDate(d){
  try{
    const t = d instanceof Date ? d : new Date(d)
    if(isNaN(t.getTime())) return null
    return t.toISOString().slice(0,19).replace('T',' ')
  }catch{ return null }
}
function sqlNow(){ return new Date().toISOString().slice(0,23).replace('T',' ') }
// 通用硬超时：任何 IMAP 等待超过 ms 即抛，调用方跳过本批下轮重试
function withTimeout(promise, ms, label){
  let timer = null
  return Promise.race([
    promise,
    new Promise((_, rej)=>{ timer = setTimeout(()=>rej(new Error((label||'op')+'-timeout')), ms) }),
  ]).finally(()=>{ if(timer) clearTimeout(timer) })
}
function makeImapClient({ host, port, user, pass, socketTimeout = 60000 }){
  const client = new ImapFlow({ host, port, secure: port === 993, auth:{ user, pass }, logger:false, connectTimeout:20000, authTimeout:15000, socketTimeout })
  client.on('error', ()=>{})
  return client
}
async function imapConnect(client, ms = 30000){
  let timer = null
  try{
    await Promise.race([
      client.connect(),
      new Promise((_, rej)=>{ timer = setTimeout(()=>rej(new Error('imap-connect-timeout')), ms) }),
    ])
  }catch(e){
    // 半开连接直接丢弃，不等待（close 在半开状态也可能 hang）
    try{ if(typeof client.destroy === 'function') client.destroy() }catch{}
    try{ if(typeof client.close === 'function') client.close().catch(()=>{}) }catch{}
    throw e
  }finally{
    if(timer) clearTimeout(timer)
  }
}
function normSubject(s){
  return String(s||'').replace(/^\s*(re|fwd|fw|回复|转发|答复)\s*[:：]\s*/gi, '').trim().slice(0,512)
}
function safeFileName(s){
  return String(s||'attachment').replace(/[\\/:"*?<>|]/g, '_').slice(0,180) || 'attachment'
}
// 附件落盘 D:\mail-data\<accountId>\<uid>\，只记元数据进库
const ATTACH_BASE = 'D:\\mail-data'
const madeDirs = new Set()
async function saveAttachment(accountId, folder, uid, att){
  try{
    const dir = path.join(ATTACH_BASE, accountId, String(uid))
    if(!madeDirs.has(dir)){ fs.mkdirSync(dir, { recursive:true }); madeDirs.add(dir) }
    const name = safeFileName(att.filename)
    const fp = path.join(dir, name)
    const buf = att.content
    if(buf && buf.length){
      if(buf.length > 50*1024*1024) return { saved:false, reason:'too-large' } // 单个50MB以上跳过
      fs.writeFileSync(fp, buf)
    }
    return { saved:true, path:fp, size:buf?buf.length:0 }
  }catch(e){ return { saved:false, reason:String(e.message||e).slice(0,80) } }
}
const ingestJobs = new Map() // accountId -> {running, mode, folder, done, total, added, updated, startedAt, error}

async function runMailIngest(accountId, username, opts = {}){
  const folders = Array.isArray(opts.folders) && opts.folders.length ? opts.folders : ['[Gmail]/All Mail']
  const mode = opts.mode === 'incremental' ? 'incremental' : 'full'
  const st = { running:true, mode, folder:'', done:0, total:0, added:0, updated:0, startedAt:new Date().toISOString(), error:'' }
  ingestJobs.set(accountId, st)
  try{
    const acc = await loadMailAccount(accountId, username)
    if(!acc) throw new Error('账号不存在或数据库未就绪')
    const pass = decAuth(acc.auth_enc)
    for(const folder of folders){
      st.folder = folder
      const client = makeImapClient({ host:acc.imap_host, port:acc.imap_port, user:acc.email, pass, socketTimeout:180000 })
      await imapConnect(client, 30000)
      try{
        const lock = await client.getMailboxLock(folder)
        try{
          const uidvalidity = Number(client.mailbox.uidValidity || 0)
          const uidnext = Number(client.mailbox.uidNext || 0)
          let [srows] = await pool.query('SELECT * FROM mail_sync_state WHERE account_id=? AND folder=?',[accountId, folder])
          let state = srows[0] || null
          if(state && state.uidvalidity && Number(state.uidvalidity) !== Number(uidvalidity)){
            // UIDVALIDITY 变了：旧 UID 全部作废，该文件夹重做全量
            await pool.query('DELETE FROM mail_messages WHERE account_id=? AND folder=?',[accountId, folder])
            await pool.query('DELETE FROM mail_sync_state WHERE account_id=? AND folder=?',[accountId, folder])
            state = null
          }
          const lastUid = state ? Number(state.last_uid)||0 : 0
          // 服务端全部 UID
          let allUids = await client.search({ all:true }, { uid:true })
          if(!Array.isArray(allUids)) allUids = []
          // 本地已有 UID（只查 uid 列，轻量）
          const [haveRows] = await pool.query('SELECT uid FROM mail_messages WHERE account_id=? AND folder=?',[accountId, folder])
          const have = new Set(haveRows.map(r=>Number(r.uid)))
          let missing
          if(mode === 'incremental' && lastUid > 0){
            missing = allUids.filter(u => u > lastUid && !have.has(u))
          } else {
            missing = allUids.filter(u => !have.has(u))
          }
          st.total += missing.length
          const UPSERT_SQL =
            `INSERT INTO mail_messages (account_id, folder, uid, message_id, gmail_msgid, gmail_threadid, subject, from_addr, from_name, to_addr, msg_date, is_read, has_attachment, body_text, body_cached, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE is_read=VALUES(is_read), has_attachment=VALUES(has_attachment),
               body_text=IF(body_cached=0 AND VALUES(body_cached)=1, VALUES(body_text), body_text),
               body_cached=IF(VALUES(body_cached)=1,1,body_cached), updated_at=VALUES(updated_at)`;
          const saveRow = async (row) => {
            const r = await pool.query(UPSERT_SQL,
              [accountId, folder, row.uid, row.message_id, row.gmail_msgid, row.gmail_threadid, row.subject, row.from_addr, row.from_name, row.to_addr, row.msg_date, row.is_read, row.has_attachment, row.body_text, row.body_cached, sqlNow()]);
            if(r[0].affectedRows === 1) st.added++; else st.updated++;
            st.done++;
          };
          // 阶段 A：信封+状态快速入库（无正文），先让全部邮件可搜可列
          st.phase = 'envelope'
          missing.sort((a,b)=>a-b)
          for(let i=0;i<missing.length;i+=500){
            if(st.cancelled) throw new Error('cancelled')
            const batch = missing.slice(i, i+500)
            try{
              await withTimeout((async()=>{
              for await (const msg of client.fetch(batch.join(','), { envelope:true, flags:true, uid:true, internalDate:true, gmailMessageId:true, gmailThreadId:true }, { uid:true })){
                try{
                  const env = msg.envelope || {}
                  const flags = msg.flags || new Set()
                  await saveRow({
                    uid: msg.uid,
                    message_id: String(env.messageId || '').slice(0,512),
                    gmail_msgid: String(msg.gmailMessageId || '').slice(0,64),
                    gmail_threadid: String(msg.gmailThreadId || '').slice(0,64),
                    subject: String(env.subject || '(无主题)').slice(0,1024),
                    from_addr: String(env.from?.[0]?.address || '').slice(0,512),
                    from_name: String(env.from?.[0]?.name || '').slice(0,256),
                    to_addr: String((env.to||[]).map(a=>a.address).filter(Boolean).join(', ')).slice(0,1024),
                    msg_date: sqlDate(msg.internalDate || env.date),
                    is_read: flags.has('\\Seen') ? 1 : 0,
                    has_attachment: 0,
                    body_text: '',
                    body_cached: 0,
                  })
                }catch{}
              }
              })(), 3*60*1000, 'envelope-batch')
            }catch(e){ console.log('[ingest] envelope batch skip:', String(e.message||e).slice(0,60)) }
            await new Promise(r=>setImmediate(r))
            // 游标实时落库：中断后下轮从这里续，db-status 也有数可显示
            try{
              const doneMax = batch[batch.length-1]
              await pool.query(
                `INSERT INTO mail_sync_state (account_id, folder, uidvalidity, last_uid, uidnext, full_sync_done, last_sync_at)
                 VALUES (?,?,?,?,?,0,?) ON DUPLICATE KEY UPDATE uidvalidity=VALUES(uidvalidity), last_uid=GREATEST(last_uid, VALUES(last_uid)), uidnext=GREATEST(uidnext, VALUES(uidnext)), last_sync_at=VALUES(last_sync_at)`,
                [accountId, folder, uidvalidity, doneMax, uidnext, sqlNow()])
            }catch{}
          }
          // 阶段 B：后台补正文（断点可续，只补 body_cached=0 的；3 连接并行加速）
          st.phase = 'body'
          const BODY_MAX = 15*1024*1024 // 超过该大小只记占位，不拉正文
          const BODY_CONCURRENCY = 3
          const processBodyBatch = async (wc, batch) => {
            // B1: 先取大小，超大件直接占位跳过（2分钟硬超时）
            let sizes = new Map()
            try{
              await withTimeout((async()=>{
                for await (const msg of wc.fetch(batch.join(','), { size:true, uid:true }, { uid:true })){
                  sizes.set(msg.uid, Number(msg.size)||0)
                }
              })(), 2*60*1000, 'size-batch')
            }catch(e){ console.log('[ingest] size batch skip:', String(e.message||e).slice(0,60)) }
            for(const u of batch.filter(u=> (sizes.get(u)||0) > BODY_MAX)){
              await pool.query(`UPDATE mail_messages SET body_text='[超大邮件（>15MB），正文未入库，请在线查看]', body_cached=1, updated_at=? WHERE account_id=? AND folder=? AND uid=?`,
                [sqlNow(), accountId, folder, u]).catch(()=>{})
              st.done++
            }
            const small = batch.filter(u=> (sizes.get(u)||0) <= BODY_MAX)
            if(!small.length) return
            // B2: 取正文，整批4分钟硬超时（超时整批跳过，下轮重试）
            try{
              await Promise.race([
                (async()=>{
                  for await (const msg of wc.fetch(small.join(','), { envelope:true, flags:true, uid:true, source:true }, { uid:true })){
                    try{
                      const parsed = await simpleParser(msg.source).catch(()=>null)
                      if(!parsed) continue
                      const bodyText = String(parsed.text || parsed.html || '').slice(0, 500000)
                      const atts = parsed.attachments || []
                      const att = atts.length ? 1 : 0
                      await pool.query('UPDATE mail_messages SET body_text=?, body_cached=1, has_attachment=GREATEST(has_attachment, ?), is_read=?, updated_at=? WHERE account_id=? AND folder=? AND uid=?',
                        [bodyText, att, ((msg.flags||new Set()).has('\\Seen')?1:0), sqlNow(), accountId, folder, msg.uid])
                      // 附件元数据+落盘
                      for(const a of atts){
                        try{
                          const sv = await saveAttachment(accountId, folder, msg.uid, a)
                          if(sv.saved){
                            await pool.query(`INSERT INTO mail_attachments (account_id, folder, uid, filename, size, mime, path) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE size=VALUES(size), mime=VALUES(mime), path=VALUES(path)`,
                              [accountId, folder, msg.uid, safeFileName(a.filename), sv.size || a.size || 0, String(a.contentType||'').slice(0,128), sv.path || ''])
                          }
                        }catch{}
                      }
                      st.done++
                    }catch{}
                  }
                })(),
                new Promise((_, rej)=>setTimeout(()=>rej(new Error('body-batch-timeout')), 4*60*1000)),
              ])
            }catch(e){ console.log('[ingest] body batch skip:', String(e.message||e).slice(0,80)) }
          }
          while(true){
            if(st.cancelled) throw new Error('cancelled')
            const [todoRows] = await pool.query('SELECT uid FROM mail_messages WHERE account_id=? AND folder=? AND body_cached=0 ORDER BY uid LIMIT 600',[accountId, folder]).catch(()=> [[]])
            const todo = (todoRows||[]).map(r=>Number(r.uid)).filter(Boolean)
            if(!todo.length) break
            const wcFailed = []
            // 切片分给 N 个 worker，各自独立连接并行拉取
            const slices = Array.from({ length: BODY_CONCURRENCY }, ()=> [])
            todo.forEach((u, idx)=> slices[idx % BODY_CONCURRENCY].push(u))
            const workers = slices.filter(s=> s.length).map(async (slice)=>{
              if(st.cancelled) throw new Error('cancelled')
              const wc = makeImapClient({ host:acc.imap_host, port:acc.imap_port, user:acc.email, pass, socketTimeout:180000 })
              try{
                await imapConnect(wc, 30000)
              }catch(e){
                // 连不上：记一笔直接返回，避免空转忙循环打爆 Gmail
                wcFailed.push(String(e.message||e).slice(0,60))
                try{ await wc.logout().catch(()=>{}) }catch{}
                return
              }
              try{
                for(let i=0;i<slice.length;i+=25){
                  if(st.cancelled) throw new Error('cancelled')
                  await processBodyBatch(wc, slice.slice(i,i+25))
                  await new Promise(r=>setImmediate(r))
                }
              }finally{
                await wc.logout().catch(()=>{})
              }
            })
            const results = await Promise.allSettled(workers)
            if(wcFailed.length && wcFailed.length >= slices.filter(s=> s.length).length){
              throw new Error('imap-unavailable: ' + (wcFailed[0]||''))
            }
            for(const r of results){
              if(r.status === 'rejected' && String(r.reason?.message||'') === 'cancelled') throw new Error('cancelled')
            }
          }
          // 已读状态刷新：UNSEEN 列表 + 最近 2000 封的 FLAGS（每步硬超时，hang 则跳过本轮）
          try{
            let unseen = await withTimeout(client.search({ unseen:true }, { uid:true }), 60000, 'unseen').catch(()=>[])
            if(!Array.isArray(unseen)) unseen = []
            const unseenSet = new Set(unseen)
            if(unseenSet.size){
              const chunks = [...unseenSet]
              for(let i=0;i<chunks.length;i+=1000){
                await pool.query(`UPDATE mail_messages SET is_read=0, updated_at=? WHERE account_id=? AND folder=? AND uid IN (${chunks.slice(i,i+1000).map(()=> '?').join(',')})`,[sqlNow(), accountId, folder, ...chunks.slice(i,i+1000)])
              }
            }
            const tail = allUids.slice().sort((a,b)=>b-a).slice(0,2000)
            for(let i=0;i<tail.length;i+=200){
              if(st.cancelled) throw new Error('cancelled')
              const batch = tail.slice(i,i+200)
              try{
                await withTimeout((async()=>{
                  for await (const msg of client.fetch(batch.join(','), { flags:true, uid:true }, { uid:true })){
                    const seen = (msg.flags||new Set()).has('\\Seen') ? 1 : 0
                    await pool.query('UPDATE mail_messages SET is_read=?, updated_at=? WHERE account_id=? AND folder=? AND uid=? AND is_read<>?', [seen, sqlNow(), accountId, folder, msg.uid, seen])
                  }
                })(), 2*60*1000, 'flags-batch')
              }catch{}
            }
          }catch{}
          // 删除对账（full 模式）：服务端已消失的 UID 从库中删除
          if(mode === 'full' && allUids.length){
            try{
              const alive = new Set(allUids)
              const gone = [...have].filter(u => !alive.has(u))
              for(let i=0;i<gone.length;i+=1000){
                const ch = gone.slice(i,i+1000)
                await pool.query(`DELETE FROM mail_messages WHERE account_id=? AND folder=? AND uid IN (${ch.map(()=> '?').join(',')})`,[accountId, folder, ...ch])
              }
            }catch{}
          }
          const maxUid = allUids.length ? Math.max(...allUids) : lastUid
          // 线程聚合重建（本文件夹，客户往来查询变单条SQL）
          try{
            const [trows] = await pool.query(`SELECT gmail_threadid AS tid, COUNT(*) AS c, MAX(msg_date) AS lastd, ANY_VALUE(subject) AS subj FROM mail_messages WHERE account_id=? AND folder=? AND gmail_threadid<>'' GROUP BY gmail_threadid`,[accountId, folder])
            for(let i=0;i<trows.length;i+=500){
              const ch = trows.slice(i,i+500)
              const vals = []
              const params = []
              for(const t of ch){ vals.push('(?,?,?,?,?)'); params.push(accountId, String(t.tid).slice(0,64), normSubject(t.subj), Number(t.c)||0, t.lastd) }
              if(vals.length) await pool.query(`INSERT INTO mail_threads (account_id, thread_id, subject_norm, count, last_date) VALUES ${vals.join(',')} ON DUPLICATE KEY UPDATE subject_norm=VALUES(subject_norm), count=VALUES(count), last_date=VALUES(last_date)`, params)
            }
          }catch(e){ console.log('[ingest] threads skip:', String(e.message||e).slice(0,120)) }
          await pool.query(
            `INSERT INTO mail_sync_state (account_id, folder, uidvalidity, last_uid, uidnext, full_sync_done, last_sync_at)
             VALUES (?,?,?,?,?,1,?) ON DUPLICATE KEY UPDATE uidvalidity=VALUES(uidvalidity), last_uid=GREATEST(last_uid, VALUES(last_uid)), uidnext=VALUES(uidnext), full_sync_done=1, last_sync_at=VALUES(last_sync_at)`,
            [accountId, folder, uidvalidity, maxUid, uidnext, sqlNow()])
        }finally{ lock.release() }
      }finally{ await client.logout().catch(()=>{}) }
    }
  }catch(e){ st.error = String(e.message||e).slice(0,200) }
  finally{ st.running = false }
}

// 启动入库任务：POST /email/ingest/:accountId {mode:'full'|'incremental', folders?}
app.post('/email/ingest/:accountId', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL（服务端邮件库未就绪）' })
  const { accountId } = req.params
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const cur = ingestJobs.get(accountId)
  if(cur && cur.running) return res.status(409).json({ error:'入库任务进行中', job:cur })
  const mode = req.body?.mode === 'incremental' ? 'incremental' : 'full'
  const folders = Array.isArray(req.body?.folders) && req.body.folders.length ? req.body.folders.map(String) : undefined
  runMailIngest(accountId, req.user, { mode, folders }).catch(()=>{})
  res.json({ ok:true, mode, job: ingestJobs.get(accountId) })
}))

// 入库进度：GET /email/ingest-status/:accountId
app.get('/email/ingest-status/:accountId', auth, wrap(async (req,res)=>{
  res.json({ job: ingestJobs.get(req.params.accountId) || null })
}))

// 取消入库任务：POST /email/ingest-stop/:accountId
app.post('/email/ingest-stop/:accountId', auth, wrap(async (req,res)=>{
  const job = ingestJobs.get(req.params.accountId)
  if(job) job.cancelled = true
  res.json({ ok:true })
}))

// 入库状态总览：GET /email/db-status/:accountId（先查差多少，再决定同步；light=1 跳过 IMAP 探测，零连接）
app.get('/email/db-status/:accountId', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId } = req.params
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const light = String(req.query.light||'') === '1'
  const folders = Array.isArray(req.query.folders) ? req.query.folders : (req.query.folder ? [String(req.query.folder)] : ['[Gmail]/All Mail'])
  const out = []
  const pass = decAuth(acc.auth_enc)
  for(const folder of folders){
    const [srows] = await pool.query('SELECT * FROM mail_sync_state WHERE account_id=? AND folder=?',[accountId, folder])
    const [crows] = await pool.query('SELECT COUNT(*) AS c, MAX(uid) AS maxUid, SUM(body_cached) AS bodies FROM mail_messages WHERE account_id=? AND folder=?',[accountId, folder])
    const dbCount = Number(crows[0]?.c)||0
    const bodyCount = Number(crows[0]?.bodies)||0
    const cachedUidnext = Number(srows[0]?.uidnext)||0
    const cachedLastUid = Number(srows[0]?.last_uid ?? crows[0]?.maxUid ?? 0)||0
    let imapTotal = 0, uidnext = 0, uidvalidity = 0, live = true
    if(light){
      // 轻量模式：不碰 IMAP，直接用库内游标
      live = false
      imapTotal = cachedUidnext || cachedLastUid || dbCount
      uidnext = cachedUidnext
      uidvalidity = Number(srows[0]?.uidvalidity)||0
    } else {
      const client = makeImapClient({ host:acc.imap_host, port:acc.imap_port, user:acc.email, pass, socketTimeout:30000 })
      try{
        await imapConnect(client, 20000)
      const lock = await client.getMailboxLock(folder)
      try{
        imapTotal = Number(client.mailbox.exists || 0)
        uidnext = Number(client.mailbox.uidNext || 0)
        uidvalidity = Number(client.mailbox.uidValidity || 0)
      }finally{ lock.release() }
    }catch{ live = false }finally{ await client.logout().catch(()=>{}) }
    } // end else (非 light 模式才探 IMAP)
    // 探测失败（限流/断网）时用库里游标兜底，不再显示 /0
    if(!live){ imapTotal = cachedUidnext || cachedLastUid || dbCount; uidnext = cachedUidnext; uidvalidity = Number(srows[0]?.uidvalidity)||0 }
    const lastUid = cachedLastUid
    out.push({ folder, dbCount, bodyCount, imapTotal, lastUid, uidnext, uidvalidity, live,
      fullSyncDone: !!srows[0]?.full_sync_done,
      lastSyncAt: srows[0]?.last_sync_at || null,
      pending: Math.max(0, (uidnext || imapTotal) - lastUid), // 新增待入库估算
      job: ingestJobs.get(accountId) || null })
  }
  res.json({ folders: out })
}))

// 库内全文搜索：GET /email/db-search/:accountId?q=&limit=50
app.get('/email/db-search/:accountId', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId } = req.params
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const q = String(req.query.q || '').trim().slice(0, 100)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
  const cols = 'account_id, folder, uid, message_id, gmail_msgid, subject, from_addr, from_name, to_addr, msg_date, is_read, has_attachment, body_cached, CHAR_LENGTH(body_text) AS body_len, LEFT(body_text, 600) AS snippet'
  if(!q){
    const [rows] = await pool.query(`SELECT ${cols}, body_text FROM mail_messages WHERE account_id=? ORDER BY msg_date DESC LIMIT ?`,[accountId, limit])
    return res.json({ emails: rows, total: rows.length, mode:'latest' })
  }
  let rows = []
  try{
    const [r] = await pool.query(
      `SELECT ${cols}, body_text, MATCH(subject, from_addr, to_addr, body_text) AGAINST (? IN NATURAL LANGUAGE MODE) AS relevance
       FROM mail_messages WHERE account_id=? AND MATCH(subject, from_addr, to_addr, body_text) AGAINST (? IN NATURAL LANGUAGE MODE)
       ORDER BY relevance DESC, msg_date DESC LIMIT ?`,[q, accountId, q, limit])
    rows = r
  }catch{}
  if(!rows.length && q.length >= 2){
    // 全文无命中时回退 LIKE，保证“搜得到”（SQL 里 ESCAPE 需要双反斜杠）
    const like = `%${q.replace(/[%_\\]/g, m=>'\\'+m)}%`
    const [r] = await pool.query(
      `SELECT ${cols}, body_text FROM mail_messages
       WHERE account_id=? AND (subject LIKE ? ESCAPE '\\\\' OR from_addr LIKE ? ESCAPE '\\\\' OR to_addr LIKE ? ESCAPE '\\\\' OR body_text LIKE ? ESCAPE '\\\\')
       ORDER BY msg_date DESC LIMIT ?`,[accountId, like, like, like, like, limit])
    rows = r
  }
  res.json({ emails: rows, total: rows.length, mode:'db' })
}))

// 客户往来线程：GET /email/customer-mails/:accountId?email=xxx&page=0
// 先查 mail_threads 预聚合命中该邮箱的线程，再取各线程邮件（单客户页秒开）
app.get('/email/customer-mails/:accountId', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId } = req.params
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const email = String(req.query.email || '').trim().toLowerCase()
  if(!email || !email.includes('@')) return res.status(400).json({ error:'需要 email 参数' })
  const page = Math.max(0, Number(req.query.page) || 0)
  const perThread = Math.min(100, Math.max(1, Number(req.query.perThread) || 30))
  const like = `%${email}%`
  // 涉及该邮箱的线程（按最后往来倒序）
  const [threads] = await pool.query(
    `SELECT t.thread_id, t.subject_norm, t.count, t.last_date
     FROM mail_threads t
     WHERE t.account_id=? AND EXISTS (
       SELECT 1 FROM mail_messages m WHERE m.account_id=t.account_id
         AND m.gmail_threadid=t.thread_id AND (m.from_addr LIKE ? OR m.to_addr LIKE ?))
     ORDER BY t.last_date DESC LIMIT 50 OFFSET ?`,[accountId, like, like, page*50])
  const out = []
  for(const th of threads){
    const [mails] = await pool.query(
      `SELECT folder, uid, message_id, subject, from_addr, from_name, to_addr, msg_date, is_read, has_attachment, body_cached, CHAR_LENGTH(body_text) AS body_len, LEFT(body_text, 2000) AS snippet
       FROM mail_messages WHERE account_id=? AND gmail_threadid=? ORDER BY msg_date DESC LIMIT ?`,
      [accountId, th.thread_id, perThread])
    out.push({ threadId: th.thread_id, subject: th.subject_norm, count: th.count, lastDate: th.last_date, mails })
  }
  const [cc] = await pool.query(
    `SELECT COUNT(*) AS c FROM mail_messages WHERE account_id=? AND (from_addr LIKE ? OR to_addr LIKE ?)`,[accountId, like, like])
  res.json({ threads: out, totalMails: Number(cc[0]?.c)||0 })
}))

// 库内信封分页拉取：GET /email/db-envelopes/:accountId?sinceUid=0&limit=500
// 给浏览器同步用：零 IMAP 连接，只读库
app.get('/email/db-envelopes/:accountId', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId } = req.params
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const sinceUid = Number(req.query.sinceUid)||0
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit)||500))
  const [rows] = await pool.query(
    `SELECT folder, uid, message_id, subject, from_addr, from_name, to_addr, msg_date, is_read, has_attachment
     FROM mail_messages WHERE account_id=? AND uid>? ORDER BY uid LIMIT ?`,[accountId, sinceUid, limit])
  const [mx] = await pool.query(`SELECT MAX(uid) AS m, COUNT(*) AS c FROM mail_messages WHERE account_id=?`,[accountId])
  res.json({ envelopes: rows, maxUid: Number(mx[0]?.m)||0, total: Number(mx[0]?.c)||0, hasMore: rows.length>=limit })
}))

// 库内单封全文：GET /email/db-mail/:accountId/:uid（优先走库，不碰 IMAP）
app.get('/email/db-mail/:accountId/:uid', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId, uid } = req.params
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const uidNum = Number(uid)
  if(!isFinite(uidNum)) return res.status(400).json({ error:'无效UID' })
  const [rows] = await pool.query(
    `SELECT account_id, folder, uid, message_id, subject, from_addr, from_name, to_addr, msg_date, is_read, has_attachment, body_text, body_cached
     FROM mail_messages WHERE account_id=? AND uid=? LIMIT 1`,[accountId, uidNum])
  if(!rows.length) return res.status(404).json({ error:'库中无此邮件' })
  const e = rows[0]
  res.json({
    subject: e.subject, from: e.from_name ? `${e.from_name} <${e.from_addr}>` : e.from_addr,
    to: e.to_addr, date: e.msg_date, isRead: !!e.is_read, hasAttachment: !!e.has_attachment,
    text: e.body_text || '', html: '', cached: !!e.body_cached,
  })
}))

// ====== 常驻邮件 watcher：一账号一连接，IDLE 秒级通知 + 5分钟轮询兜底 ======
const mailWatchers = new Map() // accountId -> {running, username, mode, lastEventAt, lastCycleAt, lastUid, error}

async function mailWatchLoop(accountId, username){
  const w = mailWatchers.get(accountId)
  if(!w) return
  const wlog = ()=>{}
  wlog(`loop-start ${accountId}`)
  let backoff = 5000
  while(w.running){
    try{
      wlog('load-account')
      const acc = await loadMailAccount(accountId, username)
      if(!acc) throw new Error('账号不存在')
      wlog('connecting')
      const pass = decAuth(acc.auth_enc)
      const client = makeImapClient({ host:acc.imap_host, port:acc.imap_port, user:acc.email, pass, socketTimeout:120000 })
      await imapConnect(client, 30000)
      backoff = 5000
      w.mode = 'idle'; w.error = ''
      const lock = await client.getMailboxLock('INBOX')
      const onExists = ()=>{ w.lastEventAt = new Date().toISOString(); try{ client.breakIdle() }catch{} }
      client.on('exists', onExists)
      try{
        // IDLE 最多 5 分钟一轮：有事件立刻醒，无事件到点也醒一次做增量（防漏）
        await Promise.race([
          client.idle(),
          new Promise((_, rej)=>{ w.idleTimer = setTimeout(()=>rej(new Error('idle-tick')), 5*60*1000) }),
        ])
      }catch(e){
        if(e && e.message !== 'idle-tick' && e.message !== 'break') throw e
      }finally{
        clearTimeout(w.idleTimer); w.idleTimer = null
        try{ client.off('exists', onExists) }catch{}
        try{ lock.release() }catch{}
      }
      await client.logout().catch(()=>{})
      // 醒来就跑一次增量（新邮件+状态），两个文件夹
      w.mode = 'syncing'; w.lastCycleAt = new Date().toISOString()
      await runMailIngest(accountId, username, { mode:'incremental', folders:['[Gmail]/All Mail','INBOX'] }).catch(()=>{})
      try{
        const [srows] = await pool.query('SELECT MAX(last_uid) AS m FROM mail_sync_state WHERE account_id=?',[accountId])
        w.lastUid = Number(srows[0]?.m)||0
      }catch{}
    }catch(e){
      w.mode = 'backoff'
      w.error = String(e.message||e).slice(0,120)
      await new Promise(r=>setTimeout(r, backoff))
      backoff = Math.min(backoff*2, 8*60*1000)
    }
  }
}
function startMailWatcher(accountId, username){
  const cur = mailWatchers.get(accountId)
  if(cur && cur.running) return cur
  const w = { running:true, username, mode:'starting', lastEventAt:'', lastCycleAt:'', lastUid:0, error:'', idleTimer:null }
  mailWatchers.set(accountId, w)
  mailWatchLoop(accountId, username).catch(()=>{})
  return w
}
function stopMailWatcher(accountId){
  const w = mailWatchers.get(accountId)
  if(w){ w.running = false; if(w.idleTimer) clearTimeout(w.idleTimer); mailWatchers.delete(accountId) }
}
async function startAllMailWatchers(){
  if(!dbReady) return
  try{
    const [rows] = await pool.query('SELECT id, username FROM email_accounts')
    for(const r of rows) startMailWatcher(r.id, r.username)
  }catch{}
}

// 监听状态：GET /email/watch-status/:accountId
app.get('/email/watch-status/:accountId', auth, wrap(async (req,res)=>{
  const { accountId } = req.params
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const w = mailWatchers.get(accountId)
  if(!w) return res.json({ watching:false })
  res.json({ watching:true, mode:w.mode, lastEventAt:w.lastEventAt, lastCycleAt:w.lastCycleAt, lastUid:w.lastUid, error:w.error })
}))

// 启动监听：POST /email/watch/:accountId
app.post('/email/watch/:accountId', auth, wrap(async (req,res)=>{
  const { accountId } = req.params
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  res.json({ ok:true, watcher: (()=>{ const w = startMailWatcher(accountId, req.user); return { mode:w.mode } })() })
}))

// 标已读回写 Gmail：POST /email/mark-read {accountId, uid, read, folder?}
app.post('/email/mark-read', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId, uid, read = true, folder = '[Gmail]/All Mail' } = req.body || {}
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const uidNum = Number(uid)
  if(!isFinite(uidNum)) return res.status(400).json({ error:'无效UID' })
  const pass = decAuth(acc.auth_enc)
  const client = makeImapClient({ host:acc.imap_host, port:acc.imap_port, user:acc.email, pass, socketTimeout:60000 })
  try{
    await client.connect()
    const lock = await client.getMailboxLock(folder)
    try{
      if(read) await client.messageFlagsAdd(String(uidNum), ['\\Seen'], { uid:true })
      else await client.messageFlagsRemove(String(uidNum), ['\\Seen'], { uid:true })
    }finally{ lock.release() }
  }finally{ await client.logout().catch(()=>{}) }
  await pool.query('UPDATE mail_messages SET is_read=?, updated_at=? WHERE account_id=? AND uid=?',[read?1:0, sqlNow(), accountId, uidNum])
  res.json({ ok:true })
}))

// 按需加载单封邮件全文：GET /email/full/:accountId/:uid
app.get('/email/full/:accountId/:uid', auth, wrap(async (req,res)=>{
  const { accountId, uid } = req.params
  let acc=null
  if(dbReady){
    const [rows]=await pool.query('SELECT * FROM email_accounts WHERE id=? AND username=?',[accountId, req.user])
    if(rows.length===0) return res.status(404).json({error:'账号不存在'})
    acc=rows[0]
  } else {
    const arr=memEmailAccounts.get(req.user)||[]
    acc=arr.find(a=> a.id===accountId)
    if(!acc) return res.status(404).json({error:'账号不存在'})
  }
  const pass=decAuth(acc.auth_enc)
  const client=makeImapClient({ host:acc.imap_host, port:acc.imap_port, user:acc.email, pass, socketTimeout:60000 })
  await client.connect()
  const uidNum = Number(uid)
  if(!isFinite(uidNum)) { await client.logout().catch(()=>{}); return res.status(400).json({error:'无效UID'}) }
  // 直接在 All Mail 中搜索（包含所有邮件）
  const folders = ['[Gmail]/All Mail','INBOX','[Gmail]/Sent Mail','Sent']
  for(const folder of folders){
    try{
      const lock = await client.getMailboxLock(folder)
      try{
        // 用 SEARCH UID 确认存在，再 fetch
        const found = await client.search({uid: uidNum})
        if(!found || found.length === 0) continue
        const r = await client.fetchOne(uidNum, { source:true, uid:true }, {uid:true})
        if(!r || !r.source) continue
        const parsed = await simpleParser(r.source)
        await client.logout().catch(()=>{})
        res.json({
          id: `${accountId}-${uid}`,
          from: parsed.from?.text || '',
          to: parsed.to?.text || '',
          subject: parsed.subject || '',
          text: parsed.text || '',
          html: parsed.html || '',
          date: parsed.date?.toISOString() || '',
          hasAttachment: (parsed.attachments||[]).length > 0,
        })
        return
      }finally{ lock.release() }
    }catch{}
  }
  await client.logout().catch(()=>{})
  res.status(404).json({error:'未找到该邮件'})
}))

// 批量加载邮件全文：POST /email/full-batch  {accountId, uids:[123,456,...]}
app.post('/email/full-batch', auth, wrap(async (req,res)=>{
  const { accountId, uids } = req.body||{}
  if(!accountId || !Array.isArray(uids) || uids.length===0) return res.status(400).json({error:'需要accountId和uids数组'})
  let acc=null
  if(dbReady){
    const [rows]=await pool.query('SELECT * FROM email_accounts WHERE id=? AND username=?',[accountId, req.user])
    if(rows.length===0) return res.status(404).json({error:'账号不存在'})
    acc=rows[0]
  } else {
    const arr=memEmailAccounts.get(req.user)||[]
    acc=arr.find(a=> a.id===accountId)
    if(!acc) return res.status(404).json({error:'账号不存在'})
  }
  const pass=decAuth(acc.auth_enc)
  const client=makeImapClient({ host:acc.imap_host, port:acc.imap_port, user:acc.email, pass, socketTimeout:120000 })
  await client.connect()
  const results = {}
  try{
    const lock = await client.getMailboxLock('[Gmail]/All Mail')
    try{
      // 批量 fetch：用 UID 序列
      const validUids = uids.map(Number).filter(isFinite)
      if(validUids.length === 0) return res.json({results:{}})
      const uidSeq = validUids.join(',')
      for await (const msg of client.fetch(uidSeq, { source:true, uid:true })){
        try{
          if(!msg.source) continue
          const parsed = await simpleParser(msg.source)
          results[msg.uid] = {
            from: parsed.from?.text || '',
            to: parsed.to?.text || '',
            subject: parsed.subject || '',
            text: parsed.text || '',
            html: parsed.html || '',
            date: parsed.date?.toISOString() || '',
            hasAttachment: (parsed.attachments||[]).length > 0,
          }
        }catch{}
      }
    }finally{ lock.release() }
  }catch{}
  await client.logout().catch(()=>{})
  res.json({results})
}))

// 发送邮件：POST /email/send  {accountId, to, subject, text, html, inReplyTo, references}（单封急件直发保留）
app.post('/email/send', auth, wrap(async (req,res)=>{
  const { accountId, to, subject, text, html, inReplyTo, references } = req.body||{}
  if(!accountId || !to || !subject) return res.status(400).json({error:'需要accountId, to, subject'})
  let acc=null
  if(dbReady){
    const [rows]=await pool.query('SELECT * FROM email_accounts WHERE id=? AND username=?',[accountId, req.user])
    if(rows.length===0) return res.status(404).json({error:'账号不存在'})
    acc=rows[0]
  } else {
    const arr=memEmailAccounts.get(req.user)||[]
    acc=arr.find(a=> a.id===accountId)
    if(!acc) return res.status(404).json({error:'账号不存在'})
  }
  const pass=decAuth(acc.auth_enc)
  // 动态导入 nodemailer
  const nodemailer = await import('nodemailer')
  const transporter = nodemailer.default.createTransport({
    host: acc.smtp_host || 'smtp.gmail.com',
    port: acc.smtp_port || 465,
    secure: (acc.smtp_port || 465) === 465,
    auth: { user: acc.email, pass },
    connectionTimeout: 15000,
    socketTimeout: 30000,
  })
  const mailOpts = {
    from: acc.email,
    to,
    subject,
    text: text || '',
    html: html || text || '',
  }
  if(inReplyTo) mailOpts.inReplyTo = inReplyTo
  if(references) mailOpts.references = references
  const info = await transporter.sendMail(mailOpts)
  res.json({ ok:true, messageId: info.messageId })
}))

// ====== 草稿箱 + 发件队列 ======
async function sendMailViaSmtp(acc, pass, { to, subject, text, html, inReplyTo, references }){
  const nodemailer = await import('nodemailer')
  const transporter = nodemailer.default.createTransport({
    host: acc.smtp_host || 'smtp.gmail.com',
    port: acc.smtp_port || 465,
    secure: (acc.smtp_port || 465) === 465,
    auth: { user: acc.email, pass },
    connectionTimeout: 15000,
    socketTimeout: 60000,
  })
  const mailOpts = { from: acc.email, to, subject, text: text || '', html: html || text || '' }
  if(inReplyTo) mailOpts.inReplyTo = inReplyTo
  if(references) mailOpts.references = references
  return transporter.sendMail(mailOpts)
}
function classifySmtpError(e){
  const msg = String(e?.response || e?.message || e)
  if(/5\.4\.5|daily.*limit|quota|exceeded/i.test(msg)) return { retry:true, afterHours:24, note:'发信配额超限，顺延24小时' }
  if(/55[0-3]|invalid|recipient|mailbox unavailable|user unknown/i.test(msg)) return { retry:false, note:'收件地址无效' }
  if(/auth|credential|password|username/i.test(msg)) return { retry:false, note:'SMTP 认证失败，检查授权码' }
  return { retry:true, afterMinutes:5, note:'' }
}

// 草稿：GET /email/drafts
app.get('/email/drafts', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const [rows] = await pool.query('SELECT * FROM mail_drafts WHERE username=? ORDER BY updated_at DESC LIMIT 100',[req.user])
  res.json({ drafts: rows })
}))
// 草稿保存：PUT /email/drafts {id?, accountId, to, cc, subject, body_html, body_text, template_id}
app.put('/email/drafts', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { id, accountId, to, cc, subject, body_html, body_text, template_id } = req.body || {}
  const did = id || crypto.randomUUID()
  await pool.query(
    `INSERT INTO mail_drafts (id, username, account_id, to_addr, cc_addr, subject, body_html, body_text, template_id, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE to_addr=VALUES(to_addr), cc_addr=VALUES(cc_addr), subject=VALUES(subject), body_html=VALUES(body_html), body_text=VALUES(body_text), template_id=VALUES(template_id), updated_at=VALUES(updated_at)`,
    [did, req.user, accountId || '', to || '', cc || '', subject || '', body_html || '', body_text || '', template_id || '', sqlNow()])
  res.json({ ok:true, id: did })
}))
// 草稿删除：DELETE /email/drafts/:id
app.delete('/email/drafts/:id', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  await pool.query('DELETE FROM mail_drafts WHERE id=? AND username=?',[req.params.id, req.user])
  res.json({ ok:true })
}))

// 入队发送：POST /email/outbox {accountId, to, subject, text, html, draftId?, idempotencyKey?}（秒返回，后台发出）
app.post('/email/outbox', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId, to, subject, text, html, draftId, idempotencyKey } = req.body || {}
  if(!accountId || !to || !subject) return res.status(400).json({ error:'需要 accountId, to, subject' })
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const id = crypto.randomUUID()
  const idem = idempotencyKey || id
  try{
    await pool.query(
      `INSERT INTO mail_outbox (id, username, account_id, to_list, subject, body_html, body_text, status, try_count, idempotency_key)
       VALUES (?,?,?,?,?,?,?,'queued',0,?)`,
      [id, req.user, accountId, Array.isArray(to) ? to.join(',') : String(to), subject, html || text || '', text || '', idem])
  }catch(e){
    if(e && e.code === 'ER_DUP_ENTRY'){
      const [ex] = await pool.query('SELECT id, status FROM mail_outbox WHERE idempotency_key=?',[idem])
      return res.json({ ok:true, id: ex[0]?.id, status: ex[0]?.status, deduped:true })
    }
    throw e
  }
  res.json({ ok:true, id, status:'queued' })
}))
// 发件箱：GET /email/outbox?status=
app.get('/email/outbox', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const st = String(req.query.status || '')
  const [rows] = st
    ? await pool.query('SELECT id, account_id, to_list, subject, status, try_count, next_try_at, error, created_at FROM mail_outbox WHERE username=? AND status=? ORDER BY created_at DESC LIMIT 100',[req.user, st])
    : await pool.query('SELECT id, account_id, to_list, subject, status, try_count, next_try_at, error, created_at FROM mail_outbox WHERE username=? ORDER BY created_at DESC LIMIT 100',[req.user])
  res.json({ outbox: rows })
}))
// 重发：POST /email/outbox/:id/retry
app.post('/email/outbox/:id/retry', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  await pool.query(`UPDATE mail_outbox SET status='queued', next_try_at=?, error='' WHERE id=? AND username=? AND status='failed'`,[sqlNow(), req.params.id, req.user])
  res.json({ ok:true })
}))

// 发件 worker：每 30 秒扫一次到期任务
async function outboxTick(){
  if(!dbReady) return
  try{
    const [rows] = await pool.query(
      `SELECT * FROM mail_outbox WHERE status IN ('queued','failed') AND try_count<3 AND (next_try_at IS NULL OR next_try_at<=NOW()) ORDER BY created_at LIMIT 10`)
    for(const job of rows){
      try{
        await pool.query(`UPDATE mail_outbox SET status='sending', try_count=try_count+1 WHERE id=?`,[job.id])
        const [arows] = await pool.query('SELECT * FROM email_accounts WHERE id=? AND username=?',[job.account_id, job.username])
        if(!arows.length) throw new Error('账号不存在')
        const info = await sendMailViaSmtp(arows[0], decAuth(arows[0].auth_enc), { to: job.to_list, subject: job.subject, text: job.body_text, html: job.body_html })
        await pool.query(`UPDATE mail_outbox SET status='sent', error='' WHERE id=?`,[job.id])
        console.log(`[outbox] sent ${job.id} -> ${job.to_list} ${info.messageId || ''}`)
      }catch(e){
        const c = classifySmtpError(e)
        if(c.retry){
          const after = c.afterHours ? `DATE_ADD(NOW(), INTERVAL ${c.afterHours} HOUR)` : `DATE_ADD(NOW(), INTERVAL ${(c.afterMinutes || 5) * (job.try_count + 1)} MINUTE)`
          await pool.query(`UPDATE mail_outbox SET status='queued', next_try_at=${after}, error=? WHERE id=?`,[`${c.note} ${String(e.message||e).slice(0,200)}`, job.id])
        } else {
          await pool.query(`UPDATE mail_outbox SET status='failed', error=? WHERE id=?`,[`${c.note}: ${String(e.message||e).slice(0,300)}`, job.id])
        }
      }
    }
  }catch(e){ console.log('[outbox] tick skip:', String(e.message||e).slice(0,120)) }
}
setInterval(outboxTick, 30000)

// 兜底错误中间件：DB 宕机/非法参数等不再悬挂请求，也不泄漏 stack
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[sync-server] 错误:', err?.message ?? err)
  if (res.headersSent) return
  res.status(500).json({ error: '服务器内部错误' })
})

init().then(() => {
  app.listen(PORT, () => {
    const dbMode = dbReady ? 'MySQL' : '内存+文件'
    const secretMode = process.env.SECRET ? '环境变量' : 'secret.key'
    console.log(`[sync-server] listening on :${PORT} | 数据库: ${dbMode} | 密钥: ${secretMode}`)
    startAllMailWatchers() // 启动所有账号常驻监听
  })
})
