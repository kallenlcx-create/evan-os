// 邮件 HTML 安全展示：DOMPurify 清洗 + 无脚本沙箱 iframe + 默认拦截外部图片
import DOMPurify from 'dompurify'

export function sanitizeMailHtml(html: string, allowRemote: boolean){
  let h = html || ''
  if(!allowRemote) h = h.replace(/<img([^>]*?)\ssrc\s*=\s*(["'])(https?:[^"']*)\2/gi, '<img$1 data-blocked-src="$3"')
  return DOMPurify.sanitize(h, { USE_PROFILES: { html: true }, FORBID_TAGS: ['script','iframe','object','embed','form','style','link','meta'] })
}

export function countBlockedImg(html: string){
  const m = (html||'').match(/<img[^>]*\ssrc\s*=\s*["']https?:/gi)
  return m ? m.length : 0
}

export default function MailHtml({ html, allowRemote = false, height = 320 }: { html: string; allowRemote?: boolean; height?: number }){
  if(!html) return null
  const blocked = !allowRemote ? countBlockedImg(html) : 0
  return (
    <div>
      {blocked>0 && <div className="text-[10px] text-gray-400 mb-1">🛡️ 已拦截 {blocked} 张外部图片（防追踪）</div>}
      <iframe sandbox="" title="mail-body" srcDoc={sanitizeMailHtml(html, allowRemote)}
        className="w-full border rounded-lg bg-white" style={{ height }} />
    </div>
  )
}
