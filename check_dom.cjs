const fs = require('fs')
const file = process.argv[2] || (process.env.TEMP + '/v03-dom.txt')
const c = fs.readFileSync(file, 'utf8')
console.log('DOM length:', c.length)
const rootIdx = c.indexOf('id="root"')
if (rootIdx >= 0) {
  const after = c.substring(rootIdx, Math.min(rootIdx + 200, c.length))
  console.log('ROOT:', after)
}
const title = c.match(/<title>(.*?)<\/title>/)
console.log('TITLE:', title ? title[1] : 'NONE')
const checks = ['首页', '今日重点', '统计分析', '正在启动', '今日专注', '知识与思考', '目标', '项目', '行动', '搜索']
let p = 0
for (const w of checks) {
  const ok = c.includes(w)
  if (ok) p++
  console.log(ok ? 'PASS' : 'FAIL', w)
}
console.log(p + '/' + checks.length + ' passed')