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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-evan-token')
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
