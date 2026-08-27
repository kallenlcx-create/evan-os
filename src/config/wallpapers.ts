// ====== 壁纸配置 ======
// 类型：none 默认灰 / preset 内置渐变 / image 自定义图片（本地压缩存储，不上云）

export interface WallpaperPreset {
  id: string
  name: string
  css: string
}

export interface WallpaperConfig {
  type: 'none' | 'preset' | 'image'
  presetId?: string
  imageDataUrl?: string
  /** 内容区黑色遮罩透明度 0-0.6 */
  dim: number
  /** 侧边栏壁纸（独立于内容区） */
  sidebarType?: 'none' | 'preset' | 'image'
  sidebarPresetId?: string
  sidebarImageDataUrl?: string
  /** 侧边栏背景透明度 0-1，越大越透明（展示壁纸） */
  sidebarDim?: number
  /** 内容区卡片透明度 0-1，越大越透明（展示壁纸） */
  contentCardOpacity?: number
  /** 内容区卡片背景颜色（hex），与透明度叠加 */
  contentCardColor?: string
}

export const WALLPAPER_PRESETS: WallpaperPreset[] = [
  { id: 'aurora', name: '极光', css: 'linear-gradient(135deg,#667eea 0%,#764ba2 50%,#f093fb 100%)' },
  { id: 'sunset', name: '日落', css: 'linear-gradient(135deg,#fa709a 0%,#fee140 100%)' },
  { id: 'ocean', name: '海洋', css: 'linear-gradient(135deg,#2e3192 0%,#1bffff 100%)' },
  { id: 'forest', name: '森林', css: 'linear-gradient(135deg,#134e5e 0%,#71b280 100%)' },
  { id: 'midnight', name: '午夜', css: 'linear-gradient(135deg,#0f0c29 0%,#302b63 50%,#24243e 100%)' },
  { id: 'sakura', name: '樱花', css: 'linear-gradient(135deg,#ffdde1 0%,#ee9ca7 100%)' },
  { id: 'peach', name: '蜜桃', css: 'linear-gradient(135deg,#ffecd2 0%,#fcb69f 100%)' },
  { id: 'mint', name: '薄荷', css: 'linear-gradient(135deg,#00b09b 0%,#96c93d 100%)' },
  { id: 'slate', name: '石墨', css: 'linear-gradient(135deg,#485563 0%,#29323c 100%)' },
]

export const DEFAULT_WALLPAPER: WallpaperConfig = { type: 'none', dim: 0, sidebarDim: 0.15, contentCardOpacity: 1, contentCardColor: '#ffffff' }

// ====== 卡片背景颜色预设（与透明度叠加，所有卡片统一生效）======
export interface CardBgPreset {
  id: string
  name: string
  color: string // hex
  rgb: string // "r,g,b"
}

export const CARD_BG_PRESETS: CardBgPreset[] = [
  { id: 'white', name: '纯白', color: '#ffffff', rgb: '255,255,255' },
  { id: 'warm', name: '暖白', color: '#fffaf0', rgb: '255,250,240' },
  { id: 'cream', name: '奶茶', color: '#fdf6ec', rgb: '253,246,236' },
  { id: 'peach', name: '蜜桃', color: '#fff7ed', rgb: '255,247,237' },
  { id: 'pink', name: '樱粉', color: '#fff1f2', rgb: '255,241,242' },
  { id: 'sakura', name: '豆粉', color: '#fef2f2', rgb: '254,242,242' },
  { id: 'sky', name: '天空', color: '#f0f9ff', rgb: '240,249,255' },
  { id: 'blue', name: '雾蓝', color: '#eff6ff', rgb: '239,246,255' },
  { id: 'mint', name: '薄荷', color: '#f0fdf4', rgb: '240,253,244' },
  { id: 'green', name: '豆绿', color: '#f0fdfa', rgb: '240,253,250' },
  { id: 'lavender', name: '薰衣草', color: '#f5f3ff', rgb: '245,243,255' },
  { id: 'lily', name: '香芋', color: '#faf5ff', rgb: '250,245,255' },
  { id: 'lemon', name: '柠檬', color: '#fefce8', rgb: '254,252,232' },
  { id: 'yellow', name: '浅黄', color: '#fef9c3', rgb: '254,249,195' },
  { id: 'gray', name: '浅灰', color: '#f8fafc', rgb: '248,250,252' },
  { id: 'slate', name: '石板', color: '#f1f5f9', rgb: '241,245,249' },
]

/** hex -> "r,g,b" */
export function hexToRgb(hex: string): string {
  const m = hex.replace('#', '')
  const full = m.length === 3 ? m.split('').map(c => c + c).join('') : m
  const n = parseInt(full, 16)
  if (Number.isNaN(n) || full.length !== 6) return '255,255,255'
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `${r},${g},${b}`
}

export function getPresetCss(presetId?: string): string | undefined {
  return WALLPAPER_PRESETS.find(p => p.id === presetId)?.css
}

/** 自定义图片：等比压缩至 maxDim，转 JPEG dataURL（控制 IndexedDB 体积） */
export async function fileToWallpaperDataUrl(
  file: File,
  maxDim = 1920,
  quality = 0.82
): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 不可用')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  return canvas.toDataURL('image/jpeg', quality)
}
