// 邮件 HTML 安全展示：DOMPurify 清洗 + 无脚本沙箱 iframe + 默认拦截外部图片
// P0：无边框；P1：blockquote 引用默认折叠为 ···
import DOMPurify from 'dompurify'

const QUOTE_FOLD_CSS = `
  html,body{margin:0;padding:8px 4px;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2937;background:#fff}
  img{max-width:100%;height:auto}
  a{color:#2563eb}
  /* Gmail 式引用折叠 */
  .evan-quote-fold{margin:8px 0}
  .evan-quote-fold>summary{
    display:inline-flex;align-items:center;justify-content:center;
    width:36px;height:22px;border-radius:11px;background:#f3f4f6;color:#6b7280;
    font-size:12px;font-weight:700;letter-spacing:1px;cursor:pointer;list-style:none;
    user-select:none;
  }
  .evan-quote-fold>summary::-webkit-details-marker{display:none}
  .evan-quote-fold>summary:hover{background:#e5e7eb}
  .evan-quote-fold[open]>summary{margin-bottom:6px}
  .evan-quote-fold blockquote{
    margin:4px 0 4px 2px;padding:2px 0 2px 12px;
    border-left:2px solid #d1d5db;color:#4b5563;
  }
`

/** 把 HTML 里的 blockquote 包成 details 折叠（无 JS，iframe 内可用） */
export function foldHtmlQuotes(html: string){
  if(!html || !/<blockquote[\s>]/i.test(html)) return html
  // 连续 blockquote 合成一个折叠块
  return html.replace(/(<blockquote[\s\S]*?<\/blockquote>)+/gi, (m)=>
    `<details class="evan-quote-fold"><summary>···</summary>${m}</details>`
  )
}

export function sanitizeMailHtml(html: string, allowRemote: boolean){
  let h = html || ''
  if(!allowRemote) h = h.replace(/<img([^>]*?)\ssrc\s*=\s*(["'])(https?:[^"']*)\2/gi, '<img$1 data-blocked-src="$3"')
  h = foldHtmlQuotes(h)
  const clean = DOMPurify.sanitize(h, { USE_PROFILES: { html: true }, FORBID_TAGS: ['script','iframe','object','embed','form','style','link','meta'] })
  // style 标签被 FORBID 掉，用 srcdoc 内联 style 注入折叠样式
  return `<style>${QUOTE_FOLD_CSS}</style>${clean}`
}

export function countBlockedImg(html: string){
  const m = (html||'').match(/<img[^>]*\ssrc\s*=\s*["']https?:/gi)
  return m ? m.length : 0
}

export default function MailHtml({ html, allowRemote = false, height = 320 }: { html: string; allowRemote?: boolean; height?: number }){
  if(!html) return null
  const blocked = !allowRemote ? countBlockedImg(html) : 0
  return (
    <div className="w-full">
      {blocked>0 && <div className="text-[10px] text-gray-400 mb-1">🛡️ 已拦截 {blocked} 张外部图片（防追踪）</div>}
      {/* P0：去掉 border/rounded，贴近 Gmail 无框正文 */}
      <iframe sandbox="" title="mail-body" srcDoc={sanitizeMailHtml(html, allowRemote)}
        className="w-full bg-white" style={{ height, border: 'none' }} />
    </div>
  )
}
