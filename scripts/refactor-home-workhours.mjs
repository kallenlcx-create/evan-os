import fs from 'node:fs'

let c = fs.readFileSync('src/pages/Home.tsx', 'utf8')

// 1. 删除本地 readWorkHours / isWorkNow 定义（改用统一配置模块）
c = c.replace(
  /function readWorkHours\(\) \{\n[\s\S]*?\n\}\n\/\*\* 是否处于工作时间[\s\S]*?\n\}\n\n/,
  ''
)

// 2. 导入统一模块
c = c.replace(
  "import { getPresetCss } from '../config/wallpapers'",
  "import { getPresetCss } from '../config/wallpapers'\nimport { readWorkHours, isWorkNow, isWorkDay } from '../config/workHours'"
)

// 3. reload 逻辑改统一读取
c = c.replace(
  /try \{ setHours\(\{ \.\.\.DEFAULT_WORK_HOURS[\s\S]*?\} catch \{ \/\* ignore \*\/ \}/,
  'setHours(readWorkHours())'
)

// 4. isOffDay 用配置判定
c = c.replace(
  'const workdays: number[] = (hours as any).workdays ?? [1, 2, 3, 4, 5]\n  const isOffDay = !workdays.includes(now.getDay())',
  'const isOffDay = !isWorkDay(now)'
)

// 5. 久坐 tick 里的 isWorkNow 已有同名函数 ✓（本地删除后自动落到导入版）

fs.writeFileSync('src/pages/Home.tsx', c)
console.log(
  'local readWorkHours def:', c.includes('function readWorkHours'),
  '| imported:', c.includes("from '../config/workHours'")
)
