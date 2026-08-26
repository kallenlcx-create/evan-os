const fs = require('fs')
const path = require('path')
const file = path.resolve(__dirname, 'dist', 'index.html')

let html = fs.readFileSync(file, 'utf8')
if (html.charCodeAt(0) === 0xFEFF) html = html.slice(1)
if (!html.includes('<script type="module"')) html = html.replace('<script>', '<script type="module" crossorigin>')

const checks = ['首页', '今日重点', '正在启动', '写今日日志', '四象限', '番茄钟']
let allOk = true
for (const word of checks) {
  const ok = html.includes(word)
  console.log(`Check "${word}":`, ok ? 'OK' : 'MISSING')
  if (!ok) allOk = false
}
if (allOk) {
  fs.writeFileSync(file, html, 'utf8')
  console.log('DONE size:', html.length)
} else {
  console.log('FAILED')
}