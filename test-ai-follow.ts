// ====== 批量AI回复：正文提取与信件形态守卫测试 ======
// 回归：模型在「写信阶段」输出分析 JSON 时，绝不能把 JSON 当正文放行（客户收到 JSON 的事故）
// 运行: npx tsx test-ai-follow.ts

import 'fake-indexeddb/auto'
import { extractEmailBody } from './src/services/aiFollowReply.ts'
import { looksLikeEmail, isWholeJsonObject } from './src/utils/mailShape.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

console.log('\n🧪 批量AI回复 · 正文提取/信件形态守卫测试\n')

// ── 事故样本：Ashley Stewart 那封被当正文发出的分析 JSON（自造 schema，代码中不存在） ──
const INCIDENT_JSON = `{
  "customer_profile": "Ashley Stewart (End Customer, Level D, Lead Stage, Inquiry/Quoted)",
  "current_status": "Customer stopped responding after initial engagement ~31 days ago; previous attempts were generic follow-ups.",
  "strategy": "Pivot from generic 'any updates?' to value-added support. Offer specific design/production insights for soft enamel/PVC badges to address potential blockers (cost vs. quality or design complexity) without pressure.",
  "unique_details_used": "Reference to the specific 'Custom Medals' inquiry, the gap since late October, and the specific craftsmanship of soft enamel/PVC badges to show expertise.",
  "primary_goal": "Re-engage by identifying if the project is stalled due to design complexity or cost concerns, offering free design optimization tips."
}`

// ── 事故样本（阶段A 的真实 schema，也不得成为正文） ──
const STAGE_A_JSON = `{
  "state": "曾经积极沟通，但目前停止回复",
  "evidence": ["10月25日询盘", "我方10月28日报价"],
  "unresolved": "价格与交期未确认",
  "goal": "重新激活对话",
  "strategy": "提供工艺说明换角度",
  "subject": "Re: Custom Medals - design tips",
  "insufficient": false,
  "swapTest": true
}`

// ── 真实的正常邮件正文 ──
const NORMAL_MAIL = `Hi Ashley,

Thanks for your interest in our Custom Medals. I wanted to follow up on the soft enamel options we discussed - here are a few points that often help with the cost vs. quality decision.

Could you let me know if the project is still active?

Best regards,
Evan`

// ====== 1. 纯 JSON 输入不得成为正文（本次事故的直接回归） ======
console.log('— 纯 JSON 不得成为正文 —')
const outIncident = extractEmailBody(INCIDENT_JSON)
assert('事故 JSON 提取结果为空串', outIncident === '')
assert('事故 JSON 不以 { 开头', !outIncident.trim().startsWith('{'))
assert('事故 JSON 不含 customer_profile 字段', !outIncident.includes('customer_profile'))

const outStageA = extractEmailBody(STAGE_A_JSON)
assert('阶段A schema JSON 提取结果为空串', outStageA === '')
assert('阶段A JSON 不含 "state" 键', !outStageA.includes('"state"'))

const fencedJson = '```json\n' + INCIDENT_JSON + '\n```'
assert('带 ```json 围栏的 JSON 提取为空串', extractEmailBody(fencedJson) === '')

assert('事故 JSON 整体判定为 JSON 对象', isWholeJsonObject(INCIDENT_JSON))
assert('事故 JSON 判定为「不像信」', looksLikeEmail(INCIDENT_JSON) === false)
assert('阶段A JSON 判定为「不像信」', looksLikeEmail(STAGE_A_JSON) === false)
assert('围栏 JSON 判定为「不像信」', looksLikeEmail(fencedJson) === false)

// ====== 2. 正常邮件必须完整保留 ======
console.log('— 正常邮件保留 —')
const outMail = extractEmailBody(NORMAL_MAIL)
assert('正常邮件原样返回', outMail === NORMAL_MAIL)
assert('正常邮件保留问候语', /^Hi Ashley,/.test(outMail))
assert('正常邮件保留落款', /Best regards,\nEvan$/.test(outMail))
assert('正常邮件判定为「像信」', looksLikeEmail(NORMAL_MAIL) === true)

// ====== 3. JSON 夹在邮件中间（模型先输出分析再写信）→ 只留信 ======
console.log('— 混杂输入 —')
const mixed = `以下是分析：\n${STAGE_A_JSON}\n\nHi Ashley,\n\nJust checking in on the badges.\n\nBest regards,\nEvan`
const outMixed = extractEmailBody(mixed)
assert('混杂输入去掉 JSON 块', !outMixed.includes('"state"'))
assert('混杂输入保留邮件', outMixed.includes('Hi Ashley') && outMixed.includes('Best regards'))
assert('混杂输入判定为「像信」', looksLikeEmail(outMixed) === true)

// 纯说明文字（无问候语/落款）→ 不像信
assert('无问候语的说明文字不像信', looksLikeEmail('Here is the analysis of the customer status and next steps.') === false)
assert('空串不像信', looksLikeEmail('') === false)

// ====== 4. 签名粘连修复仍生效 ======
console.log('— 签名修复 —')
const glued = 'Hi Tom,\n\nFollowing up.\n\nYours,Evan'
const outGlued = extractEmailBody(glued)
assert('Yours,Evan → 换行分隔', /Yours,\nEvan/.test(outGlued))

console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
if (fail > 0) process.exit(1)
