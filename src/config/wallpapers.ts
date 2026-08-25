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
  /** 黑色遮罩透明度 0-0.6，保证白色卡片内容可读 */
  dim: number
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

export const DEFAULT_WALLPAPER: WallpaperConfig = { type: 'none', dim: 0 }

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
