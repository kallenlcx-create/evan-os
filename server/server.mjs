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
  // Gmail API 游标与 OAuth 凭证（P0）
  await pool.query(`ALTER TABLE mail_sync_state ADD COLUMN history_id VARCHAR(64) DEFAULT ''`).catch(()=>{})
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gmail_oauth (
      account_id VARCHAR(80) PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      email VARCHAR(128) DEFAULT '',
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      access_expires_at TIMESTAMP(3) NULL,
      scope VARCHAR(512) DEFAULT '',
      updated_at TIMESTAMP(3) NOT NULL,
      INDEX idx_user (username)
    ) CHARACTER SET utf8mb4`).catch(()=>{})
  await pool.query(`ALTER TABLE gmail_oauth ADD COLUMN topic_name VARCHAR(256) DEFAULT ''`).catch(()=>{})
  await pool.query(`ALTER TABLE gmail_oauth ADD COLUMN watch_expiration TIMESTAMP(3) NULL`).catch(()=>{})
  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_config (
      k VARCHAR(80) PRIMARY KEY,
      v TEXT,
      updated_at TIMESTAMP(3) NOT NULL
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
      body_html MEDIUMTEXT,
      body_cached TINYINT DEFAULT 0,
      updated_at TIMESTAMP(3) NOT NULL,
      PRIMARY KEY (account_id, folder, uid),
      INDEX idx_gmail (account_id, gmail_msgid),
      INDEX idx_date (account_id, folder, msg_date),
      FULLTEXT INDEX ft_mail (subject, from_addr, to_addr, body_text) WITH PARSER ngram
    ) CHARACTER SET utf8mb4`).catch(()=>{})
  // 兼容旧库：补 body_html / labels 列（幂等）
  try{
    await pool.query(`ALTER TABLE mail_messages ADD COLUMN body_html MEDIUMTEXT AFTER body_text`).catch(()=>{})
  }catch{}
  try{
    await pool.query(`ALTER TABLE mail_messages ADD COLUMN labels VARCHAR(1024) DEFAULT '' AFTER body_cached`).catch(()=>{})
  }catch{}
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
  // Gmail attachmentId：正文阶段只记元数据时用于后续补二进制
  try{ await pool.query(`ALTER TABLE mail_attachments ADD COLUMN gmail_att_id VARCHAR(128) DEFAULT '' AFTER mime`).catch(()=>{}) }catch{}
  // Gmail attachmentId 可达数百字符，128 会截断导致 Invalid token
  try{ await pool.query(`ALTER TABLE mail_attachments MODIFY gmail_att_id VARCHAR(1024) DEFAULT ''`).catch(()=>{}) }catch{}
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS followup_sequences (
      customer_id VARCHAR(80) PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      account_id VARCHAR(80) NOT NULL,
      email VARCHAR(256) DEFAULT '',
      mode VARCHAR(16) DEFAULT 'auto',
      current_step INT DEFAULT 1,
      next_due_at DATETIME NULL,
      steps_json MEDIUMTEXT,
      intervals_json VARCHAR(256),
      replied TINYINT DEFAULT 0,
      replied_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP(3) NOT NULL,
      INDEX idx_due (username, mode, next_due_at),
      INDEX idx_user (username)
    ) CHARACTER SET utf8mb4`).catch(()=>{})
  await pool.query(`
    CREATE TABLE IF NOT EXISTS followup_templates (
      id VARCHAR(80) PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      name VARCHAR(128) DEFAULT '',
      kind VARCHAR(16) DEFAULT 'auto',
      subject VARCHAR(1024) DEFAULT '',
      body MEDIUMTEXT,
      updated_at TIMESTAMP(3) NOT NULL,
      INDEX idx_user (username, kind)
    ) CHARACTER SET utf8mb4`).catch(()=>{})
  await pool.query(`
    CREATE TABLE IF NOT EXISTS followup_config (
      username VARCHAR(64) PRIMARY KEY,
      intervals_json VARCHAR(256),
      updated_at TIMESTAMP(3) NOT NULL
    ) CHARACTER SET utf8mb4`).catch(()=>{})
  // 发送窗口配置（后加列，兼容已建表）：美东时间白天发送 + 节假日避让
  await pool.query(`ALTER TABLE followup_config ADD COLUMN send_start INT DEFAULT 8`).catch(()=>{})
  await pool.query(`ALTER TABLE followup_config ADD COLUMN send_end INT DEFAULT 20`).catch(()=>{})
  await pool.query(`ALTER TABLE followup_config ADD COLUMN skip_holidays TINYINT DEFAULT 1`).catch(()=>{})
  await pool.query(`ALTER TABLE mail_outbox ADD COLUMN respect_window TINYINT DEFAULT 0`).catch(()=>{})
  await pool.query(`
    CREATE TABLE IF NOT EXISTS us_holidays (
      date DATE PRIMARY KEY,
      name VARCHAR(256) DEFAULT '',
      fetched_at TIMESTAMP(3) NOT NULL
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

// ---------- Gmail API OAuth2（P0：替代 IMAP 授权码）----------
// 前置步骤（用户在 Google Cloud Console 做一次）：
// 1. 建项目 → 启用 Gmail API → OAuth 同意屏幕（外部/测试模式，加自己为测试用户）
// 2. 凭据 → 创建 OAuth 客户端 ID（Web 应用）→ 已获授权的重定向 URI 填：
//    https://win-8c09k6b093h.tail73fe40.ts.net/email/oauth/callback
// 3. 把 Client ID / Client Secret 填入下方管理接口（或环境变量 GOOGLE_CLIENT_ID/_SECRET）
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify']
async function getGoogleOAuthConfig(){
  let id = process.env.GOOGLE_CLIENT_ID || '', secret = process.env.GOOGLE_CLIENT_SECRET || ''
  try{
    const [rows] = await pool.query('SELECT k, v FROM server_config WHERE k IN (?,?)',['google_client_id','google_client_secret'])
    for(const r of rows){ if(r.k==='google_client_id') id = r.v || id; if(r.k==='google_client_secret') secret = r.v || secret }
  }catch{}
  return { id, secret }
}
async function saveGoogleOAuthConfig(id, secret){
  const now = sqlNow()
  if(id) await pool.query(`INSERT INTO server_config (k, v, updated_at) VALUES ('google_client_id',?,?) ON DUPLICATE KEY UPDATE v=VALUES(v), updated_at=VALUES(updated_at)`,[id, now]).catch(()=>{})
  if(secret) await pool.query(`INSERT INTO server_config (k, v, updated_at) VALUES ('google_client_secret',?,?) ON DUPLICATE KEY UPDATE v=VALUES(v), updated_at=VALUES(updated_at)`,[secret, now]).catch(()=>{})
}
function getOAuthRedirect(req){
  try{
    const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || (req && req.protocol) || 'https').split(',')[0]
    const host = String((req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'win-8c09k6b093h.tail73fe40.ts.net')
    return `${proto}://${host}/email/oauth/callback`
  }catch{ return 'https://win-8c09k6b093h.tail73fe40.ts.net/email/oauth/callback' }
}
async function buildOAuthClient(req, accountId){
  const { google } = await import('googleapis')
  const cfg = await getGoogleOAuthConfig()
  if(!cfg.id || !cfg.secret) throw new Error('未配置 Google OAuth Client（先在 Google Cloud Console 建凭据，再调 PUT /email/oauth/config 填入）')
  const o = new google.auth.OAuth2(cfg.id, cfg.secret, getOAuthRedirect(req))
  if(accountId && dbReady){
    try{
      const [rows] = await pool.query('SELECT refresh_token, access_token, access_expires_at FROM gmail_oauth WHERE account_id=?',[accountId])
      if(rows.length && rows[0].refresh_token){
        o.setCredentials({ refresh_token: decAuth(rows[0].refresh_token),
          access_token: rows[0].access_token ? decAuth(rows[0].access_token) : undefined,
          expiry_date: rows[0].access_expires_at ? new Date(rows[0].access_expires_at).getTime() : undefined })
        o.on('tokens', (t)=>{
          (async()=>{
            try{
              if(t.refresh_token) await pool.query('UPDATE gmail_oauth SET refresh_token=?, updated_at=? WHERE account_id=?',[encAuth(t.refresh_token), sqlNow(), accountId])
              if(t.access_token) await pool.query('UPDATE gmail_oauth SET access_token=?, access_expires_at=?, updated_at=? WHERE account_id=?',
                [encAuth(t.access_token), sqlDate(new Date(t.expiry_date || Date.now()+3500*1000)), sqlNow(), accountId])
            }catch{}
          })()
        })
      }
    }catch{}
  }
  return o
}
// 保存/查看 OAuth 应用配置（Client ID 可回显，Secret 不回显）
app.put('/email/oauth/config', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { clientId, clientSecret } = req.body || {}
  if(!clientId && !clientSecret) return res.status(400).json({ error:'需要 clientId / clientSecret' })
  await saveGoogleOAuthConfig(clientId || '', clientSecret || '')
  const cfg = await getGoogleOAuthConfig()
  res.json({ ok:true, hasId: !!cfg.id, hasSecret: !!cfg.secret, redirectUri: `${req.protocol}://${req.headers.host}/email/oauth/callback` })
}))
app.get('/email/oauth/config', auth, wrap(async (req,res)=>{
  const cfg = await getGoogleOAuthConfig()
  res.json({ hasId: !!cfg.id, hasSecret: !!cfg.secret })
}))
// 生成授权链接：GET /email/oauth/url?accountId=（accountId 可为空，新绑定时先建占位账号）
app.get('/email/oauth/url', auth, wrap(async (req,res)=>{
  try{
    const o = await buildOAuthClient(req, null)
    const state = Buffer.from(JSON.stringify({ u: req.user, a: req.query.accountId || '' })).toString('base64url')
    const url = o.generateAuthUrl({ access_type:'offline', prompt:'consent', scope: GMAIL_SCOPES, state })
    return res.json({ url })
  }catch(e){
    const msg = String(e.message||e)
    if(msg.includes('未配置')) return res.status(400).json({ error:'还没配置 Google OAuth 应用：请先去 Google Cloud Console 建 OAuth 客户端，把 Client ID/Secret 填到下方“高级：Client ID 配置”里（文档见 server/GMAIL_API_SETUP.md 第一章）' })
    return res.status(500).json({ error: msg.slice(0,200) })
  }
}))
// OAuth 回调（Google 跳转回来，不需要 token，用 state 验用户）
app.get('/email/oauth/callback', wrap(async (req,res)=>{
  try{
    const { code, state } = req.query
    if(!code || !state) return res.status(400).send('缺少 code/state')
    const st = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8'))
    const o = await buildOAuthClient(req, null)
    const { tokens } = await o.getToken(String(code))
    if(!tokens.refresh_token) throw new Error('Google 未返回 refresh_token（请用 prompt=consent 重新授权）')
    o.setCredentials(tokens)
    const { google } = await import('googleapis')
    const gmail = google.gmail({ version:'v1', auth:o })
    const me = await gmail.users.getProfile({ userId:'me' })
    const email = me.data.emailAddress || ''
    // 找或建账号行
    let accountId = st.a || ''
    if(dbReady){
      if(accountId){
        const [ex] = await pool.query('SELECT id FROM email_accounts WHERE id=? AND username=?',[accountId, st.u])
        if(!ex.length) accountId = ''
      }
      if(!accountId){
        const [ex2] = await pool.query('SELECT id FROM email_accounts WHERE username=? AND email=?',[st.u, email])
        if(ex2.length) accountId = ex2[0].id
      }
      if(!accountId){
        accountId = crypto.randomUUID()
        await pool.query(`INSERT INTO email_accounts (id, username, email, provider, imap_host, imap_port, smtp_host, smtp_port, auth_enc) VALUES (?,?,?,?,?,?,?,?,?)`,
          [accountId, st.u, email, 'gmail', 'imap.gmail.com', 993, 'smtp.gmail.com', 465, encAuth('oauth:'+accountId)])
      }
      await pool.query(`INSERT INTO gmail_oauth (account_id, username, email, refresh_token, access_token, access_expires_at, scope, updated_at) VALUES (?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE email=VALUES(email), refresh_token=VALUES(refresh_token), access_token=VALUES(access_token), access_expires_at=VALUES(access_expires_at), scope=VALUES(scope), updated_at=VALUES(updated_at)`,
        [accountId, st.u, email, encAuth(tokens.refresh_token), tokens.access_token ? encAuth(tokens.access_token) : null,
         tokens.expiry_date ? sqlDate(new Date(tokens.expiry_date)) : null, GMAIL_SCOPES.join(' '), sqlNow()])
      // 一键升级：已有 IMAP 账号授权成功后，自动停掉它的 IMAP 监听，切 REST API 模式
      // （usesGmailApi 此后返回 true：ingest/标已读自动走 API；旧授权码保留不动）
      try{ stopMailWatcher(accountId) }catch{}
      // 记初始 historyId，后续增量用
      try{
        const hid = me.data.historyId || ''
        if(hid) await pool.query(`INSERT INTO mail_sync_state (account_id, folder, uidvalidity, last_uid, uidnext, full_sync_done, last_sync_at, history_id) VALUES (?,?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE history_id=VALUES(history_id)`,[accountId, '[Gmail]/All Mail', 0, 0, 0, 0, sqlNow(), String(hid)])
      }catch{}
    }
    res.send(`<html><body style="font-family:sans-serif;padding:40px"><h2>✅ Gmail 授权成功</h2><p>账号：${email}</p><p>可以关闭此页面，回到工作台点“同步”开始首次全量。</p></body></html>`)
  }catch(e){
    res.status(500).send('授权失败：' + String(e.message||e).slice(0,200))
  }
}))
// OAuth 状态：GET /email/oauth/status/:accountId
app.get('/email/oauth/status/:accountId', auth, wrap(async (req,res)=>{
  const acc = await loadMailAccount(req.params.accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  let connected = false, email = acc.email || '', historyId = ''
  try{
    const [rows] = await pool.query('SELECT email FROM gmail_oauth WHERE account_id=?',[req.params.accountId])
    if(rows.length){ connected = true; email = rows[0].email || email }
    const [srows] = await pool.query(`SELECT history_id FROM mail_sync_state WHERE account_id=? AND folder='[Gmail]/All Mail'`,[req.params.accountId])
    if(srows.length) historyId = srows[0].history_id || ''
  }catch{}
  res.json({ connected, email, historyId: historyId ? true : false, authType: connected ? 'oauth' : 'none' })
}))
// 解绑 OAuth：POST /email/oauth/disconnect/:accountId（只删凭证，不删邮件库）
app.post('/email/oauth/disconnect/:accountId', auth, wrap(async (req,res)=>{
  await pool.query('DELETE FROM gmail_oauth WHERE account_id=?',[req.params.accountId]).catch(()=>{})
  res.json({ ok:true })
}))

// ---------- Gmail 推送（P3：需 GCP Pub/Sub，见 GMAIL_API_SETUP.md）----------
// 开通/续期 watch：POST /email/push/watch/:accountId {topicName?}
app.post('/email/push/watch/:accountId', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId } = req.params
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const topicName = String(req.body?.topicName || '')
  try{
    const { google } = await import('googleapis');
    const o = await buildOAuthClient(req, accountId);
    const gmail = google.gmail({ version:'v1', auth:o });
    let topic = topicName
    if(!topic){
      const [rows] = await pool.query('SELECT topic_name FROM gmail_oauth WHERE account_id=?',[accountId]).catch(()=> [[]])
      topic = rows.length ? String(rows[0].topic_name || '') : ''
    }
    if(!topic) return res.status(400).json({ error:'需要 topicName（GCP Pub/Sub 主题，如 projects/xxx/topics/gmail）' })
    const st0 = { apiCalls:0 }
    const w = await gmailCall(()=> gmail.users.watch({ userId:'me', requestBody:{ topicName: topic, labelIds:['INBOX'] } }), st0, 'users.watch');
    await pool.query('UPDATE gmail_oauth SET topic_name=?, watch_expiration=?, updated_at=? WHERE account_id=?',
      [topic, w.data.expiration ? sqlDate(new Date(Number(w.data.expiration))) : null, sqlNow(), accountId])
    res.json({ ok:true, historyId: w.data.historyId, expiration: w.data.expiration })
  }catch(e){
    res.status(502).json({ error:'开通 watch 失败：' + String(e.message||e).slice(0,200) })
  }
}))
// 推送状态：GET /email/push/status/:accountId
app.get('/email/push/status/:accountId', auth, wrap(async (req,res)=>{
  const [rows] = await pool.query('SELECT topic_name, watch_expiration FROM gmail_oauth WHERE account_id=?',[req.params.accountId]).catch(()=> [[]])
  if(!rows.length) return res.json({ push:false })
  const exp = rows[0].watch_expiration ? new Date(rows[0].watch_expiration).getTime() : 0
  res.json({ push: !!rows[0].topic_name, topic: rows[0].topic_name || '', expiration: rows[0].watch_expiration || null,
    valid: exp > Date.now() + 2*86400000 })
}))
// Pub/Sub webhook 入口：POST /email/push/hook?token=xxx（Google 调用，需公网可达）
// token 在 server_config(push_secret) 里，Google Cloud 控制台订阅推送时带上 ?token=
// 收到后只做一件事：触发对应账号增量同步
app.post('/email/push/hook', wrap(async (req,res)=>{
  try{
    let secret = process.env.PUSH_SECRET || ''
    try{
      const [rows] = await pool.query(`SELECT v FROM server_config WHERE k='push_secret'`).catch(()=> [[]])
      if(rows.length) secret = rows[0].v || secret
    }catch{}
    if(!secret || String(req.query.token || '') !== secret) return res.status(403).send('forbidden')
    const msg = req.body && req.body.message;
    if(!msg || !msg.data) return res.json({ ok:true })
    const payload = JSON.parse(Buffer.from(String(msg.data), 'base64').toString('utf8'))
    const email = String(payload.emailAddress || '').toLowerCase()
    const hid = String(payload.historyId || '')
    if(!email) return res.json({ ok:true })
    const [arows] = await pool.query(`SELECT ea.id, ea.username FROM email_accounts ea JOIN gmail_oauth go ON go.account_id=ea.id WHERE LOWER(ea.email)=?`,[email]).catch(()=> [[]])
    for(const a of (arows||[])){
      const cur = ingestJobs.get(a.id)
      if(cur && cur.running) continue
      runGmailApiSync(a.id, a.username, { mode:'incremental' }).catch(()=>{})
    }
    res.json({ ok:true, historyId: hid })
  }catch(e){ res.json({ ok:true }) }
}))
// watch 自动续期：每天检查一次，2天内过期则续（需 topic 已配）
async function pushRenewTick(){
  if(!dbReady) return
  try{
    const [rows] = await pool.query(`SELECT account_id, username, topic_name, watch_expiration FROM gmail_oauth WHERE topic_name<>'' AND watch_expiration IS NOT NULL AND watch_expiration < DATE_ADD(NOW(), INTERVAL 2 DAY)`).catch(()=> [[]])
    for(const r of rows){
      try{
        const { google } = await import('googleapis');
        // 构造内部 req 桩供 buildOAuthClient 取 host（续期不依赖本次请求，用 server_config 回退无妨，此处直接连）
        const o = await buildOAuthClient({ headers:{}, protocol:'https' }, r.account_id);
        const gmail = google.gmail({ version:'v1', auth:o });
        const st0 = { apiCalls:0 };
        const w = await gmailCall(()=> gmail.users.watch({ userId:'me', requestBody:{ topicName: r.topic_name, labelIds:['INBOX'] } }), st0, 'users.watch-renew');
        await pool.query('UPDATE gmail_oauth SET watch_expiration=?, updated_at=? WHERE account_id=?',
          [w.data.expiration ? sqlDate(new Date(Number(w.data.expiration))) : null, sqlNow(), r.account_id]);
        console.log(`[push] watch 续期 ok ${r.account_id}`)
      }catch(e){ console.log('[push] watch 续期失败:', String(e.message||e).slice(0,120)) }
    }
  }catch{}
}
setInterval(pushRenewTick, 24*60*60*1000)

// ---------- Gmail API 同步引擎（P1，替代 IMAP；OAuth 必需）----------
// 游标：historyId 单真相源（mail_sync_state.history_id），去重键：gmail message id
// IMAP 时代的 gmail_msgid 即 API id（同一不可变 ID 的 hex），老数据天然对齐
const GMAIL_API_FOLDER = '[Gmail]/All Mail';
const GMAIL_BODY_MAX = 15*1024*1024; // 正文/附件单体上限，复用 IMAP 时代阈值语义
function gmailApiErr(e){
  const code = e && e.code;
  const reason = (e && e.errors && e.errors[0] && e.errors[0].reason) || '';
  return { code, reason, message: String((e && e.message) || e).slice(0,200) };
}
function b64urlToBuf(s){
  if(!s) return null;
  try{
    s = String(s).replace(/-/g,'+').replace(/_/g,'/');
    while(s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
  }catch{ return null }
}
function parseAddrHeader(v){
  v = String(v || '').trim();
  if(!v) return { name:'', address:'' };
  const m = v.match(/^(?:"?([^"]*)"?\s*)?<([^<>@\s]+@[^<>\s]+)>\s*$/);
  if(m) return { name:(m[1]||'').trim(), address:m[2].trim() };
  const m2 = v.match(/([^\s<>,;]+@[^\s<>,;]+)/);
  return { name:'', address: m2 ? m2[1].trim() : '' };
}
function walkGmailPayload(payload, cb){
  const stack = [payload].filter(Boolean);
  while(stack.length){
    const p = stack.pop();
    if(!p) continue;
    if(p.parts && p.parts.length){ for(const c of p.parts) stack.push(c); continue }
    cb(p);
  }
}
function extractGmailBody(payload){
  let text = '', html = '';
  walkGmailPayload(payload, (p)=>{
    const mime = String(p.mimeType || '');
    const data = p.body && p.body.data;
    if(!data) return;
    if(p.filename) return; // 附件另行处理
    const buf = b64urlToBuf(data);
    if(!buf) return;
    const s = buf.toString('utf8');
    if(mime === 'text/plain' && !text) text = s;
    else if(mime === 'text/html' && !html) html = s;
  });
  return { text, html };
}
function extractGmailAttachments(payload){
  const out = [];
  walkGmailPayload(payload, (p)=>{
    if(p.filename && p.body && p.body.attachmentId){
      out.push({ filename: p.filename, attachmentId: p.body.attachmentId,
        mime: p.mimeType || '', size: p.body.size || 0 });
    }
  });
  return out;
}
function gmailHeader(payload, name){
  const hs = (payload && payload.headers) || [];
  const h = hs.find(x=> String(x.name||'').toLowerCase() === String(name).toLowerCase());
  return h ? String(h.value || '') : '';
}
// 配额感知调用：429/403 配额/5xx 指数退避重试；401 抛认证错；404 抛未找到（调用方转全量）
async function gmailCall(fn, st, label){
  let wait = 8000;
  for(let attempt = 0; attempt < 8; attempt++){
    if(st && st.cancelled) throw new Error('cancelled');
    try{
      if(st) st.apiCalls = (st.apiCalls || 0) + 1;
      return await fn();
    }catch(e){
      const { code, reason, message } = gmailApiErr(e);
      if(code === 401) throw new Error('Gmail 授权失效，请重新 OAuth 绑定');
      if(code === 404) { const err = new Error('historyId 过期'); err.gapi404 = true; throw err }
      const isQuota = code === 429 || code === 403
      const retryable = isQuota || (code >= 500 && code < 600) || !code;
      if(!retryable || attempt === 7) throw new Error(`Gmail API 失败(${label}): ${reason || code || ''} ${message}`.slice(0,200));
      // 配额类错误起始等待更长，避免并行 worker 同时撞墙
      const base = isQuota ? Math.max(wait, 15000) : wait
      await new Promise(r=>setTimeout(r, base + Math.floor(Math.random()*2000)));
      wait = Math.min(wait*2, 3*60*1000);
    }
  }
}
async function getGmailService(accountId, username, req){
  const { google } = await import('googleapis');
  const o = await buildOAuthClient(req, accountId);
  const [rows] = await pool.query('SELECT refresh_token FROM gmail_oauth WHERE account_id=?',[accountId]).catch(()=> [[]]);
  if(!rows.length || !rows[0].refresh_token) throw new Error('该账号未 OAuth 绑定，请先绑定');
  return google.gmail({ version:'v1', auth:o });
}
async function rebuildGmailThreads(accountId, folder){
  try{
    const [trows] = await pool.query(`SELECT gmail_threadid AS tid, COUNT(*) AS c, MAX(msg_date) AS lastd, ANY_VALUE(subject) AS subj FROM mail_messages WHERE account_id=? AND folder=? AND gmail_threadid<>'' GROUP BY gmail_threadid`,[accountId, folder]);
    for(let i=0;i<trows.length;i+=500){
      const ch = trows.slice(i,i+500);
      const vals = [];
      const params = [];
      for(const t of ch){ vals.push('(?,?,?,?,?)'); params.push(accountId, String(t.tid).slice(0,64), normSubject(t.subj), Number(t.c)||0, t.lastd) }
      if(vals.length) await pool.query(`INSERT INTO mail_threads (account_id, thread_id, subject_norm, count, last_date) VALUES ${vals.join(',')} ON DUPLICATE KEY UPDATE subject_norm=VALUES(subject_norm), count=VALUES(count), last_date=VALUES(last_date)`, params);
    }
  }catch(e){ console.log('[gapi] threads skip:', String(e.message||e).slice(0,80)) }
}
// 单封 FULL 消息 → 入库行（含正文+附件），复用 IMAP 时代的表结构与钩子
// opts.skipAttachments: 批量回填时跳过附件二进制（只记元数据），打开邮件再下
async function ingestGmailFull(gmail, accountId, username, folder, uid, apiId, st, opts = {}){
  const full = await gmailCall(()=> gmail.users.messages.get({ userId:'me', id: apiId, format:'FULL' }), st, 'messages.get');
  const m = full.data || {};
  const payload = m.payload || {};
  const subject = gmailHeader(payload, 'Subject') || '(无主题)';
  const from = parseAddrHeader(gmailHeader(payload, 'From'));
  const toList = gmailHeader(payload, 'To').split(',').map(s=> parseAddrHeader(s).address || s.trim()).filter(Boolean).join(', ').slice(0,1024);
  const msgId = gmailHeader(payload, 'Message-ID').slice(0,512);
  const internalMs = Number(m.internalDate || 0);
  const msgDate = internalMs ? sqlDate(new Date(internalMs)) : sqlDate(new Date());
  const labelIds = m.labelIds || [];
  const seen = !labelIds.includes('UNREAD');
  const labels = labelIds.join(',');
  const { text: bodyText0, html: bodyHtml0 } = extractGmailBody(payload);
  let bodyText = String(bodyText0 || bodyHtml0 || '').slice(0, 500000);
  let bodyHtml = bodyHtml0 ? String(bodyHtml0).slice(0, 800000) : null;
  const atts = extractGmailAttachments(payload);
  const bigTotal = atts.reduce((s,a)=> s + (Number(a.size)||0), 0);
  if(bigTotal > GMAIL_BODY_MAX && !bodyText){
    bodyText = '[超大邮件，正文未入库，请在线查看]';
  }
  // 占位正文不算已缓存（body_cached=2）
  const bodyCachedFlag = bodyText ? (bodyText.startsWith('[') ? 2 : 1) : 0;
  const r = await pool.query(
    `INSERT INTO mail_messages (account_id, folder, uid, message_id, gmail_msgid, gmail_threadid, subject, from_addr, from_name, to_addr, msg_date, is_read, has_attachment, body_text, body_html, body_cached, labels, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE subject=VALUES(subject), is_read=VALUES(is_read), has_attachment=GREATEST(has_attachment, VALUES(has_attachment)), labels=VALUES(labels),
       body_text=IF(body_cached=0 AND VALUES(body_cached)>=1, VALUES(body_text), body_text),
       body_html=IF(body_cached=0 AND VALUES(body_cached)>=1, VALUES(body_html), body_html),
       body_cached=IF(VALUES(body_cached)>=1, VALUES(body_cached), body_cached), updated_at=VALUES(updated_at)`,
    [accountId, folder, uid, msgId, apiId, String(m.threadId||'').slice(0,64), String(subject).slice(0,1024),
     from.address.slice(0,512), from.name.slice(0,256), toAddrsFix(toList), msgDate, seen?1:0, atts.length?1:0,
     bodyText, bodyHtml, bodyCachedFlag, labels.slice(0,1024), sqlNow()]);
  const isNew = r[0].affectedRows === 1;
  if(isNew) st.added = (st.added||0)+1; else st.updated = (st.updated||0)+1;
  st.done = (st.done||0)+1;
  st.realBodies = (st.realBodies||0) + (bodyText && !bodyText.startsWith('[') ? 1 : 0);
  // 附件：记录全部（不截断），>50MB 只记元数据
  // skipAttachments：只写元数据+gmail_att_id，二进制由后续附件回填补
  for(const a of atts){
    try{
      if((Number(a.size)||0) > 50*1024*1024){
        await pool.query(`INSERT INTO mail_attachments (account_id, folder, uid, filename, size, mime, path, gmail_att_id) VALUES (?,?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE size=VALUES(size), mime=VALUES(mime), gmail_att_id=VALUES(gmail_att_id)`,
          [accountId, folder, uid, safeFileName(a.filename), Number(a.size)||0, String(a.mime||'').slice(0,128), '', String(a.attachmentId||'').slice(0,128)]).catch(()=>{});
        continue
      }
      if(opts.skipAttachments){
        await pool.query(`INSERT INTO mail_attachments (account_id, folder, uid, filename, size, mime, path, gmail_att_id) VALUES (?,?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE size=VALUES(size), mime=VALUES(mime), gmail_att_id=VALUES(gmail_att_id)`,
          [accountId, folder, uid, safeFileName(a.filename), Number(a.size)||0, String(a.mime||'').slice(0,128), '', String(a.attachmentId||'').slice(0,128)]).catch(()=>{});
        continue
      }
      const ad = await gmailCall(()=> gmail.users.messages.attachments.get({ userId:'me', messageId: apiId, id: a.attachmentId }), st, 'attachments.get');
      const buf = b64urlToBuf(ad.data && ad.data.data);
      if(!buf) continue;
      const sv = await saveAttachment(accountId, folder, uid, { filename: a.filename, content: buf, size: buf.length, contentType: a.mime });
      if(sv.saved){
        await pool.query(`INSERT INTO mail_attachments (account_id, folder, uid, filename, size, mime, path, gmail_att_id) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE size=VALUES(size), mime=VALUES(mime), path=VALUES(path), gmail_att_id=VALUES(gmail_att_id)`,
          [accountId, folder, uid, safeFileName(a.filename), sv.size || 0, String(a.mime||'').slice(0,128), sv.path || '', String(a.attachmentId||'').slice(0,128)]);
      }
    }catch{}
  }
  // 回复检测（14天内新邮件才触发，复用 IMAP 时代钩子）
  try{
    const fromAddr = from.address.toLowerCase();
    const meAddr = ''; // 与账号自身比对在外层做，这里只传结构
    void meAddr;
    const env = { subject, from:[{ address: from.address, name: from.name }] };
    const parsed = { subject, text: bodyText, from:{ value:[{ address: from.address }] }, headers: new Map() };
    await seqReplyCheck(accountId, username, uid, env, parsed, internalMs ? new Date(internalMs) : new Date());
  }catch{}
  return { isNew, hasBody: !!bodyText };
}
function toAddrsFix(s){ return String(s||'').slice(0,1024) }
// 并发池（无新依赖）
async function pmap(items, n, fn){
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async ()=>{
    while(true){
      const k = i++;
      if(k >= items.length) return;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}
async function readSyncHistoryId(accountId, folder){
  try{
    const [rows] = await pool.query('SELECT history_id FROM mail_sync_state WHERE account_id=? AND folder=?',[accountId, folder]);
    if(rows.length && rows[0].history_id) return String(rows[0].history_id);
  }catch{}
  return '';
}
async function writeSyncHistoryId(accountId, folder, historyId, fullDone){
  try{
    await pool.query(`INSERT INTO mail_sync_state (account_id, folder, uidvalidity, last_uid, uidnext, full_sync_done, last_sync_at, history_id)
      VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE history_id=VALUES(history_id), full_sync_done=GREATEST(full_sync_done, VALUES(full_sync_done)), last_sync_at=VALUES(last_sync_at)`,
      [accountId, folder, 0, 0, 0, fullDone?1:0, sqlNow(), String(historyId||'')]);
  }catch{}
}
// Gmail API 全量：messages.list 分页取 ID → 差集 → METADATA 信封 → FULL 正文
async function gmailApiFullSync(gmail, accountId, username, folder, st, haveMap, getCounter){
  let pageToken = undefined;
  const missingIds = [];
  for(;;){
    if(st.cancelled) throw new Error('cancelled');
    const res = await gmailCall(()=> gmail.users.messages.list({ userId:'me', maxResults:500, pageToken }), st, 'messages.list');
    const msgs = (res.data && res.data.messages) || [];
    for(const m of msgs){ if(m.id && !haveMap.has(m.id)) missingIds.push(m.id); }
    st.total = (st.total||0) + msgs.length;
    pageToken = res.data.nextPageToken;
    if(!pageToken) break;
    await new Promise(r=>setImmediate(r));
  }
  // Phase A：信封（METADATA，并发 8）
  // 去重两道：① gmail_msgid（API id，老 IMAP 行若有 X-GM-MSGID 直接命中）
  // ② Message-ID 头（老行基本都有 message_id，但是 gmail_msgid 为空的救命钥匙）
  const [midRows] = await pool.query('SELECT message_id, uid FROM mail_messages WHERE account_id=? AND folder=? AND message_id<>""',[accountId, folder]).catch(()=> [[]]);
  const midMap = new Map((midRows||[]).map(r=>[String(r.message_id).trim().toLowerCase(), Number(r.uid)]));
  const B = 50;
  for(let i=0;i<missingIds.length;i+=B){
    if(st.cancelled) throw new Error('cancelled');
    const batch = missingIds.slice(i,i+B);
    await pmap(batch, 8, async (apiId)=>{
      const meta = await gmailCall(()=> gmail.users.messages.get({ userId:'me', id: apiId, format:'METADATA', metadataHeaders:['Subject','From','To','Date','Message-ID'] }), st, 'messages.get-meta');
      const mm = meta.data || {};
      const p = mm.payload || {};
      const subject = gmailHeader(p, 'Subject') || '(无主题)';
      const from = parseAddrHeader(gmailHeader(p, 'From'));
      const toList = gmailHeader(p, 'To').split(',').map(s=> parseAddrHeader(s).address || s.trim()).filter(Boolean).join(', ').slice(0,1024);
      const midRaw = gmailHeader(p, 'Message-ID').trim().slice(0,512);
      const internalMs = Number(mm.internalDate || 0);
      const labelIds = mm.labelIds || [];
      // Message-ID 兜底：命中老 IMAP 行 → 复用其 uid 并补上 gmail_msgid
      const reuseUid = midMap.get(midRaw.toLowerCase());
      const uid = reuseUid || getCounter();
      await pool.query(
        `INSERT INTO mail_messages (account_id, folder, uid, message_id, gmail_msgid, gmail_threadid, subject, from_addr, from_name, to_addr, msg_date, is_read, has_attachment, body_text, body_cached, labels, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE is_read=VALUES(is_read), labels=VALUES(labels), gmail_msgid=VALUES(gmail_msgid), message_id=VALUES(message_id), updated_at=VALUES(updated_at)`,
        [accountId, folder, uid, midRaw, apiId, String(mm.threadId||'').slice(0,64),
         String(subject).slice(0,1024), from.address.slice(0,512), from.name.slice(0,256), toList,
         internalMs ? sqlDate(new Date(internalMs)) : sqlNow().slice(0,19).replace('T',' '), labelIds.includes('UNREAD')?0:1, 0, '', 0, labelIds.join(',').slice(0,1024), sqlNow()]);
      haveMap.set(apiId, uid);
      if(reuseUid) st.updated = (st.updated||0)+1;
      st.done = (st.done||0)+1;
    });
    if(typeof st.refreshStoreCounts === 'function') await st.refreshStoreCounts();
    await new Promise(r=>setImmediate(r));
  }
  // Phase B：正文（FULL，并发 4，沿用停滞熔断语义）
  st.phase = 'full-body';
  await gmailApiBackfillBodies(gmail, accountId, username, folder, st);
}
// 正文回填：body_cached=0 的倒序补 FULL（新邮件优先），整轮零产出记停滞
// 老 IMAP 行 gmail_msgid 常为空：用 rfc822msgid 反查 API id 再拉正文
// 提速：并行反查 + 高并发 FULL；批量回填跳过附件（附件打开时再下）
const GMAIL_BODY_CONCURRENCY = Math.max(4, Math.min(16, Number(process.env.GMAIL_BODY_CONCURRENCY) || 8))
const GMAIL_RESOLVE_CONCURRENCY = Math.max(4, Math.min(16, Number(process.env.GMAIL_RESOLVE_CONCURRENCY) || 6))
const GMAIL_ATT_CONCURRENCY = Math.max(2, Math.min(8, Number(process.env.GMAIL_ATT_CONCURRENCY) || 4))
async function gmailApiBackfillBodies(gmail, accountId, username, folder, st, opts = {}){
  const resolveByMessageId = async (uid, midRaw) => {
    const mid = String(midRaw||'').trim().replace(/^</,'').replace(/>$/,'')
    if(!mid) return { gid:null, permanent:true }
    try{
      const res = await gmailCall(()=> gmail.users.messages.list({ userId:'me', q: `rfc822msgid:${mid}`, maxResults: 1 }), st, 'list-rfc822')
      const gid = res?.data?.messages?.[0]?.id || ''
      if(!gid) return { gid:null, permanent:true } // 查到了但云端没有
      await pool.query('UPDATE mail_messages SET gmail_msgid=?, updated_at=? WHERE account_id=? AND folder=? AND uid=?',
        [gid, sqlNow(), accountId, folder, uid]).catch(()=>{})
      return { gid, permanent:false }
    }catch(e){
      // 配额/网络失败：不要标成「云端无此邮件」，留给下一轮
      const msg = String(e.message||e)
      const transient = /配额|quota|429|403|超时|timeout|network|失败/i.test(msg)
      return { gid:null, permanent: !transient }
    }
  }
  for(;;){
    if(st.cancelled) throw new Error('cancelled');
    // ① 已有 gmail_msgid 的待补正文（优先，免反查）
    let [todoRows] = await pool.query(
      `SELECT uid, gmail_msgid AS gid FROM mail_messages
       WHERE account_id=? AND folder=? AND body_cached=0 AND gmail_msgid<>""
       ORDER BY msg_date DESC LIMIT 300`,[accountId, folder]).catch(()=> [[]]);
    let todo = (todoRows||[]).filter(r=>r.gid).map(r=>({ gid:String(r.gid), uid:Number(r.uid) }));
    // ② 无 gmail_msgid 的老 IMAP 行：并行按 Message-ID 反查
    const resolveBudget = 80
    if(todo.length < resolveBudget){
      const [orphans] = await pool.query(
        `SELECT uid, message_id AS mid FROM mail_messages
         WHERE account_id=? AND folder=? AND body_cached=0 AND gmail_msgid="" AND message_id<>""
         ORDER BY msg_date DESC LIMIT ${resolveBudget - todo.length}`,[accountId, folder]).catch(()=> [[]]);
      let transientFails = 0
      const resolved = await pmap(orphans||[], GMAIL_RESOLVE_CONCURRENCY, async (o)=>{
        if(st.cancelled) return null
        const { gid, permanent } = await resolveByMessageId(Number(o.uid), o.mid)
        if(gid) return { gid, uid:Number(o.uid) }
        if(!permanent){ transientFails++; return null }
        await pool.query(
          `UPDATE mail_messages SET body_text='[云端无对应邮件，正文未入库]', body_cached=2, updated_at=?
           WHERE account_id=? AND folder=? AND uid=? AND body_cached=0`,
          [sqlNow(), accountId, folder, Number(o.uid)]).catch(()=>{})
        return null
      })
      for(const r of resolved){ if(r) todo.push(r) }
      // 反查大面积瞬时失败：本轮直接结束，等配额恢复，避免 stall 误杀
      if(!todo.length && transientFails >= Math.ceil((orphans||[]).length * 0.6) && (orphans||[]).length > 0){
        st.phase = 'quota-wait'
        await new Promise(r=>setTimeout(r, 60000))
        continue
      }
    }
    if(!todo.length) break;
    const roundBefore = st.realBodies || 0;
    await pmap(todo, GMAIL_BODY_CONCURRENCY, async (item)=>{
      if(st.cancelled) throw new Error('cancelled');
      try{
        // skipAttachments=true：正文优先；附件元数据仍写，二进制打开时再拉
        await ingestGmailFull(gmail, accountId, username, folder, item.uid, item.gid, st, { skipAttachments:true });
      }catch(e){
        st.chunkFails = st.chunkFails || {};
        const k = 'api:' + String(item.gid).slice(-8);
        st.chunkFails[k] = (st.chunkFails[k] || 0) + 1;
        if(st.chunkFails[k] >= 3 && (st.realBodies||0) > 0){
          await pool.query(`UPDATE mail_messages SET body_text='[多次拉取超时已跳过，点开邮件时在线查看]', body_cached=2, updated_at=? WHERE account_id=? AND folder=? AND uid=? AND body_cached=0`,
            [sqlNow(), accountId, folder, item.uid]).catch(()=>{});
        }
      }
    });
    if((st.realBodies||0) === roundBefore){
      st.stallRounds = (st.stallRounds||0)+1;
      // 配额期很容易整轮 0 产出：多等几轮，且优先等而不是直接失败
      if(st.stallRounds >= 6){
        st.phase = 'quota-wait'
        await new Promise(r=>setTimeout(r, 90000))
        st.stallRounds = 0
        // 连续两段等待仍无进展才退出，让 auto-tick 下次重开
        st.quotaWaits = (st.quotaWaits||0)+1
        if(st.quotaWaits >= 3) throw new Error('no-progress: throttled, will retry on next tick')
      }
    } else st.stallRounds = 0;
    // 附件独立并行任务时，正文循环不再插附件
    if(!opts.skipInterleavedAtt){
      try{
        st.phase = 'body+att'
        await gmailApiBackfillAttachments(gmail, accountId, username, folder, st, { maxBatches: 1 })
      }catch(e){
        if(String(e.message||'').includes('cancelled')) throw e
      }
    }
    if(typeof st.refreshStoreCounts === 'function') await st.refreshStoreCounts();
  }
}
// 附件二进制回填：始终 messages.get(FULL) 取新鲜 attachmentId 再下载
// （库存 attId 可能被截断/过期，直接用会 400 Invalid attachment token）
async function gmailApiBackfillAttachments(gmail, accountId, username, folder, st, opts = {}){
  const maxBatches = opts.maxBatches || Infinity
  let batches = 0
  const downloadOne = async (messageId, attId, uid, filename, mime, size) => {
    if((Number(size)||0) > 50*1024*1024) return false
    if(!attId) return false
    const ad = await gmailCall(()=> gmail.users.messages.attachments.get({ userId:'me', messageId, id: attId }), st, 'att.get')
    const buf = b64urlToBuf(ad.data && ad.data.data)
    if(!buf) return false
    const sv = await saveAttachment(accountId, folder, uid, { filename, content: buf, size: buf.length, contentType: mime })
    if(!sv.saved) return false
    await pool.query(
      `UPDATE mail_attachments SET path=?, size=GREATEST(size, ?), gmail_att_id=?
       WHERE account_id=? AND folder=? AND uid=? AND filename=?`,
      [sv.path || '', sv.size || 0, String(attId).slice(0,1024), accountId, folder, uid, safeFileName(filename)]).catch(()=>{})
    st.attDone = (st.attDone||0)+1
    return true
  }
  // 按邮件处理：取 FULL → 拿全部附件 → 下载 path 仍空的
  const processMessage = async (uid, gid) => {
    const full = await gmailCall(()=> gmail.users.messages.get({ userId:'me', id: String(gid), format:'FULL' }), st, 'att-full')
    const atts = extractGmailAttachments(full.data?.payload || {})
    for(const a of atts){
      if(st.cancelled) return
      const fname = safeFileName(a.filename)
      // upsert 元数据 + 新鲜 attId
      await pool.query(
        `INSERT INTO mail_attachments (account_id, folder, uid, filename, size, mime, path, gmail_att_id) VALUES (?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE size=VALUES(size), mime=VALUES(mime), gmail_att_id=VALUES(gmail_att_id)`,
        [accountId, folder, Number(uid), fname, Number(a.size)||0, String(a.mime||'').slice(0,128), '', String(a.attachmentId||'').slice(0,1024)]).catch(()=>{})
      // 已有 path 的跳过
      const [has] = await pool.query(
        `SELECT path FROM mail_attachments WHERE account_id=? AND folder=? AND uid=? AND filename=?`,
        [accountId, folder, Number(uid), fname]).catch(()=> [[]])
      if(has?.[0]?.path) continue
      try{
        await downloadOne(String(gid), String(a.attachmentId), Number(uid), a.filename, a.mime, a.size)
      }catch(e){
        st.attFails = (st.attFails||0)+1
        if((st.attFails||0) <= 8) console.log('[att-fail]', String(e.message||e).slice(0,140), 'uid', uid, a.filename)
      }
    }
  }
  for(;;){
    if(st.cancelled) throw new Error('cancelled')
    if(batches >= maxBatches) break
    batches++
    if(!opts.maxBatches) st.phase = 'attachments'
    const metaLimit = opts.maxBatches ? 8 : 20
    // 有待下载附件的邮件（按邮件聚合，避免对同一封反复 get）
    // 注意：only_full_group_by 下不能 DISTINCT+ORDER BY 非选择列
    const [needMsg] = await pool.query(
      `SELECT m.uid, m.gmail_msgid AS gid, MAX(m.msg_date) AS md
       FROM mail_attachments ma
       JOIN mail_messages m ON m.account_id=ma.account_id AND m.folder=ma.folder AND m.uid=ma.uid
       WHERE ma.account_id=? AND ma.folder=? AND (ma.path IS NULL OR ma.path='')
         AND m.gmail_msgid<>'' AND ma.size<=${50*1024*1024}
       GROUP BY m.uid, m.gmail_msgid
       ORDER BY md DESC
       LIMIT ${metaLimit}`,[accountId, folder]).catch((e)=>{ console.log('[att-q1]', e.message); return [[]] })
    // has_attachment=1 但还没有附件行
    const [needMeta] = await pool.query(
      `SELECT m.uid, m.gmail_msgid AS gid FROM mail_messages m
       WHERE m.account_id=? AND m.folder=? AND m.has_attachment=1 AND m.body_cached>=1 AND m.gmail_msgid<>""
         AND NOT EXISTS (SELECT 1 FROM mail_attachments a WHERE a.account_id=m.account_id AND a.folder=m.folder AND a.uid=m.uid)
       ORDER BY m.msg_date DESC LIMIT ${metaLimit}`,[accountId, folder]).catch((e)=>{ console.log('[att-q2]', e.message); return [[]] })
    if(!needMsg.length && !needMeta.length) break
    const work = [...(needMsg||[]), ...(needMeta||[])]
    // 按邮件串行处理（每封一次 FULL + 若干 att.get），邮件间有限并发
    await pmap(work, Math.min(3, GMAIL_ATT_CONCURRENCY), async (row)=>{
      if(st.cancelled) return
      try{ await processMessage(Number(row.uid), String(row.gid)) }
      catch(e){
        st.attFails = (st.attFails||0)+1
        if((st.attFails||0) <= 8) console.log('[att-msg-fail]', String(e.message||e).slice(0,140), 'uid', row.uid)
      }
    })
    if(typeof st.refreshStoreCounts === 'function') await st.refreshStoreCounts()
    const doneDelta = (st.attDone||0) - (st._attDoneLast||0)
    if(doneDelta <= 0){
      st._attStall = (st._attStall||0)+1
    } else {
      st._attStall = 0
      st._attDoneLast = st.attDone||0
    }
    if(st._attStall >= 10){
      console.log('[att] stall exit, attDone=', st.attDone, 'attFails=', st.attFails)
      break
    }
    if((st.attDone||0) === 0 && (st.attFails||0) > 30) throw new Error('attachment-backfill: too many failures')
  }
}
// Gmail API 增量：history.list → added/deleted/labels
async function gmailApiIncremental(gmail, accountId, username, folder, st, startHistoryId){
  let pageToken = undefined;
  let latestHid = startHistoryId;
  const toFetchFull = [];
  const toCheckMin = [];
  const toDelete = [];
  for(;;){
    if(st.cancelled) throw new Error('cancelled');
    let res;
    try{
      res = await gmailCall(()=> gmail.users.history.list({ userId:'me', startHistoryId, historyTypes:['messageAdded','messageDeleted','labelAdded','labelRemoved'], maxResults:500, pageToken }), st, 'history.list');
    }catch(e){
      if(e && e.gapi404) throw new Error('HISTORY_EXPIRED');
      throw e;
    }
    const data = res.data || {};
    if(data.historyId) latestHid = data.historyId;
    for(const h of (data.history || [])){
      for(const a of (h.messagesAdded || [])) if(a.message && a.message.id) toFetchFull.push(a.message.id);
      for(const d of (h.messagesDeleted || [])) if(d.message && d.message.id) toDelete.push(d.message.id);
      for(const l of (h.labelsAdded || [])) if(l.message && l.message.id) toCheckMin.push(l.message.id);
      for(const l of (h.labelsRemoved || [])) if(l.message && l.message.id) toCheckMin.push(l.message.id);
    }
    pageToken = data.nextPageToken;
    if(!pageToken) break;
  }
  // 预载去重表
  const [haveRows] = await pool.query('SELECT gmail_msgid, uid FROM mail_messages WHERE account_id=? AND folder=?',[accountId, folder]).catch(()=> [[]]);
  const haveMap = new Map((haveRows||[]).map(r=>[String(r.gmail_msgid), Number(r.uid)]));
  let [mx] = await pool.query('SELECT MAX(uid) AS m FROM mail_messages WHERE account_id=? AND folder=?',[accountId, folder]).catch(()=> [[{m:0}]]);
  let counter = Number((mx[0] && mx[0].m) || 0);
  const getCounter = ()=> ++counter;
  // 新增：FULL 入库（含正文）
  const fresh = [...new Set(toFetchFull)].filter(id=> !haveMap.has(id));
  st.total = (st.total||0) + fresh.length;
  await pmap(fresh, 4, async (apiId)=>{
    if(st.cancelled) throw new Error('cancelled');
    const uid = getCounter();
    try{
      await ingestGmailFull(gmail, accountId, username, folder, uid, apiId, st);
      haveMap.set(apiId, uid);
    }catch(e){
      if(String(e.message||'').includes('cancelled')) throw e;
      st.chunkFails = st.chunkFails || {};
      st.chunkFails['incr'] = (st.chunkFails['incr']||0)+1;
    }
  });
  // 删除：硬删（与 Gmail 一致）
  for(const gid of [...new Set(toDelete)]){
    try{
      const [ur] = await pool.query('SELECT uid FROM mail_messages WHERE account_id=? AND gmail_msgid=?',[accountId, gid]).catch(()=> [[]]);
      const duid = ur.length ? Number(ur[0].uid) : 0;
      if(duid) await pool.query('DELETE FROM mail_attachments WHERE account_id=? AND folder=? AND uid=?',[accountId, folder, duid]).catch(()=>{});
      await pool.query('DELETE FROM mail_messages WHERE account_id=? AND gmail_msgid=?',[accountId, gid]);
    }catch{}
  }
  if(typeof st.refreshStoreCounts === 'function') await st.refreshStoreCounts();
  // 标签变化：MINIMAL 重读已读状态
  for(const gid of [...new Set(toCheckMin)]){
    try{
      const mm = await gmailCall(()=> gmail.users.messages.get({ userId:'me', id: gid, format:'MINIMAL' }), st, 'messages.get-min');
      const labels = (mm.data && mm.data.labelIds) || [];
      await pool.query('UPDATE mail_messages SET is_read=?, labels=?, updated_at=? WHERE account_id=? AND gmail_msgid=?',
        [labels.includes('UNREAD')?0:1, labels.join(',').slice(0,1024), sqlNow(), accountId, gid]);
    }catch{}
    await new Promise(r=>setImmediate(r));
  }
  await rebuildGmailThreads(accountId, folder);
  return latestHid;
}
// job 序列化：去掉函数/大 Map，只保留 UI 需要的进度字段
function sanitizeJob(job){
  if(!job) return null
  return {
    running: !!job.running,
    engine: job.engine || (job.mode === 'gmail' ? 'gmail-api' : 'imap'),
    mode: job.mode || '',
    phase: job.phase || '',
    folder: job.folder || '',
    done: Number(job.done)||0,
    total: Number(job.total)||0,
    added: Number(job.added)||0,
    updated: Number(job.updated)||0,
    realBodies: Number(job.realBodies)||0,
    apiCalls: Number(job.apiCalls)||0,
    historyId: job.historyId || '',
    dbCount: Number(job.dbCount)||0,
    bodyCount: Number(job.bodyCount)||0,
    placeholderCount: Number(job.placeholderCount)||0,
    pendingBodies: Number(job.pendingBodies)||0,
    attDone: Number(job.attDone)||0,
    attFails: Number(job.attFails)||0,
    startedAt: job.startedAt || '',
    error: job.error || '',
    cancelled: !!job.cancelled
  }
}
// 主入口：POST /email/gsync/:accountId {mode?: auto|full|incremental}
// body_cached: 0=待补, 1=已缓存, 2=占位（多次失败跳过）
async function runGmailApiSync(accountId, username, opts = {}){
  const folder = GMAIL_API_FOLDER;
  let st = ingestJobs.get(accountId);
  if(st && st.running) throw new Error('已有同步任务进行中');
  st = { running:true, engine:'gmail-api', mode:'gmail', folder, done:0, total:0, added:0, updated:0,
    startedAt:new Date().toISOString(), error:'', apiCalls:0, historyId:'', phase:'init',
    dbCount:0, bodyCount:0, placeholderCount:0, pendingBodies:0 };
  ingestJobs.set(accountId, st);
  const refreshStoreCounts = async ()=>{
    try{
      const [c] = await pool.query(
        `SELECT COUNT(*) AS c,
           SUM(CASE WHEN body_cached=1 THEN 1 ELSE 0 END) AS bodies,
           SUM(CASE WHEN body_cached=2 THEN 1 ELSE 0 END) AS ph,
           SUM(CASE WHEN body_cached=0 THEN 1 ELSE 0 END) AS pend
         FROM mail_messages WHERE account_id=? AND folder=?`, [accountId, folder]);
      st.dbCount = Number(c[0]?.c)||0;
      st.bodyCount = Number(c[0]?.bodies)||0;
      st.placeholderCount = Number(c[0]?.ph)||0;
      st.pendingBodies = Number(c[0]?.pend)||0;
    }catch{}
  };
  st.refreshStoreCounts = refreshStoreCounts;
  const acc = await loadMailAccount(accountId, username);
  if(!acc) { st.running = false; throw new Error('账号不存在或数据库未就绪') }
  let gmail;
  try{
    const { google } = await import('googleapis');
    const o = await buildOAuthClient(null, accountId);
    const [orows] = await pool.query('SELECT 1 FROM gmail_oauth WHERE account_id=?',[accountId]).catch(()=> [[]]);
    if(!orows.length) throw new Error('该账号未 OAuth 绑定，请先绑定');
    gmail = google.gmail({ version:'v1', auth:o });
  }catch(e){ st.running = false; st.error = String(e.message||e).slice(0,200); throw e }
  try{
    await refreshStoreCounts();
    let mode = opts.mode || 'auto';
    let hid = await readSyncHistoryId(accountId, folder);
    if(mode === 'auto') mode = hid ? 'incremental' : 'full';
    st.mode = mode;
    if(mode === 'incremental' && hid){
      try{
        st.phase = 'incremental';
        const latest = await gmailApiIncremental(gmail, accountId, username, folder, st, hid);
        await writeSyncHistoryId(accountId, folder, latest, true);
        st.historyId = latest;
      }catch(e){
        if(String(e.message||'').includes('HISTORY_EXPIRED')) mode = 'full';
        else throw e;
      }
    }
    if(mode === 'full'){
      st.phase = 'full-envelope';
      // 预载去重表 + 计数器
      const [haveRows] = await pool.query('SELECT gmail_msgid, uid FROM mail_messages WHERE account_id=? AND folder=?',[accountId, folder]).catch(()=> [[]]);
      const haveMap = new Map((haveRows||[]).map(r=>[String(r.gmail_msgid), Number(r.uid)]).filter(([k])=>k));
      let [mx] = await pool.query('SELECT MAX(uid) AS m FROM mail_messages WHERE account_id=? AND folder=?',[accountId, folder]).catch(()=> [[{m:0}]]);
      let counter = Number((mx[0] && mx[0].m) || 0);
      // 旧 IMAP 行的 gmail_msgid 即 API id，天然对齐；再按 Message-ID 兜底一行
      await gmailApiFullSync(gmail, accountId, username, folder, st, haveMap, ()=> ++counter);
      try{
        const prof = await gmailCall(()=> gmail.users.getProfile({ userId:'me' }), st, 'getProfile');
        const newHid = (prof.data && prof.data.historyId) || '';
        await writeSyncHistoryId(accountId, folder, newHid, true);
        st.historyId = newHid;
      }catch{}
      await rebuildGmailThreads(accountId, folder);
    }
    // 无论 incremental 还是 full：正文与附件并行回填，互不阻塞
    await refreshStoreCounts();
    if(!st.cancelled){
      st.phase = 'body+att'
      st.attDone = st.attDone||0; st.attFails = st.attFails||0
      const jobs = []
      if((st.pendingBodies||0) > 0){
        jobs.push(gmailApiBackfillBodies(gmail, accountId, username, folder, st, { skipInterleavedAtt:true }))
      }
      jobs.push(gmailApiBackfillAttachments(gmail, accountId, username, folder, st))
      const results = await Promise.allSettled(jobs)
      for(const r of results){
        if(r.status === 'rejected'){
          const msg = String(r.reason?.message||r.reason||'')
          if(msg.includes('cancelled')) throw new Error('cancelled')
          // 正文停滞不应拖死附件；附件失败也不应清掉正文进度
          if(!st.error) st.error = msg.slice(0,200)
        }
      }
      if(st.cancelled) throw new Error('cancelled')
    }
    st.phase = 'done';
    await refreshStoreCounts();
  }catch(e){
    st.error = String(e.message||e).slice(0,200);
    st.phase = 'error';
    throw e;
  }finally{
    st.running = false;
    await refreshStoreCounts();
  }
  return st;
}
app.post('/email/gsync/:accountId', auth, wrap(async (req,res)=>{
  const { accountId } = req.params;
  const acc = await loadMailAccount(accountId, req.user);
  if(!acc) return res.status(404).json({ error:'账号不存在' });
  const cur = ingestJobs.get(accountId);
  if(cur && cur.running) return res.status(409).json({ error:'已有任务进行中', job: sanitizeJob(cur) });
  const mode = ['full','incremental','auto'].includes(req.body?.mode) ? req.body.mode : 'auto';
  runGmailApiSync(accountId, req.user, { mode }).catch(()=>{});
  // 稍等片刻让任务启动，回最新状态
  await new Promise(r=>setTimeout(r, 800));
  res.json({ ok:true, mode, job: sanitizeJob(ingestJobs.get(accountId)) });
}));

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
                await logoutSafe(wc)
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
  }finally{ lock.release(); await logoutSafe(client) }
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
// 登出硬超时：socket 被黑洞时 LOGOUT 永远等不到 BYE，必须掐掉否则 worker 卡死在收尾
async function logoutSafe(client, ms = 10000){
  if(!client) return
  try{
    await Promise.race([client.logout().catch(()=>{}), new Promise(r=>setTimeout(r, ms))])
  }catch{}
  try{ if(typeof client.destroy === 'function') client.destroy() }catch{}
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
            `INSERT INTO mail_messages (account_id, folder, uid, message_id, gmail_msgid, gmail_threadid, subject, from_addr, from_name, to_addr, msg_date, is_read, has_attachment, body_text, body_html, body_cached, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE is_read=VALUES(is_read), has_attachment=VALUES(has_attachment),
               body_text=IF(body_cached=0 AND VALUES(body_cached)=1, VALUES(body_text), body_text),
               body_html=IF(body_cached=0 AND VALUES(body_cached)=1, VALUES(body_html), body_html),
               body_cached=IF(VALUES(body_cached)=1,1,body_cached), updated_at=VALUES(updated_at)`;
          const saveRow = async (row) => {
            const r = await pool.query(UPSERT_SQL,
              [accountId, folder, row.uid, row.message_id, row.gmail_msgid, row.gmail_threadid, row.subject, row.from_addr, row.from_name, row.to_addr, row.msg_date, row.is_read, row.has_attachment, row.body_text, row.body_html ?? null, row.body_cached, sqlNow()]);
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
                    body_html: null,
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
          // 细水长流：单连接、倒序（新邮件优先）、批间隔15秒，避免触发 Gmail 限速
          const BODY_CONCURRENCY = 1
          const BODY_BATCH_GAP_MS = 15000
          const processBodyBatch = async (wc, batch) => {
            st.batch = `${batch[0]}-${batch[batch.length-1]}@${new Date().toISOString().slice(11,19)}`
            const doneBefore = st.done || 0
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
              await pool.query(`UPDATE mail_messages SET body_text='[超大邮件（>15MB），正文未入库，请在线查看]', body_cached=2, updated_at=? WHERE account_id=? AND folder=? AND uid=?`,
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
                      const bodyHtml = parsed.html ? String(parsed.html).slice(0, 800000) : null
                      const atts = parsed.attachments || []
                      const att = atts.length ? 1 : 0
                      await pool.query('UPDATE mail_messages SET body_text=?, body_html=?, body_cached=1, has_attachment=GREATEST(has_attachment, ?), is_read=?, updated_at=? WHERE account_id=? AND folder=? AND uid=?',
                        [bodyText, bodyHtml, att, ((msg.flags||new Set()).has('\\Seen')?1:0), sqlNow(), accountId, folder, msg.uid])
                      // 回复检测：收件方向+实质内容 → 序列转手动+🔔
                      try{
                        const fromAddr = String(msg.envelope?.from?.[0]?.address || parsed?.from?.value?.[0]?.address || '').toLowerCase()
                        if(fromAddr && !fromAddr.includes(acc.email.toLowerCase())){
                          await seqReplyCheck(accountId, username, msg.uid, msg.envelope, parsed, msg.internalDate || msg.envelope?.date)
                        }
                      }catch{}
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
                      st.realBodies = (st.realBodies || 0) + 1
                    }catch{}
                  }
                })(),
                new Promise((_, rej)=>setTimeout(()=>rej(new Error('body-batch-timeout')), 4*60*1000)),
              ])
            }catch(e){ console.log('[ingest] body batch skip:', String(e.message||e).slice(0,80)) }
            // 本批零进展则记一次失败；连续失败3次→整批占位跳过（点开邮件时在线现取），避免原地打转
            // 前提：本任务已有真实正文产出，否则说明是整体限流，只报错不隔离（占位会掩盖真实进度）
            if((st.done || 0) === doneBefore && batch.length && (st.realBodies || 0) > 0){
              const key = `${batch[0]}-${batch[batch.length-1]}`
              st.chunkFails = st.chunkFails || {}
              st.chunkFails[key] = (st.chunkFails[key] || 0) + 1
              if(st.chunkFails[key] >= 3){
                console.log(`[ingest] quarantine chunk ${key}`)
                for(let i=0;i<batch.length;i+=200){
                  const ch = batch.slice(i,i+200)
                  await pool.query(
                    `UPDATE mail_messages SET body_text='[多次拉取超时已跳过，点开邮件时在线查看]', body_cached=2, updated_at=? WHERE account_id=? AND folder=? AND body_cached=0 AND uid IN (${ch.map(()=> '?').join(',')})`,
                    [sqlNow(), accountId, folder, ...ch]).catch(()=>{})
                }
                delete st.chunkFails[key]
              }
            }
          }
          while(true){
            if(st.cancelled) throw new Error('cancelled')
            const [todoRows] = await pool.query('SELECT uid FROM mail_messages WHERE account_id=? AND folder=? AND body_cached=0 ORDER BY uid DESC LIMIT 600',[accountId, folder]).catch(()=> [[]])
            const todo = (todoRows||[]).map(r=>Number(r.uid)).filter(Boolean)
            if(!todo.length) break
            const roundRealBefore = st.realBodies || 0
            const wcFailed = []
            // 切片分给 N 个 worker，各自独立连接并行拉取
            const slices = Array.from({ length: BODY_CONCURRENCY }, ()=> [])
            todo.forEach((u, idx)=> slices[idx % BODY_CONCURRENCY].push(u))
            const workers = slices.filter(s=> s.length).map(async (slice, wi)=>{
              if(st.cancelled) throw new Error('cancelled')
              if(wi > 0) await new Promise(r=>setTimeout(r, wi*10000)) // 错峰建连，避免并发握手被掐
              if(st.cancelled) throw new Error('cancelled')
              const wc = makeImapClient({ host:acc.imap_host, port:acc.imap_port, user:acc.email, pass, socketTimeout:180000 })
              try{
                await imapConnect(wc, 30000)
              }catch(e){
                // 连不上：记一笔直接返回，避免空转忙循环打爆 Gmail
                wcFailed.push(String(e.message||e).slice(0,60))
                try{ await logoutSafe(wc) }catch{}
                return
              }
              try{
                for(let i=0;i<slice.length;i+=25){
                  if(st.cancelled) throw new Error('cancelled')
                  await processBodyBatch(wc, slice.slice(i,i+25))
                  await new Promise(r=>setTimeout(r, BODY_BATCH_GAP_MS))
                }
              }finally{
                await logoutSafe(wc)
              }
            })
            const results = await Promise.allSettled(workers)
            if(wcFailed.length && wcFailed.length >= slices.filter(s=> s.length).length){
              throw new Error('imap-unavailable: ' + (wcFailed[0]||''))
            }
            // 整轮零真实产出则记一次停滞；连续3轮停滞→显式报错结束（ visible，可重试），而不是无限空转
            if((st.realBodies || 0) === roundRealBefore){
              st.stallRounds = (st.stallRounds || 0) + 1
              if(st.stallRounds >= 3) throw new Error('no-progress: continuous fetch failures, likely throttled')
            } else {
              st.stallRounds = 0
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
      }finally{ await logoutSafe(client) }
    }
  }catch(e){ st.error = String(e.message||e).slice(0,200) }
  finally{ st.running = false }
}

// 双轨路由：Gmail 且已 OAuth → Gmail API 引擎；其他（QQ/网易/163/Outlook）→ IMAP 引擎
async function usesGmailApi(acc){
  if(!acc || String(acc.provider||'').toLowerCase() !== 'gmail') return false
  if(!dbReady) return false
  try{
    const [rows] = await pool.query('SELECT 1 FROM gmail_oauth WHERE account_id=?',[acc.id])
    return rows.length > 0
  }catch{ return false }
}
// 启动入库任务：POST /email/ingest/:accountId {mode:'full'|'incremental', folders?}
app.post('/email/ingest/:accountId', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL（服务端邮件库未就绪）' })
  const { accountId } = req.params
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const cur = ingestJobs.get(accountId)
  if(cur && cur.running) return res.status(409).json({ error:'入库任务进行中', job:cur })
  if(await usesGmailApi(acc)){
    const mode = ['full','incremental','auto'].includes(req.body?.mode) ? req.body.mode : 'auto'
    runGmailApiSync(accountId, req.user, { mode }).catch(()=>{})
    await new Promise(r=>setTimeout(r, 800))
    return res.json({ ok:true, mode, engine:'gmail-api', job: sanitizeJob(ingestJobs.get(accountId)) })
  }
  const mode = req.body?.mode === 'incremental' ? 'incremental' : 'full'
  const folders = Array.isArray(req.body?.folders) && req.body.folders.length ? req.body.folders.map(String) : undefined
  runMailIngest(accountId, req.user, { mode, folders }).catch(()=>{})
  res.json({ ok:true, mode, engine:'imap', job: sanitizeJob(ingestJobs.get(accountId)) })
}))

// 入库进度：GET /email/ingest-status/:accountId（前端 2s 轮询，实时数量）
app.get('/email/ingest-status/:accountId', auth, wrap(async (req,res)=>{
  const raw = ingestJobs.get(req.params.accountId) || null
  // 运行中且是 Gmail 引擎时，实时刷库计数（轻量单行 COUNT）
  if(raw && raw.running && typeof raw.refreshStoreCounts === 'function'){
    try{ await raw.refreshStoreCounts() }catch{}
  }
  res.json({ job: raw ? sanitizeJob(raw) : null })
}))

// 取消入库任务：POST /email/ingest-stop/:accountId
app.post('/email/ingest-stop/:accountId', auth, wrap(async (req,res)=>{
  const job = ingestJobs.get(req.params.accountId)
  if(job) job.cancelled = true
  res.json({ ok:true })
}))


// 监听暂停/恢复：POST /email/watch-pause {pause:true|false}
// 入库优先时暂停所有 watcher（把 IMAP 连接让给入库）；入库完成后恢复
app.post('/email/watch-pause', auth, wrap(async (req,res)=>{
  const pause = !!req.body?.pause
  if(pause){
    for(const id of [...mailWatchers.keys()]) stopMailWatcher(id)
    res.json({ ok:true, paused:true, watchers: 0 })
  } else {
    await startAllMailWatchers()
    res.json({ ok:true, paused:false, watchers: mailWatchers.size })
  }
}))
app.get('/email/watch-pause', auth, wrap(async (req,res)=>{
  res.json({ paused: mailWatchers.size === 0, watchers: mailWatchers.size })
}))

// 入库状态总览：GET /email/db-status/:accountId（先查差多少，再决定同步；light=1 跳过 IMAP 探测，零连接）
// OAuth Gmail 账号：永不探 IMAP，用 historyId + 库计数
app.get('/email/db-status/:accountId', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId } = req.params
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const light = String(req.query.light||'') === '1'
  const oauthMode = await usesGmailApi(acc)
  const folders = Array.isArray(req.query.folders) ? req.query.folders : (req.query.folder ? [String(req.query.folder)] : ['[Gmail]/All Mail'])
  const out = []
  const pass = oauthMode ? '' : decAuth(acc.auth_enc)
  for(const folder of folders){
    const [srows] = await pool.query('SELECT * FROM mail_sync_state WHERE account_id=? AND folder=?',[accountId, folder])
    // body_cached: 1=真实正文, 2=占位；只把 1 计入 bodyCount
    const [crows] = await pool.query(
      `SELECT COUNT(*) AS c, MAX(uid) AS maxUid,
         SUM(CASE WHEN body_cached=1 THEN 1 ELSE 0 END) AS bodies,
         SUM(CASE WHEN body_cached=2 THEN 1 ELSE 0 END) AS placeholders,
         SUM(CASE WHEN body_cached=0 THEN 1 ELSE 0 END) AS pendingBodies
       FROM mail_messages WHERE account_id=? AND folder=?`,[accountId, folder])
    const dbCount = Number(crows[0]?.c)||0
    const bodyCount = Number(crows[0]?.bodies)||0
    const placeholderCount = Number(crows[0]?.placeholders)||0
    const pendingBodies = Number(crows[0]?.pendingBodies)||0
    const cachedUidnext = Number(srows[0]?.uidnext)||0
    const cachedLastUid = Number(srows[0]?.last_uid ?? crows[0]?.maxUid ?? 0)||0
    const historyId = String(srows[0]?.history_id || '')
    let imapTotal = 0, uidnext = 0, uidvalidity = 0, live = true
    if(oauthMode){
      // Gmail API 模式：不碰 IMAP，pending 按待补正文 + 无 total 语义
      live = true
      imapTotal = dbCount
      uidnext = cachedUidnext
      uidvalidity = 0
    } else if(light){
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
    }
    if(!live && !oauthMode){ imapTotal = cachedUidnext || cachedLastUid || dbCount; uidnext = cachedUidnext; uidvalidity = Number(srows[0]?.uidvalidity)||0 }
    const lastUid = cachedLastUid
    const job = ingestJobs.get(accountId) || null
    out.push({
      folder, dbCount, bodyCount, placeholderCount, pendingBodies,
      imapTotal, lastUid, uidnext, uidvalidity, live,
      engine: oauthMode ? 'gmail-api' : 'imap',
      historyIdReady: !!historyId,
      fullSyncDone: oauthMode ? !!historyId : !!srows[0]?.full_sync_done,
      lastSyncAt: srows[0]?.last_sync_at || null,
      pending: oauthMode ? pendingBodies : Math.max(0, (uidnext || imapTotal) - lastUid),
      job: job ? sanitizeJob(job) : null
    })
  }
  res.json({ folders: out })
}))

// 库内检索：邮箱类查询走 LIKE 精确匹配（ngram 会把地址拆词导致误命中）；普通词先短语后全文
async function searchMailRows(pool, accountIdOrNull, q, cols, limit){
  const like = `%${q.replace(/[%_\\]/g, m=>'\\'+m)}%`
  const accFilter = accountIdOrNull ? 'account_id=? AND ' : ''
  const accParams = accountIdOrNull ? [accountIdOrNull] : []
  // ① 含 @ 或像邮箱：优先地址精确 LIKE
  if(q.includes('@') || /^[a-z0-9._%+-]+@/i.test(q)){
    const [r] = await pool.query(
      `SELECT ${cols}, body_text, 100 AS relevance FROM mail_messages
       WHERE ${accFilter}(from_addr LIKE ? ESCAPE '\\\\' OR to_addr LIKE ? ESCAPE '\\\\' OR message_id LIKE ? ESCAPE '\\\\')
       ORDER BY msg_date DESC LIMIT ?`,
      [...accParams, like, like, like, limit])
    if(r.length) return { rows:r, mode:'email-like' }
    // 地址没中再搜主题/正文
    const [r2] = await pool.query(
      `SELECT ${cols}, body_text, 10 AS relevance FROM mail_messages
       WHERE ${accFilter}(subject LIKE ? ESCAPE '\\\\' OR body_text LIKE ? ESCAPE '\\\\')
       ORDER BY msg_date DESC LIMIT ?`,
      [...accParams, like, like, limit])
    return { rows:r2, mode:'email-like-body' }
  }
  // ② 普通关键词：BOOLEAN 短语（高精度）
  const phrase = `"${q.replace(/"/g,' ')}"`
  try{
    const [r] = await pool.query(
      `SELECT ${cols}, body_text, MATCH(subject, from_addr, to_addr, body_text) AGAINST (? IN BOOLEAN MODE) AS relevance
       FROM mail_messages WHERE ${accFilter}MATCH(subject, from_addr, to_addr, body_text) AGAINST (? IN BOOLEAN MODE)
       ORDER BY relevance DESC, msg_date DESC LIMIT ?`,
      [...accParams, phrase, phrase, limit])
    if(r.length) return { rows:r, mode:'boolean' }
  }catch{}
  // ③ 兜底：LIKE
  const [r3] = await pool.query(
    `SELECT ${cols}, body_text FROM mail_messages
     WHERE ${accFilter}(subject LIKE ? ESCAPE '\\\\' OR from_addr LIKE ? ESCAPE '\\\\' OR to_addr LIKE ? ESCAPE '\\\\' OR body_text LIKE ? ESCAPE '\\\\')
     ORDER BY msg_date DESC LIMIT ?`,
    [...accParams, like, like, like, like, limit])
  return { rows:r3, mode:'like' }
}
// 库内全文搜索：GET /email/db-search/:accountId?q=&limit=50
app.get('/email/db-search/:accountId', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId } = req.params
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const q = String(req.query.q || '').trim().slice(0, 100)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
  const cols = 'account_id, folder, uid, message_id, gmail_msgid, subject, from_addr, from_name, to_addr, msg_date, is_read, has_attachment, body_cached, CHAR_LENGTH(body_text) AS body_len, LEFT(body_text, 600) AS snippet, body_html'
  if(!q){
    const [rows] = await pool.query(`SELECT ${cols}, body_text FROM mail_messages WHERE account_id=? ORDER BY msg_date DESC LIMIT ?`,[accountId, limit])
    return res.json({ emails: rows, total: rows.length, mode:'latest' })
  }
  const { rows, mode } = await searchMailRows(pool, accountId, q, cols, limit)
  res.json({ emails: rows, total: rows.length, mode })
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
  const mailFolder = String(req.query.folder || '')
  const [rows] = mailFolder
    ? await pool.query(
        `SELECT account_id, folder, uid, message_id, gmail_msgid, subject, from_addr, from_name, to_addr, msg_date, is_read, has_attachment, body_text, body_html, body_cached
         FROM mail_messages WHERE account_id=? AND uid=? AND folder=? LIMIT 1`,[accountId, uidNum, mailFolder])
    : await pool.query(
        `SELECT account_id, folder, uid, message_id, gmail_msgid, subject, from_addr, from_name, to_addr, msg_date, is_read, has_attachment, body_text, body_html, body_cached
         FROM mail_messages WHERE account_id=? AND uid=? ORDER BY body_cached DESC, updated_at DESC LIMIT 1`,[accountId, uidNum])
  if(!rows.length) return res.status(404).json({ error:'库中无此邮件' })
  const e = rows[0]
  res.json({
    subject: e.subject, from: e.from_name ? `${e.from_name} <${e.from_addr}>` : e.from_addr,
    to: e.to_addr, date: e.msg_date, isRead: !!e.is_read, hasAttachment: !!e.has_attachment,
    text: e.body_text || '', html: e.body_html || '', cached: e.body_cached === 1,
    folder: e.folder, uid: Number(e.uid), gmailMsgId: e.gmail_msgid || '',
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
      await logoutSafe(client)
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
  // OAuth 已接管的 Gmail 账号跳过 IMAP IDLE（节流+避重复）
  loadMailAccount(accountId, username).then(async (acc)=>{
    try{ if(acc && await usesGmailApi(acc)){ stopMailWatcher(accountId); console.log(`[watch] 跳过 ${accountId}（Gmail API 已接管）`); return } }catch{}
    mailWatchLoop(accountId, username).catch(()=>{})
  }).catch(()=>{ mailWatchLoop(accountId, username).catch(()=>{}) })
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

// Gmail API 账号自动增量：OAuth 账号跳过 IDLE，用定时轮询 history.list
// 间隔默认 8 分钟；有 running job 则跳过
const GMAIL_AUTO_INTERVAL_MS = Number(process.env.GMAIL_AUTO_SYNC_MS) || 8 * 60 * 1000
let gmailAutoTimer = null
async function gmailAutoIncrementalTick(){
  if(!dbReady) return
  try{
    const [rows] = await pool.query(
      `SELECT ea.id, ea.username FROM email_accounts ea
       INNER JOIN gmail_oauth go ON go.account_id = ea.id`)
    for(const r of (rows||[])){
      const cur = ingestJobs.get(r.id)
      if(cur && cur.running) continue
      try{
        // 每轮最多 2 个账号，避免打爆配额
        runGmailApiSync(r.id, r.username, { mode:'incremental' }).catch(()=>{})
        await new Promise(res=>setTimeout(res, 2000))
      }catch{}
    }
  }catch(e){ console.log('[gmail-auto]', String(e.message||e).slice(0,80)) }
}
function startGmailAutoSync(){
  if(gmailAutoTimer) return
  gmailAutoTimer = setInterval(()=>{ gmailAutoIncrementalTick().catch(()=>{}) }, GMAIL_AUTO_INTERVAL_MS)
  // 启动后 20s 先跑一轮，方便开机自动续
  setTimeout(()=>{ gmailAutoIncrementalTick().catch(()=>{}) }, 20000)
  console.log(`[gmail-auto] 已启动，间隔 ${Math.round(GMAIL_AUTO_INTERVAL_MS/1000)}s`)
}
function stopGmailAutoSync(){
  if(gmailAutoTimer){ clearInterval(gmailAutoTimer); gmailAutoTimer = null }
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

// 美国节假日：GET /email/holidays?year=2026（Nager.Date 联网拉取，24h缓存，断网用内置兜底）
const US_HOLIDAY_FALLBACK = [
  ['01-01', 'New Year'], ['01-19', 'MLK Day'], ['02-16', "Presidents' Day"], ['05-25', 'Memorial Day'],
  ['06-19', 'Juneteenth'], ['07-04', 'Independence Day'], ['09-07', 'Labor Day'], ['10-12', 'Columbus Day'],
  ['11-11', 'Veterans Day'], ['11-26', 'Thanksgiving'], ['12-25', 'Christmas'],
]
app.get('/email/holidays', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const year = Math.min(2030, Math.max(2020, Number(req.query.year) || new Date().getFullYear()))
  let rows = []
  try{
    const [r] = await pool.query('SELECT date, name FROM us_holidays WHERE YEAR(date)=? ORDER BY date',[year])
    rows = r
  }catch{}
  const fresh = rows.length > 5
  if(!fresh){
    try{
      const up = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/US`, { signal: AbortSignal.timeout(15000) })
      if(up.ok){
        const list = await up.json()
        const now = sqlNow()
        for(const h of list){
          if(!h.date || !h.name) continue
          await pool.query(`INSERT INTO us_holidays (date, name, fetched_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), fetched_at=VALUES(fetched_at)`,
            [h.date, String(h.localName || h.name).slice(0,256), now]).catch(()=>{})
        }
        const [r2] = await pool.query('SELECT date, name FROM us_holidays WHERE YEAR(date)=? ORDER BY date',[year])
        rows = r2
      }
    }catch(e){ console.log('[holidays] fetch skip:', String(e.message||e).slice(0,80)) }
  }
  if(!rows.length){
    rows = US_HOLIDAY_FALLBACK.map(([md, name])=>({ date: `${year}-${md}`, name: `${name}（内置）` }))
  }
  const fmt = (d) => { try{ return new Date(d).toISOString().slice(0,10) }catch{ return String(d).slice(0,10) } };
  res.json({ year, holidays: rows.map(h=>({ date: fmt(h.date), name: h.name })), source: fresh ? 'cache' : 'live' })
}))

// 复购激活池：GET /email/repurchase-pool?silentDays=90
// stage=won 且最后一次往来（含收发）超过 silentDays 天的客户，按静默天数倒序
app.get('/email/repurchase-pool', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const silentDays = Math.min(3650, Math.max(1, Number(req.query.silentDays) || 90))
  const cutoff = new Date(Date.now() - silentDays*86400000)
  const [crows] = await pool.query(`SELECT row_id, data FROM data WHERE username=? AND table_name='customers' AND deleted=0`,[req.user])
  const [mrows] = await pool.query(`SELECT from_addr, to_addr, MAX(msg_date) AS lastd, COUNT(*) AS c FROM mail_messages WHERE account_id IN (SELECT id FROM email_accounts WHERE username=?) GROUP BY from_addr, to_addr`,[req.user]).catch(()=> [[]])
  const lastByEmail = new Map()
  for(const m of (mrows||[])){
    for(const a of [String(m.from_addr||'').toLowerCase(), ...String(m.to_addr||'').split(',').map(s=>s.trim().toLowerCase())]){
      if(!a || !a.includes('@')) continue
      const t = new Date(m.lastd).getTime()
      if(!lastByEmail.has(a) || t > lastByEmail.get(a).t) lastByEmail.set(a, { t, c: Number(m.c)||0 })
    }
  }
  const out = []
  for(const r of crows){
    let d = null
    try{ d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data }catch{ continue }
    if(!d || d.stage !== 'won') continue
    const mails = [(d.email||'').toLowerCase(), ...((d.extraEmails||[]).map(e=>String(e).toLowerCase()))].filter(Boolean)
    let best = null
    for(const a of mails){ const hit = lastByEmail.get(a); if(hit && (!best || hit.t > best.t)) best = hit }
    const lastT = best ? best.t : null
    if(lastT && lastT > cutoff.getTime()) continue // 最近还在联系，不算沉睡
    out.push({ customerId: r.row_id, email: d.email, title: d.title || d.contactName, company: d.company || '',
      level: d.level, isKey: !!d.isKey, repurchaseCount: d.repurchaseCount || 0,
      products: d.portrait?.products || [], lastContact: lastT ? new Date(lastT).toISOString().slice(0,10) : null,
      silentDays: lastT ? Math.floor((Date.now()-lastT)/86400000) : 9999, mailCount: best?.c || 0 })
  }
  out.sort((a,b)=> b.silentDays - a.silentDays)
  res.json({ silentDays, total: out.length, pool: out.slice(0, 500) })
}))

// 标已读回写 Gmail：POST /email/mark-read {accountId, uid, read, folder?}
// OAuth 账号走 Gmail API（messages.modify），其他走 IMAP STORE
app.post('/email/mark-read', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId, uid, read = true, folder = '[Gmail]/All Mail' } = req.body || {}
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const uidNum = Number(uid)
  if(!isFinite(uidNum)) return res.status(400).json({ error:'无效UID' })
  if(await usesGmailApi(acc)){
    try{
      const { google } = await import('googleapis');
      const o = await buildOAuthClient(req, accountId);
      const gmail = google.gmail({ version:'v1', auth:o });
      const [mrows] = await pool.query('SELECT gmail_msgid FROM mail_messages WHERE account_id=? AND uid=?',[accountId, uidNum]).catch(()=> [[]]);
      const gid = mrows.length ? String(mrows[0].gmail_msgid || '') : '';
      if(!gid) throw new Error('本地无此邮件的 Gmail ID');
      const st0 = { apiCalls:0 };
      await gmailCall(()=> gmail.users.messages.modify({ userId:'me', id: gid,
        requestBody: read ? { removeLabelIds:['UNREAD'] } : { addLabelIds:['UNREAD'] } }), st0, 'messages.modify');
    }catch(e){
      return res.status(502).json({ error:'Gmail API 标已读失败：' + String(e.message||e).slice(0,120) })
    }
  } else {
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
  }
  // 优先按 (account, folder, uid) 精确回写；无 folder 时兜底只按 uid
  if(folder && folder !== '[Gmail]/All Mail'){
    await pool.query('UPDATE mail_messages SET is_read=?, updated_at=? WHERE account_id=? AND folder=? AND uid=?',[read?1:0, sqlNow(), accountId, folder, uidNum])
  } else {
    await pool.query('UPDATE mail_messages SET is_read=?, updated_at=? WHERE account_id=? AND uid=?',[read?1:0, sqlNow(), accountId, uidNum])
  }
  res.json({ ok:true })
}))

// 未读数：GET /email/unread-count/:accountId?folder=
app.get('/email/unread-count/:accountId', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId } = req.params
  const folder = String(req.query.folder || '')
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const [rows] = folder
    ? await pool.query(`SELECT COUNT(*) AS c FROM mail_messages WHERE account_id=? AND is_read=0 AND folder=?`,[accountId, folder])
    : await pool.query(`SELECT COUNT(*) AS c FROM mail_messages WHERE account_id=? AND is_read=0`,[accountId])
  res.json({ unread: Number(rows[0]?.c)||0 })
}))

// 多账号库内搜索：GET /email/db-search-all?q=&limit=
app.get('/email/db-search-all', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const q = String(req.query.q || '').trim().slice(0, 100)
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
  const cols = 'account_id, folder, uid, message_id, gmail_msgid, subject, from_addr, from_name, to_addr, msg_date, is_read, has_attachment, body_cached, CHAR_LENGTH(body_text) AS body_len, LEFT(body_text, 600) AS snippet, body_html'
  if(!q){
    const [r] = await pool.query(`SELECT ${cols}, body_text FROM mail_messages WHERE account_id IN (SELECT id FROM email_accounts WHERE username=?) ORDER BY msg_date DESC LIMIT ?`,[req.user, limit])
    return res.json({ emails: r, total: r.length, mode:'latest' })
  }
  // 复用精确检索：把范围限制在当前用户名下账号
  const like = `%${q.replace(/[%_\\]/g, m=>'\\'+m)}%`
  const scope = 'account_id IN (SELECT id FROM email_accounts WHERE username=?) '
  let rows = [], mode = 'like'
  if(q.includes('@')){
    const [r] = await pool.query(
      `SELECT ${cols}, body_text, 100 AS relevance FROM mail_messages
       WHERE ${scope}AND (from_addr LIKE ? ESCAPE '\\\\' OR to_addr LIKE ? ESCAPE '\\\\' OR message_id LIKE ? ESCAPE '\\\\')
       ORDER BY msg_date DESC LIMIT ?`,[req.user, like, like, like, limit])
    rows = r; mode = 'email-like'
    if(!rows.length){
      const [r2] = await pool.query(
        `SELECT ${cols}, body_text FROM mail_messages
         WHERE ${scope}AND (subject LIKE ? ESCAPE '\\\\' OR body_text LIKE ? ESCAPE '\\\\')
         ORDER BY msg_date DESC LIMIT ?`,[req.user, like, like, limit])
      rows = r2; mode = 'email-like-body'
    }
  } else {
    const phrase = `"${q.replace(/"/g,' ')}"`
    try{
      const [r] = await pool.query(
        `SELECT ${cols}, body_text, MATCH(subject, from_addr, to_addr, body_text) AGAINST (? IN BOOLEAN MODE) AS relevance
         FROM mail_messages WHERE ${scope}AND MATCH(subject, from_addr, to_addr, body_text) AGAINST (? IN BOOLEAN MODE)
         ORDER BY relevance DESC, msg_date DESC LIMIT ?`,[req.user, phrase, phrase, limit])
      if(r.length){ rows = r; mode = 'boolean' }
    }catch{}
    if(!rows.length){
      const [r] = await pool.query(
        `SELECT ${cols}, body_text FROM mail_messages
         WHERE ${scope}AND (subject LIKE ? ESCAPE '\\\\' OR from_addr LIKE ? ESCAPE '\\\\' OR to_addr LIKE ? ESCAPE '\\\\' OR body_text LIKE ? ESCAPE '\\\\')
         ORDER BY msg_date DESC LIMIT ?`,[req.user, like, like, like, like, limit])
      rows = r; mode = 'like'
    }
  }
  res.json({ emails: rows, total: rows.length, mode })
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
        const bodyText = String(parsed.text || parsed.html || '').slice(0, 500000)
        const bodyHtml = parsed.html ? String(parsed.html).slice(0, 800000) : null
        const hasAtt = (parsed.attachments||[]).length > 0
        // 回写服务端库，下次打开免再拉 IMAP
        if(dbReady){
          try{
            await pool.query(
              `INSERT INTO mail_messages (account_id, folder, uid, message_id, gmail_msgid, gmail_threadid, subject, from_addr, from_name, to_addr, msg_date, is_read, has_attachment, body_text, body_html, body_cached, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON DUPLICATE KEY UPDATE body_text=VALUES(body_text), body_html=VALUES(body_html), body_cached=1, has_attachment=GREATEST(has_attachment, VALUES(has_attachment)), updated_at=VALUES(updated_at)`,
              [accountId, folder, uidNum, String(parsed.messageId||'').slice(0,512), String(parsed.headers?.get('x-gm-msgid')||'').slice(0,64), String(parsed.headers?.get('x-gm-thrid')||'').slice(0,64),
               String(parsed.subject||'(无主题)').slice(0,1024), String(parsed.from?.value?.[0]?.address||'').slice(0,512), String(parsed.from?.value?.[0]?.name||'').slice(0,256),
               String(parsed.to?.text||'').slice(0,1024), sqlDate(parsed.date), 1, hasAtt?1:0, bodyText, bodyHtml, 1, sqlNow()])
          }catch{}
        }
        await client.logout().catch(()=>{})
        res.json({
          id: `${accountId}-${uid}`,
          from: parsed.from?.text || '',
          to: parsed.to?.text || '',
          subject: parsed.subject || '',
          text: bodyText,
          html: parsed.html || '',
          date: parsed.date?.toISOString() || '',
          hasAttachment: hasAtt,
          folder: folder.toLowerCase(),
          uid: uidNum,
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

// 附件列表：GET /email/attachments/:accountId/:uid
app.get('/email/attachments/:accountId/:uid', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId, uid } = req.params
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const uidNum = Number(uid)
  if(!isFinite(uidNum)) return res.status(400).json({ error:'无效UID' })
  const [rows] = await pool.query(
    `SELECT filename, size, mime FROM mail_attachments WHERE account_id=? AND uid=? ORDER BY filename LIMIT 50`,
    [accountId, uidNum])
  res.json({ attachments: rows.map(r=>({
    filename: r.filename, size: Number(r.size)||0, mime: r.mime||'',
    url: `/email/attachment/${accountId}/${uidNum}/${encodeURIComponent(r.filename)}`
  })) })
}))

// 附件库搜索：GET /email/attachment-search?q=&type=image|all&limit=
app.get('/email/attachment-search', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const q = String(req.query.q||'').trim().slice(0,100)
  const type = String(req.query.type||'image') === 'all' ? 'all' : 'image'
  const limit = Math.min(200, Math.max(1, Number(req.query.limit)||60))
  const like = `%${q.replace(/[%_\\]/g, m=>'\\'+m)}%`
  const imgCond = type==='image'
    ? `AND (LOWER(ma.mime) LIKE 'image/%' OR LOWER(ma.filename) REGEXP '\\\\.(png|jpe?g|gif|webp|bmp)$')`
    : ''
  const nameCond = q ? `AND ma.filename LIKE ? ESCAPE '\\\\'` : ''
  const params = [req.user]
  if(q) params.push(like)
  params.push(limit)
  const [rows] = await pool.query(
    `SELECT ma.account_id, ma.uid, ma.filename, ma.size, ma.mime, ma.path,
            m.subject, m.from_addr, m.from_name, m.msg_date, m.folder
     FROM mail_attachments ma
     JOIN mail_messages m ON m.account_id=ma.account_id AND m.folder=ma.folder AND m.uid=ma.uid
     WHERE ma.account_id IN (SELECT id FROM email_accounts WHERE username=?)
       AND (ma.path IS NOT NULL AND ma.path<>'')
       ${imgCond} ${nameCond}
     ORDER BY m.msg_date DESC
     LIMIT ?`, params)
  res.json({
    total: rows.length,
    items: rows.map(r=>({
      accountId: r.account_id, uid: Number(r.uid), filename: r.filename,
      size: Number(r.size)||0, mime: r.mime||'',
      subject: r.subject||'', from: r.from_name ? `${r.from_name} <${r.from_addr}>` : (r.from_addr||''),
      date: r.msg_date, folder: r.folder,
      hasFile: !!(r.path && String(r.path).length)
    }))
  })
}))

// 附件下载：GET /email/attachment/:accountId/:uid/:filename
app.get('/email/attachment/:accountId/:uid/:filename', wrap(async (req,res)=>{
  // 支持 header 或 ?token=（方便 <a href> 直下）
  const qtok = String(req.query.token||'')
  if(qtok){
    req.headers['x-evan-token'] = qtok
  }
  await new Promise((resolve)=> auth(req,res,resolve))
  if(res.headersSent) return
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId, uid, filename } = req.params
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const uidNum = Number(uid)
  if(!isFinite(uidNum)) return res.status(400).json({ error:'无效UID' })
  const fname = decodeURIComponent(filename)
  // 防路径穿越：附件名只允许来自库中记录
  const [r2] = await pool.query(
    `SELECT path, mime FROM mail_attachments WHERE account_id=? AND uid=? AND filename=? LIMIT 1`,
    [accountId, uidNum, fname])
  const row = r2[0]
  if(row?.path){
    const resolved = path.resolve(row.path)
    if(!resolved.startsWith(ATTACH_BASE + path.sep) && resolved !== ATTACH_BASE){
      return res.status(403).json({ error:'非法路径' })
    }
  }
  if(!row || !row.path || !fs.existsSync(row.path)) return res.status(404).json({ error:'附件不存在' })
  res.setHeader('Content-Type', row.mime || 'application/octet-stream')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`)
  fs.createReadStream(row.path).pipe(res)
}))

// Gmail 草稿 APPEND：POST /email/drafts/:id/append-gmail {accountId}
app.post('/email/drafts/:id/append-gmail', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const accountId = req.body?.accountId
  if(!accountId) return res.status(400).json({ error:'需要 accountId' })
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const [drows] = await pool.query('SELECT * FROM mail_drafts WHERE id=? AND username=?',[req.params.id, req.user])
  if(!drows.length) return res.status(404).json({ error:'草稿不存在' })
  const d = drows[0]
  const pass = decAuth(acc.auth_enc)
  const client = makeImapClient({ host:acc.imap_host, port:acc.imap_port, user:acc.email, pass, socketTimeout:60000 })
  try{
    await imapConnect(client, 30000)
    // 组装 RFC822
    const boundary = 'evan-draft-' + crypto.randomBytes(8).toString('hex')
    const text = d.body_text || String(d.body_html||'').replace(/<[^>]+>/g, ' ')
    const html = d.body_html || String(d.body_text||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')
    const raw = [
      `From: ${acc.email}`,
      `To: ${d.to_addr || ''}`,
      d.cc_addr ? `Cc: ${d.cc_addr}` : '',
      `Subject: ${d.subject || ''}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      html,
      `--${boundary}--`,
      '',
    ].filter(Boolean).join('\r\n')
    const path = '[Gmail]/Drafts'
    const lock = await client.getMailboxLock(path)
    let uid = null
    try{
      uid = await client.append(path, Buffer.from(raw, 'utf8'), { flags: ['\\Draft'] })
    }finally{ lock.release() }
    res.json({ ok:true, uid: uid || null, folder: path })
  }catch(e){
    res.status(500).json({ error: String(e?.message||e).slice(0,200) })
  }finally{
    await logoutSafe(client)
  }
}))

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

// 入队发送：POST /email/outbox {accountId, to, subject, text, html, draftId?, idempotencyKey?, respectWindow?}（秒返回，后台发出）
app.post('/email/outbox', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { accountId, to, subject, text, html, idempotencyKey, respectWindow } = req.body || {}
  if(!accountId || !to || !subject) return res.status(400).json({ error:'需要 accountId, to, subject' })
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const id = crypto.randomUUID()
  const idem = idempotencyKey || id
  try{
    await pool.query(
      `INSERT INTO mail_outbox (id, username, account_id, to_list, subject, body_html, body_text, status, try_count, idempotency_key, respect_window)
       VALUES (?,?,?,?,?,?,?,'queued',0,?,?)`,
      [id, req.user, accountId, Array.isArray(to) ? to.join(',') : String(to), subject, html || text || '', text || '', idem, respectWindow ? 1 : 0])
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

// 发件 worker：每 30 秒扫一次到期任务（respect_window 的遇非窗口顺延 30 分钟）
async function outboxTick(){
  if(!dbReady) return
  try{
    const [rows] = await pool.query(
      `SELECT * FROM mail_outbox WHERE status IN ('queued','failed') AND try_count<3 AND (next_try_at IS NULL OR next_try_at<=NOW()) ORDER BY created_at LIMIT 10`)
    for(const job of rows){
      try{
        if(Number(job.respect_window)){
          const win = await inSendWindow(job.username)
          if(!win.ok){
            await pool.query(`UPDATE mail_outbox SET next_try_at=DATE_ADD(NOW(), INTERVAL 30 MINUTE) WHERE id=?`,[job.id])
            continue
          }
        }
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

// ====== 自动跟进序列引擎 ======
const DEFAULT_INTERVALS = [1, 2, 3, 4, 5, 6, 7] // 跟进1报价后1天，之后每步+2/+3…天（可改）
const DEFAULT_STEP_COPY = [
  { n: 1, opener: 'Following up on the quotation I sent yesterday. Do you have any questions on price or specs?' },
  { n: 2, opener: 'Just floating this to the top of your inbox in case it got buried. Happy to adjust quantity or specs to fit your budget.' },
  { n: 3, opener: 'Many of our clients finalize decisions around this stage. Shall I reserve production slots for you?' },
  { n: 4, opener: 'I wanted to share that raw material prices are trending up. Locking in this week could save you some cost.' },
  { n: 5, opener: 'Checking in once more — is there anything holding this back on your side? Timeline, design, or payment terms?' },
  { n: 6, opener: 'This will be one of my last check-ins so I don\u2019t clutter your inbox. If the timing is off, just tell me when to come back.' },
  { n: 7, opener: 'Closing the loop on my side for now. If anything changes, reply to this email and I\u2019ll pick it right up.' },
]
async function getIntervals(username){
  try{
    const [rows] = await pool.query('SELECT intervals_json FROM followup_config WHERE username=?',[username])
    if(rows.length && rows[0].intervals_json){
      const arr = JSON.parse(rows[0].intervals_json)
      if(Array.isArray(arr) && arr.length === 7 && arr.every(n=> Number(n) > 0)) return arr.map(Number)
    }
  }catch{}
  return [...DEFAULT_INTERVALS]
}
async function seedDefaultTemplates(username){
  try{
    const [rows] = await pool.query('SELECT COUNT(*) AS c FROM followup_templates WHERE username=? AND kind=?',[username, 'auto'])
    if(Number(rows[0]?.c)) return
    const now = sqlNow()
    for(const s of DEFAULT_STEP_COPY){
      await pool.query(`INSERT INTO followup_templates (id, username, name, kind, subject, body, updated_at) VALUES (?,?,?,?,?,?,?)`,
        [`auto-${username}-${s.n}`, username, `自动跟进${s.n}`, 'auto',
         'Following up: {{product}} quotation',
         `Hi {{first_name}},\n\n${s.opener}\n\nOur {{product}} can be ready in about 12-15 days after design confirmation.\n\nBest regards,\nEvan`, now])
    }
  }catch(e){ console.log('[seq] seed skip:', String(e.message||e).slice(0,80)) }
}
// 序列配置：GET/PUT /email/seq-config {intervals, sendStart, sendEnd, skipHolidays}
app.get('/email/seq-config', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const intervals = await getIntervals(req.user)
  let cfg = { sendStart: 8, sendEnd: 20, skipHolidays: true }
  try{
    const [rows] = await pool.query('SELECT send_start, send_end, skip_holidays FROM followup_config WHERE username=?',[req.user])
    if(rows.length) cfg = { sendStart: Number(rows[0].send_start ?? 8), sendEnd: Number(rows[0].send_end ?? 20), skipHolidays: Number(rows[0].skip_holidays ?? 1) === 1 }
  }catch{}
  res.json({ intervals, ...cfg })
}))
app.put('/email/seq-config', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const arr = req.body?.intervals
  if(!Array.isArray(arr) || arr.length !== 7 || !arr.every(n=> Number(n) > 0)) return res.status(400).json({ error:'需要7个正数' })
  const sendStart = Math.min(23, Math.max(0, Number(req.body?.sendStart ?? 8)))
  const sendEnd = Math.min(24, Math.max(1, Number(req.body?.sendEnd ?? 20)))
  const skipHolidays = req.body?.skipHolidays === false ? 0 : 1
  await pool.query(`INSERT INTO followup_config (username, intervals_json, send_start, send_end, skip_holidays, updated_at) VALUES (?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE intervals_json=VALUES(intervals_json), send_start=VALUES(send_start), send_end=VALUES(send_end), skip_holidays=VALUES(skip_holidays), updated_at=VALUES(updated_at)`,
    [req.user, JSON.stringify(arr.map(Number)), sendStart, sendEnd, skipHolidays, sqlNow()])
  res.json({ ok:true, intervals: arr.map(Number), sendStart, sendEnd, skipHolidays: !!skipHolidays })
}))

// 模板：GET /email/seq-templates?kind=auto ｜ PUT /email/seq-templates ｜ DELETE /email/seq-templates/:id
app.get('/email/seq-templates', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  await seedDefaultTemplates(req.user)
  const kind = String(req.query.kind || 'auto')
  const [rows] = await pool.query('SELECT * FROM followup_templates WHERE username=? AND kind=? ORDER BY id',[req.user, kind])
  res.json({ templates: rows })
}))
app.put('/email/seq-templates', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { id, name, kind, subject, body } = req.body || {}
  const tid = id || `tpl-${Date.now()}-${Math.floor(Math.random()*1e4)}`
  await pool.query(`INSERT INTO followup_templates (id, username, name, kind, subject, body, updated_at) VALUES (?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE name=VALUES(name), kind=VALUES(kind), subject=VALUES(subject), body=VALUES(body), updated_at=VALUES(updated_at)`,
    [tid, req.user, name || '未命名', kind === 'marketing' ? 'marketing' : 'auto', subject || '', body || '', sqlNow()])
  res.json({ ok:true, id: tid })
}))
app.delete('/email/seq-templates/:id', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  await pool.query('DELETE FROM followup_templates WHERE id=? AND username=?',[req.params.id, req.user])
  res.json({ ok:true })
}))

// 序列列表：GET /email/sequences?mode=（带客户名/等级）
app.get('/email/sequences', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const mode = String(req.query.mode || '')
  const [rows] = await pool.query(
    mode ? 'SELECT * FROM followup_sequences WHERE username=? AND mode=? ORDER BY next_due_at' : 'SELECT * FROM followup_sequences WHERE username=? ORDER BY next_due_at',
    mode ? [req.user, mode] : [req.user])
  // 关联客户名（读云同步 data 表）
  let nameMap = new Map()
  try{
    const [crows] = await pool.query(`SELECT row_id, data FROM data WHERE username=? AND table_name='customers' AND deleted=0`,[req.user])
    for(const r of crows){
      try{ const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data; nameMap.set(r.row_id, { title: d.title || d.contactName, level: d.level, isKey: !!d.isKey, email: d.email }) }catch{}
    }
  }catch{}
  res.json({ sequences: rows.map(s=>{
    let steps = []
    try{ steps = JSON.parse(s.steps_json || '[]') }catch{}
    return { ...s, steps, customer: nameMap.get(s.customer_id) || null }
  }) })
}))

// 启动序列：POST /email/sequences {customerId, email, accountId, intervals?, steps?[{subject,body,images[]}]}
app.post('/email/sequences', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { customerId, email, accountId, intervals, steps } = req.body || {}
  if(!customerId || !email || !accountId) return res.status(400).json({ error:'需要 customerId, email, accountId' })
  const acc = await loadMailAccount(accountId, req.user)
  if(!acc) return res.status(404).json({ error:'账号不存在' })
  const iv = (Array.isArray(intervals) && intervals.length === 7) ? intervals.map(Number) : await getIntervals(req.user)
  let stepDefs = Array.isArray(steps) && steps.length ? steps.slice(0, 7) : []
  if(!stepDefs.length){
    await seedDefaultTemplates(req.user)
    const [trows] = await pool.query(`SELECT * FROM followup_templates WHERE username=? AND kind='auto' ORDER BY id LIMIT 7`,[req.user])
    stepDefs = trows.map((t, i)=>({ subject: t.subject, body: t.body, images: [] }))
  }
  while(stepDefs.length < 7) stepDefs.push({ ...(stepDefs[stepDefs.length-1] || { subject:'Following up', body:'Hi, just checking in.', images:[] }) })
  const now = Date.now()
  const full = stepDefs.slice(0, 7).map((s, i)=>({ n:i+1, offsetDays: iv[i], subject: s.subject || '', body: s.body || '', images: s.images || [], status:'pending', sentAt: null }))
  // 渲染变量在创建时一次展开（{{first_name}} 等用客户邮箱前缀兜底）
  const firstName = String(email.split('@')[0]).split(/[._-]/)[0] || 'there'
  for(const s of full){
    s.subject = String(s.subject).replace(/\{\{first_name\}\}/gi, firstName)
    s.body = String(s.body).replace(/\{\{first_name\}\}/gi, firstName)
  }
  const nextDue = new Date(now + iv[0]*86400000)
  await pool.query(
    `INSERT INTO followup_sequences (customer_id, username, account_id, email, mode, current_step, next_due_at, steps_json, intervals_json, replied, updated_at)
     VALUES (?,?,?,?, 'auto', 1, ?, ?, ?, 0, ?) ON DUPLICATE KEY UPDATE account_id=VALUES(account_id), email=VALUES(email), mode='auto', current_step=1, next_due_at=VALUES(next_due_at), steps_json=VALUES(steps_json), intervals_json=VALUES(intervals_json), replied=0, replied_at=NULL, updated_at=VALUES(updated_at)`,
    [customerId, req.user, accountId, email, sqlDate(nextDue), JSON.stringify(full), JSON.stringify(iv), sqlNow()])
  res.json({ ok:true, nextDueAt: nextDue.toISOString() })
}))

// 切换模式/续跑：PATCH /email/sequences/:customerId {mode:'auto'|'manual'|'dormant', fromStep?}
app.patch('/email/sequences/:customerId', auth, wrap(async (req,res)=>{
  if(!dbReady) return res.status(503).json({ error:'需要 MySQL' })
  const { mode, fromStep } = req.body || {}
  if(!['auto','manual','dormant','done'].includes(mode)) return res.status(400).json({ error:'mode 非法' })
  const [rows] = await pool.query('SELECT * FROM followup_sequences WHERE customer_id=? AND username=?',[req.params.customerId, req.user])
  if(!rows.length) return res.status(404).json({ error:'序列不存在' })
  const s = rows[0]
  let steps = []
  try{ steps = JSON.parse(s.steps_json || '[]') }catch{}
  let iv = []
  try{ iv = JSON.parse(s.intervals_json || '[]') }catch{}
  if(mode === 'auto'){
    const from = Math.min(7, Math.max(1, Number(fromStep) || Number(s.current_step) || 1))
    // 重置 from 起后面步骤为 pending
    steps = steps.map(t => t.n >= from ? { ...t, status:'pending', sentAt:null } : t)
    const nextDue = new Date(Date.now() + (iv[from-1] || 1)*86400000)
    await pool.query(`UPDATE followup_sequences SET mode='auto', current_step=?, next_due_at=?, steps_json=?, replied=0, replied_at=NULL, updated_at=? WHERE customer_id=? AND username=?`,
      [from, sqlDate(nextDue), JSON.stringify(steps), sqlNow(), req.params.customerId, req.user])
    return res.json({ ok:true, mode:'auto', currentStep: from, nextDueAt: nextDue.toISOString() })
  }
  await pool.query(`UPDATE followup_sequences SET mode=?, updated_at=? WHERE customer_id=? AND username=?`,
    [mode, sqlNow(), req.params.customerId, req.user])
  res.json({ ok:true, mode })
}))

// 序列调度 worker：每 30 分钟扫到期步骤 → 进发件队列；7 步走完无回复 → 沉睡池
// 非发送窗口（美东深夜/美国节假日）整轮跳过
async function seqTick(){
  if(!dbReady) return
  try{
    const [rows] = await pool.query(
      `SELECT * FROM followup_sequences WHERE mode='auto' AND next_due_at IS NOT NULL AND next_due_at<=NOW() AND current_step BETWEEN 1 AND 8 LIMIT 50`)
    for(const s of rows){
      try{
        const win = await inSendWindow(s.username)
        if(!win.ok){ console.log(`[seq] 窗口外跳过 ${s.customer_id}：${win.reason}`); continue }
        let steps = []
        try{ steps = JSON.parse(s.steps_json || '[]') }catch{}
        let iv = []
        try{ iv = JSON.parse(s.intervals_json || '[]') }catch{}
        if(Number(s.current_step) > 7){
          // 7 步走完仍无回复 → 沉睡池
          await pool.query(`UPDATE followup_sequences SET mode='dormant', updated_at=? WHERE customer_id=?`,[sqlNow(), s.customer_id])
          console.log(`[seq] dormant ${s.customer_id}`)
          continue
        }
        const step = steps.find(t=> Number(t.n) === Number(s.current_step))
        if(!step || step.status === 'sent'){ // 数据不一致则推进
          await pool.query(`UPDATE followup_sequences SET current_step=current_step+1, next_due_at=DATE_ADD(NOW(), INTERVAL 1 DAY), updated_at=? WHERE customer_id=?`,[sqlNow(), s.customer_id])
          continue
        }
        // 图片占位 {{image:1}} → CID 内嵌（文件在 D:\mail-data 或 uploads）
        let html = String(step.body || '').replace(/\n/g, '<br>')
        const attachments = []
        const imgs = Array.isArray(step.images) ? step.images.slice(0,5) : []
        for(let i=0;i<imgs.length;i++){
          const token = `{{image:${i+1}}}`
          if(!html.includes(token)) continue
          let buf = null, mime = 'image/png', fname = `img${i+1}.png`
          try{
            const [frows] = await pool.query('SELECT stored_name, original_name, mime_type, path FROM files WHERE id=? AND username=?',[imgs[i], s.username])
            if(frows.length){ buf = fs.readFileSync(frows[0].path); mime = frows[0].mime_type || mime; fname = frows[0].original_name || fname }
          }catch{}
          if(buf){ attachments.push({ filename: fname, content: buf, cid: `seqimg${i}` }); html = html.split(token).join(`<img src="cid:seqimg${i}" style="max-width:100%">`) }
          else html = html.split(token).join('')
        }
        const [arows] = await pool.query('SELECT * FROM email_accounts WHERE id=? AND username=?',[s.account_id, s.username])
        if(!arows.length) throw new Error('账号不存在')
        const info = await sendMailViaSmtp(arows[0], decAuth(arows[0].auth_enc), { to: s.email, subject: step.subject, text: step.body, html, inReplyTo: undefined, references: undefined })
        // 发件成功：记步、推进，并在云同步 data 表留一条跟进记录（雷达/统计可见）
        step.status = 'sent'; step.sentAt = new Date().toISOString(); step.messageId = info.messageId || ''
        const next = Number(s.current_step) + 1
        const gap = iv[next-1] || iv[iv.length-1] || 1
        const nextDue = next > 7 ? new Date(Date.now() + 7*86400000) : new Date(Date.now() + gap*86400000)
        await pool.query(`UPDATE followup_sequences SET steps_json=?, current_step=?, next_due_at=?, updated_at=? WHERE customer_id=?`,
          [JSON.stringify(steps), next, sqlDate(nextDue), sqlNow(), s.customer_id])
        try{
          const fuId = `fu-seq-${s.customer_id}-${s.current_step}`
          const fuDue = new Date().toISOString().slice(0,10)
          const fu = { id: fuId, customerId: s.customer_id, dueAt: fuDue, channel:['auto-seq'],
            note:`自动跟进第${s.current_step}步已发`, status:'sent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
          await pool.query(`INSERT INTO data (username, table_name, row_id, data, updated_at, deleted) VALUES (?,?,?,?,?,0)
            ON DUPLICATE KEY UPDATE data=VALUES(data), updated_at=VALUES(updated_at), deleted=0`,
            [s.username, 'followUps', fuId, JSON.stringify(fu), fu.updatedAt.slice(0,23)])
        }catch{}
        console.log(`[seq] sent step${s.current_step} -> ${s.email}`)
      }catch(e){ console.log('[seq] step skip:', s.customer_id, String(e.message||e).slice(0,100)) }
    }
  }catch(e){ console.log('[seq] tick skip:', String(e.message||e).slice(0,100)) }
}
setInterval(seqTick, 30*60*1000)

// 发送窗口判定：美东时间 + 美国节假日避让（自动序列/营销群发用，用户手动发送不受限）
async function inSendWindow(username){
  let start = 8, end = 20, skipHol = 1
  try{
    const [rows] = await pool.query('SELECT send_start, send_end, skip_holidays FROM followup_config WHERE username=?',[username])
    if(rows.length){ start = Number(rows[0].send_start ?? 8); end = Number(rows[0].send_end ?? 20); skipHol = Number(rows[0].skip_holidays ?? 1) }
  }catch{}
  try{
    const etHour = Number(new Intl.DateTimeFormat('en-US',{ timeZone:'America/New_York', hour:'numeric', hour12:false }).format(new Date()))
    if(etHour < start || etHour >= end) return { ok:false, reason:`美东${etHour}点，非发送窗口(${start}:00-${end}:00)` }
  }catch{}
  if(skipHol){
    try{
      const today = new Date().toISOString().slice(0,10)
      const [hrows] = await pool.query('SELECT name FROM us_holidays WHERE date=?',[today])
      if(hrows.length) return { ok:false, reason:`今天是美国节假日（${hrows[0].name}），避让` }
    }catch{}
  }
  return { ok:true }
}

// 实质回复判定：排除自动回复/退信/系统通知
function isSubstantiveReply(env, parsed){
  const subj = String(env?.subject || parsed?.subject || '')
  const from = String(env?.from?.[0]?.address || parsed?.from?.value?.[0]?.address || '').toLowerCase()
  const text = String(parsed?.text || '').slice(0, 2000)
  if(/mailer-daemon|postmaster|no-?reply|donotreply|bounce/i.test(from)) return false
  if(/^(auto|automatic reply|out of office|ooo|away|vacation|undeliverable|delivery status|mail delivery failed|failure notice|delayed mail)/i.test(subj.trim())) return false
  if(/自动回复|不在办公室|休假|投递失败|退信|发送失败/i.test(subj)) return false
  try{
    const h = parsed?.headers
    const auto = h ? String(h.get('auto-submitted') || h.get('x-auto-response-suppress') || '') : ''
    if(auto && auto.toLowerCase() !== 'no') return false
  }catch{}
  const body = text.replace(/^\s*(hi|hello|dear|你好|您好)[^]*?\n/i, '').trim()
  if(/out of office|automatic reply|自动回复/i.test(text)) return false
  if(body.replace(/\W/g, '').length < 5 && !/yes|ok|确认|可以|好的|谢谢|thanks/i.test(body)) return false
  return true
}
// 回复检测：在正文入库时触发（只看14天内的新邮件，老邮件回填不触发）
async function seqReplyCheck(accountId, username, uid, env, parsed, msgDate){
  try{
    if(msgDate && (Date.now() - new Date(msgDate).getTime()) > 14*86400000) return
    const from = String(env?.from?.[0]?.address || parsed?.from?.value?.[0]?.address || '').toLowerCase().trim()
    if(!from || !from.includes('@')) return
    if(!isSubstantiveReply(env, parsed)) return
    // 找该发件人的客户（读云同步 data 表）
    const [crows] = await pool.query(`SELECT row_id, data FROM data WHERE username=? AND table_name='customers' AND deleted=0`,[username])
    let customerId = null
    for(const r of crows){
      try{
        const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data
        const mails = [(d.email||'').toLowerCase(), ...((d.extraEmails||[]).map(e=>String(e).toLowerCase()))]
        if(mails.includes(from)){ customerId = r.row_id; break }
      }catch{}
    }
    if(!customerId) return
    const [srows] = await pool.query(`SELECT mode FROM followup_sequences WHERE customer_id=? AND username=?`,[customerId, username])
    if(srows.length && srows[0].mode === 'auto'){
      await pool.query(`UPDATE followup_sequences SET mode='manual', replied=1, replied_at=?, updated_at=? WHERE customer_id=?`,[sqlDate(new Date()), sqlNow(), customerId])
      console.log(`[seq] replied -> manual ${customerId} (${from})`)
    }
  }catch{}
}

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
    startGmailAutoSync()   // Gmail API 账号自动增量
  })
})
