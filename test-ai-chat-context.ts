// ====== AI 对话 · 邮件上下文注入回归测试 ======
// 事故（2026-11 线上）：AiChat 把 emailCtx 组装好后只当布尔值用，
// 邮件数据从未拼进 system 消息 → 模型被告知"数据已在上下文"却什么都没有，
// 于是回答"当前上下文中并未提供与 xxx 相关的客户邮件或档案数据"。
// 运行: npx tsx test-ai-chat-context.ts

import {
  MAIL_CTX_HEADER, MAIL_CTX_RULE,
  extractMailHits, mailBodyOf, mailHasBody, mailsForAddress,
  buildPartsForAddress, buildEmailCtx, buildSystemPrompt, buildMailLoadNote,
  type MailLike, type MailCtxStat,
} from './src/utils/chatMailContext.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

console.log('\n🧪 AI 对话 · 邮件上下文注入测试\n')

const CUSTOMER_EMAIL = 'johncorrea88@gmail.com'
const BASE_SYS = '你是 Evan OS 的 AI 助手。请用中文回答，简洁专业。'

// ── 事故现场样本：本地镜像 5 封全是空壳信封（text/html 全空），服务端库有正文 ──
const localShell: MailLike[] = [
  { from: 'Evan Maxemblem <evan@maxemblem.com>', to: CUSTOMER_EMAIL, subject: 'Re: Custom Coins INQC26101600002', text: '', html: '', date: '2026-11-13T02:48:10.000Z', uid: 67459, accountId: 'acct-1', imapFolder: '[Gmail]/All Mail' },
  { from: 'Evan Maxemblem <evan@maxemblem.com>', to: CUSTOMER_EMAIL, subject: 'Re: Custom Coins INQC26101600002', text: '', html: '', date: '2026-11-05T02:10:01.000Z', uid: 65380, accountId: 'acct-1', imapFolder: '[Gmail]/All Mail' },
  { from: 'Evan Maxemblem <evan@maxemblem.com>', to: CUSTOMER_EMAIL, subject: 'Re: Custom Coins', text: '', html: '', date: '2026-10-22T14:23:20.000Z', uid: 62810, accountId: 'acct-1', imapFolder: '[Gmail]/All Mail' },
]
const remoteWithBody: MailLike[] = [
  { from: 'evan@maxemblem.com', to: CUSTOMER_EMAIL, subject: 'Re: Custom Coins INQC26101600002', text: 'Hi John, target was mid-December for the 2.25" antique brass coins with UV printing. Production runs 23 working days.', date: '2026-11-13T02:48:10.000Z', uid: 67459, accountId: 'acct-1', imapFolder: '[Gmail]/All Mail' },
  { from: 'evan@maxemblem.com', to: CUSTOMER_EMAIL, subject: 'Re: Custom Coins INQC26101600002', text: 'Hi John, I am following up on the custom coin proposal (INQC26101600002).', date: '2026-11-05T02:10:01.000Z', uid: 65380, accountId: 'acct-1', imapFolder: '[Gmail]/All Mail' },
  { from: `${CUSTOMER_EMAIL}`, to: 'evan@maxemblem.com', subject: 'Re: Custom Coins', text: 'In terms of budget itll depend on the artwork.', date: '2026-10-24T09:00:00.000Z', uid: 61399, accountId: 'acct-1', imapFolder: '[Gmail]/All Mail' },
]
const customer = { id: 'cust-1', email: CUSTOMER_EMAIL, title: 'John Correa Bueno', company: 'Maxemblem LLC', level: 'C', stage: 'lead', notes: '询 UV 古铜币', aiSummary: '关注交期与报价' }

// ====== 1. P0 核心：邮件数据必须真正进 system 消息 ======
console.log('— P0：邮件数据拼进 system 消息（事故直接回归）—')
const hits = extractMailHits(`麻烦${CUSTOMER_EMAIL}读取下这个客户的邮件`)
const merged = [...localShell, ...remoteWithBody]
const mails = mailsForAddress(merged, hits[0], 10)
const built = buildPartsForAddress(hits[0], customer, mails)
const emailCtx = buildEmailCtx(built.parts)
const sys = buildSystemPrompt(BASE_SYS, emailCtx)

assert('system 消息包含邮件正文（不是只有指令）', sys.includes('antique brass coins with UV printing'))
assert('system 消息包含邮件数据块头部', sys.includes(MAIL_CTX_HEADER.trim().slice(0, 10)))
assert('system 消息包含客户档案', sys.includes('【客户档案】') && sys.includes('John Correa Bueno'))
assert('system 消息包含纪律指令', sys.includes('严禁回答「无法访问邮件/系统/数据库」'))
assert('system 消息保留基础系统提示词', sys.startsWith(BASE_SYS))
// 旧 bug 形态：只拼指令、不拼数据 —— 必须被测试判为“不含正文”
const oldBuggySys = BASE_SYS + MAIL_CTX_RULE
assert('【防复发】旧的「只拼指令」形态不含任何正文', !oldBuggySys.includes('antique brass coins'))
assert('【防复发】修复后比旧形态多了真实数据', sys.length > oldBuggySys.length && sys.includes('INQC26101600002'))
assert('无邮件时不附加纪律指令', buildSystemPrompt(BASE_SYS, '') === BASE_SYS)

// ====== 2. 邮箱抽取 ======
console.log('— 邮箱抽取 —')
assert('中文夹邮箱可抽出', extractMailHits('johncorrea88@gmail.com读取下这个客户的邮件')[0] === CUSTOMER_EMAIL)
assert('多个邮箱去重+小写', extractMailHits('A@B.com 和 a@b.com 及 c@d.com').length === 2)
assert('无邮箱返回空数组', extractMailHits('今天天气怎么样').length === 0)
assert('空输入安全', extractMailHits('').length === 0)

// ====== 3. 正文判定（本地空壳信封是事故关键） ======
console.log('— 正文判定 —')
assert('text 为空 → 无正文', mailHasBody({ text: '', html: '' }) === false)
assert('text 有值 → 有正文', mailHasBody({ text: 'Hi John' }) === true)
assert('仅 html 也算有正文', mailHasBody({ text: '', html: '<p>Hello</p>' }) === true)
assert('正文剥离 HTML 标签', mailBodyOf({ text: '', html: '<div>Hi <b>John</b></div>' }).replace(/\s+/g, ' ').trim() === 'Hi John')
assert('纯标签不产生正文', mailHasBody({ text: '<br/><div> </div>' }) === false)

// ====== 4. 地址过滤 / 排序 / 去重 / 截断 ======
console.log('— 邮件筛选 —')
assert('只留该地址相关邮件', mails.every(m => String(m.to).includes(CUSTOMER_EMAIL) || String(m.from).includes(CUSTOMER_EMAIL)))
assert('本地空壳与远端同 uid 去重', new Set(mails.map(m => `${m.accountId}-${m.uid}`)).size === mails.length)
assert('去重后保留了有正文的那条', mails.find(m => m.uid === 67459)!.text!.includes('antique brass'))
assert('按日期倒序', String(mails[0].date) >= String(mails[mails.length - 1].date))
assert('limit 截断生效', mailsForAddress(remoteWithBody, CUSTOMER_EMAIL, 2).length === 2)
assert('无关地址过滤为空', mailsForAddress(remoteWithBody, 'nobody@x.com').length === 0)

// ====== 5. 片段组装与统计 ======
console.log('— 片段组装 —')
assert('含客户档案片段', built.parts[0].includes('【客户档案】') && built.parts[0].includes('公司Maxemblem LLC'))
assert('关联客户 id 可用于写回', built.linkedCustomerId === 'cust-1')
assert('我方发件标注为「我方」', built.parts.some(p => p.includes('我方 主题')))
assert('客户发件标注为「客户」', built.parts.some(p => p.includes('客户 主题')))
assert('统计：total=命中数', built.stat.total === mails.length)
assert('统计：withBody/missingBody 一致', built.stat.withBody + built.stat.missingBody === built.stat.total)
assert('全空壳时 withBody=0', buildPartsForAddress(CUSTOMER_EMAIL, customer, localShell).stat.withBody === 0)
const noCustomer = buildPartsForAddress('new@x.com', null, [])
assert('无建档给占位邮箱片段', noCustomer.parts[0].includes('暂无详细建档'))
assert('完全没邮件给「未找到」占位', noCustomer.parts[1].includes('未找到 new@x.com 的邮件正文'))
assert('无邮件时 linkedCustomerId 为空', noCustomer.linkedCustomerId === '')

// ====== 6. emailCtx 边界 ======
console.log('— emailCtx —')
assert('emailCtx 以数据块头部开头', emailCtx.startsWith(MAIL_CTX_HEADER))
assert('多片段用分隔线拼接', emailCtx.includes('\n\n---\n\n'))
assert('空片段列表 → 空 emailCtx', buildEmailCtx([]) === '')
const huge = new Array(60).fill('X'.repeat(1000))
assert('超过 16000 字被截断', buildEmailCtx(huge).length <= 16000 + MAIL_CTX_HEADER.length)

// ====== 7. 提示条：按正文计数 + 错误透出（不再静默） ======
console.log('— 邮件读取提示 —')
const statAll: MailCtxStat = built.stat
const statEmpty: MailCtxStat = { total: 3, withBody: 0, missingBody: 3 }
const statNone: MailCtxStat = { total: 0, withBody: 0, missingBody: 0 }
const noteOk = buildMailLoadNote({ hits: [CUSTOMER_EMAIL], stat: statAll, errors: [] })
const noteEmpty = buildMailLoadNote({ hits: [CUSTOMER_EMAIL], stat: statEmpty, errors: [] })
const noteNone = buildMailLoadNote({ hits: [CUSTOMER_EMAIL], stat: statNone, errors: [] })
const noteErr = buildMailLoadNote({ hits: [CUSTOMER_EMAIL], stat: statNone, errors: ['远端搜索失败：请先登录云同步'] })
assert('有正文 → 按 x/y 封报数', noteOk.includes(`${statAll.withBody}/${statAll.total}`))
assert('缺正文时点明缺几封', statAll.missingBody > 0 ? noteOk.includes(`${statAll.missingBody} 封缺正文`) : true)
assert('正文全空 → 提示去拉邮件', noteEmpty.includes('正文为空') && noteEmpty.includes('拉邮件'))
assert('一封没有 → 提示未找到', noteNone.includes('未找到'))
assert('取数错误透出到提示（关键回归）', noteErr.includes('请先登录云同步'))
assert('无邮箱时不产生提示', buildMailLoadNote({ hits: [], stat: statNone, errors: [] }) === '')

console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
if (fail > 0) process.exit(1)
