// ====== 批量搜索匹配器（searchTerms）测试 ======
// parseSearch / matchSearch：批量邮箱 OR、多词 OR、引号短语、粘连拆分、大小写、域名、次邮箱
// 运行: npx tsx test-terms.ts

import { parseSearch, matchSearch } from './src/services/searchTerms.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

console.log('\n🧪 批量搜索匹配器测试\n')

// —— 解析 ——
assert('A1. 空输入返回空', parseSearch('').length === 0 && parseSearch('   ').length === 0)
assert('A2. 空白分隔去重', JSON.stringify(parseSearch('a@x.com  A@X.com')) === JSON.stringify(['a@x.com']))
assert('A3. 中英文逗号/分号/顿号/竖线/换行分隔',
  parseSearch('a@x.com，b@x.com;c@x.com、d@x.com|e@x.com\nf@x.com').length === 6)
assert('A4. 引号短语保持整体', JSON.stringify(parseSearch('"ABC Tactical" x')) === JSON.stringify(['abc tactical', 'x']))
assert('A5. 中文引号短语', parseSearch('“你好 世界”')[0] === '你好 世界')
assert('A6. 无缝粘连邮箱在 TLD 后拆开',
  JSON.stringify(parseSearch('support@ubersuggest.comjohn@abc.com')) === JSON.stringify(['support@ubersuggest.com', 'john@abc.com']))
assert('A7. 单邮箱含点本地部分不被拆', JSON.stringify(parseSearch('first.last@x.com')) === JSON.stringify(['first.last@x.com']))
assert('A8. 包裹标点剥离', JSON.stringify(parseSearch('<john@abc.com> (neil@x.com)')) === JSON.stringify(['john@abc.com', 'neil@x.com']))
assert('A9. 句末句号剥离', parseSearch('support@ubersuggest.com.')[0] === 'support@ubersuggest.com')

// —— 匹配 ——
const hay = 'Neil Patel support@ubersuggest.com'
const mails = ['support@ubersuggest.com']

assert('B1. 单邮箱命中', matchSearch('support@ubersuggest.com', hay, mails))
assert('B2. 大小写不敏感', matchSearch('SUPPORT@UBERSUGGEST.COM', hay, mails))

// 10 个邮箱批量（换行 + 空格 + 逗号三种粘法）
const list10 = [
  'support@ubersuggest.com', 'john@abc.com', 'neil@answerthepublic.com',
  'a1@x.com', 'a2@x.com', 'a3@x.com', 'a4@x.com', 'a5@x.com', 'a6@x.com', 'a7@x.com',
]
for (const sep of ['\n', ' ', ',']) {
  const q = list10.join(sep)
  assert(`B3.${sep === '\n' ? '换行' : sep === ' ' ? '空格' : '逗号'} 10 邮箱全命中`, list10.every(e => matchSearch(q, `客户${e}`, [e])))
}
assert('B4. 未列出的邮箱不命中', !matchSearch(list10.join('\n'), 'z@z.com', ['z@z.com']))

// 粘连邮箱命中
assert('B5. 粘连邮箱可分别命中', matchSearch('support@ubersuggest.comjohn@abc.com', 'John Smith john@abc.com', ['john@abc.com']))

// 公司名多词 OR
assert('B6. 多词 OR：命中 Tactical', matchSearch('ABC Tactical', 'Tactical Gear Inc tactical@x.com', ['tactical@x.com']))
assert('B7. 多词 OR：命中 ABC', matchSearch('ABC Tactical', 'ABC Trading abc@y.com', ['abc@y.com']))
assert('B8. 多词 OR：两个词都不含则不中', !matchSearch('ABC Tactical', 'Plain Corp p@z.com', ['p@z.com']))

// 引号短语收紧
assert('B9. 引号短语不连续则不中', !matchSearch('"ABC Tactical"', 'Tactical Gear ABC t@x.com', ['t@x.com']))
assert('B10. 引号短语连续则命中', matchSearch('"ABC Tactical"', 'We make ABC Tactical badges', ['a@b.com']))

// 域名部分匹配 + extraEmails 次邮箱
assert('B11. @域名 命中该域所有邮箱', matchSearch('@ubersuggest.com', hay, mails))
assert('B12. extraEmails 次邮箱命中', matchSearch('second@old.com', 'Client primary@new.com', ['primary@new.com', 'second@old.com']))
assert('B13. 引号包裹邮箱命中', matchSearch('"support@ubersuggest.com"', hay, mails))

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
