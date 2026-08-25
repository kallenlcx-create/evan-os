// ====== 首页每日内容：食谱 + AI 热点 ======
// 当前为内置数据 + 按日期轮换；AI 接口已预留（fetchRecipeTutorial / fetchAIHotspots）
// 后续接入 AI Provider 时只需替换这两个函数的实现

// ---------- 食谱 ----------

export interface Recipe {
  name: string
  emoji: string
  minutes: number
  ingredients: string[]
  steps: string[]
}

export const RECIPES: Recipe[] = [
  { name: '番茄炒蛋', emoji: '🍅', minutes: 10, ingredients: ['番茄 2 个', '鸡蛋 3 个', '葱花', '盐糖'], steps: ['鸡蛋打散加少许盐', '番茄切块', '热油炒蛋至凝固盛出', '炒番茄出汁', '倒回鸡蛋翻炒', '加盐糖调味撒葱花'] },
  { name: '蒜蓉西兰花', emoji: '🥦', minutes: 12, ingredients: ['西兰花 1 颗', '蒜 5 瓣', '蚝油'], steps: ['西兰花掰小朵焯水', '热油爆香蒜末', '下西兰花翻炒', '加蚝油盐调味'] },
  { name: '青椒肉丝', emoji: '🫑', minutes: 15, ingredients: ['猪里脊 200g', '青椒 3 个', '生抽淀粉'], steps: ['肉丝用生抽淀粉腌 10 分钟', '青椒切丝', '滑炒肉丝变色盛出', '炒青椒断生', '回锅合炒调味'] },
  { name: '可乐鸡翅', emoji: '🍗', minutes: 25, ingredients: ['鸡翅 8 个', '可乐 1 罐', '姜片生抽'], steps: ['鸡翅划刀焯水', '煎至两面金黄', '倒入可乐没过鸡翅', '加生抽姜片焖 15 分钟', '大火收汁'] },
  { name: '麻婆豆腐', emoji: '🌶️', minutes: 15, ingredients: ['嫩豆腐 1 盒', '肉末 100g', '豆瓣酱花椒粉'], steps: ['豆腐切块焯水', '炒肉末加豆瓣酱出红油', '加水下豆腐', '焖 5 分钟勾芡', '撒花椒粉葱花'] },
  { name: '清蒸鲈鱼', emoji: '🐟', minutes: 20, ingredients: ['鲈鱼 1 条', '葱姜蒸鱼豉油'], steps: ['鱼身划刀铺姜丝', '水开后蒸 8 分钟', '倒掉汤汁铺葱丝', '热油淋上蒸鱼豉油'] },
  { name: '土豆炖牛腩', emoji: '🥔', minutes: 60, ingredients: ['牛腩 500g', '土豆 2 个', '八角桂皮'], steps: ['牛腩切块焯水', '炒糖色下牛腩', '加热水香料炖 40 分钟', '下土豆再炖 15 分钟', '加盐收汁'] },
  { name: '蒜香排骨', emoji: '🍖', minutes: 30, ingredients: ['肋排 500g', '蒜 2 头', '生抽料酒'], steps: ['排骨腌制 20 分钟', '蒜末炸至金黄', '排骨炸至熟透', '蒜蓉回锅翻炒'] },
  { name: '上汤娃娃菜', emoji: '🥬', minutes: 10, ingredients: ['娃娃菜 2 颗', '皮蛋 1 个', '蒜瓣'], steps: ['娃娃菜切条', '皮蛋切丁蒜爆香', '加水煮开下娃娃菜', '煮软加盐出锅'] },
  { name: '蛋炒饭', emoji: '🍚', minutes: 8, ingredients: ['隔夜饭 1 碗', '鸡蛋 2 个', '葱花火腿丁'], steps: ['鸡蛋炒散', '下米饭压散翻炒', '加火腿丁盐', '撒葱花出锅'] },
]

/** 按日期确定性挑选（每天不同，循环轮换） */
export function pickDaily<T>(arr: T[], date: Date = new Date()): T {
  const dayIndex = Math.floor(date.getTime() / 86400000)
  return arr[dayIndex % arr.length]
}

/**
 * [AI 接口预留] 获取做菜教程
 * 未来接入 AI Provider：传入菜名 → 返回更详细的图文/视频教程
 */
export async function fetchRecipeTutorial(recipe: Recipe): Promise<{ title: string; detail: string[] }> {
  // Mock 实现；AI 接入后替换为真实调用
  return {
    title: `${recipe.emoji} ${recipe.name} · 约 ${recipe.minutes} 分钟`,
    detail: [
      '🛒 食材：' + recipe.ingredients.join('、'),
      ...recipe.steps.map((s, i) => `${i + 1}. ${s}`),
      '💡 小贴士：火候是灵魂，多试两次就有手感了！',
    ],
  }
}

// ---------- AI 热点 ----------

export interface AIHotspot {
  title: string
  source: string
  summary: string
}

export const AI_HOTSPOTS: AIHotspot[] = [
  { title: '多模态模型成本再降 80%', source: 'AI 周刊', summary: '主流厂商下调多模态推理价格，图片理解进入平价时代，适合客服与文档场景落地。' },
  { title: '本地小模型跑通日常办公', source: '开源动态', summary: '7B 级开源模型在笔记本即可流畅运行，写邮件/总结文档已够用。' },
  { title: 'AI Agent 编排标准草案发布', source: '行业新闻', summary: '多家厂商联合推 Agent 互操作协议，跨平台智能体协作成为可能。' },
  { title: '代码助手准确率大幅提升', source: '开发者日报', summary: '新一代代码模型在真实仓库任务完成率提升至 60%+，重构场景表现亮眼。' },
  { title: '语音实时对话延迟降至 300ms', source: '产品发布', summary: '实时语音对话接近自然交流节奏，外语陪练与电话客服场景爆发。' },
  { title: 'RAG 检索增强最佳实践更新', source: '技术博客', summary: '混合检索 + 重排序成为标配，知识库问答准确率普遍提升 20%。' },
  { title: 'AI 绘图支持一致性角色', source: '设计周报', summary: '同一角色跨图保持一致的生成能力上线，绘本与漫画创作门槛大降。' },
  { title: '浏览器内置 AI API 开始普及', source: 'W3C 动态', summary: 'Chrome 系浏览器内置翻译/摘要 API，网页端零成本调用端侧模型。' },
]

/** 每日挑选 3 条（按日期轮换） */
export function pickDailyHotspots(date: Date = new Date()): AIHotspot[] {
  const dayIndex = Math.floor(date.getTime() / 86400000)
  return [0, 1, 2].map(i => AI_HOTSPOTS[(dayIndex + i) % AI_HOTSPOTS.length])
}

/**
 * [AI 接口预留] 获取最新 AI 热点
 * 未来接入 AI Provider：联网检索真实热点并生成摘要
 */
export async function fetchAIHotspots(): Promise<AIHotspot[]> {
  // Mock 实现；AI 接入后替换
  return pickDailyHotspots()
}
