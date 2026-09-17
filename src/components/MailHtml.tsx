// 邮件 HTML 安全展示：DOMPurify 清洗 + 直接 DOM 渲染（自适应高度）
// P0：无边框；P1：blockquote 引用默认折叠为 ···
import DOMPurify from 'dompurify'

/** 把 HTML 里的 blockquote 包成 details 折叠（无 JS） */
export function foldHtmlQuotes(html: string){
  if(!html || !/<blockquote[\s>]/i.test(html)) return html
  return html.replace(/(<blockquote[\s\S]*?<\/blockquote>)+/gi, (m)=>
    `<details class="evan-quote-fold"><summary>···</summary>${m}</details>`
  )
}

export function sanitizeMailHtml(html: string, allowRemote: boolean){
  let h = html || ''
  if(!allowRemote) h = h.replace(/<img([^>]*?)\ssrc\s*=\s*(["'])(https?:[^"']*)\2/gi, '<img$1 data-blocked-src="$3"')
  h = foldHtmlQuotes(h)
  return DOMPurify.sanitize(h, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script','iframe','object','embed','form','style','link','meta'],
    ADD_ATTR: ['open'],
  })
}

export function countBlockedImg(html: string){
  const m = (html||'').match(/<img[^>]*\ssrc\s*=\s*["']https?:/gi)
  return m ? m.length : 0
}

export default function MailHtml({ html, allowRemote = false, height }: { html: string; allowRemote?: boolean; height?: number }){
  if(!html) return null
  const blocked = !allowRemote ? countBlockedImg(html) : 0
  const clean = sanitizeMailHtml(html, allowRemote)
  return (
    <div className="w-full">
      {blocked>0 && <div className="text-[10px] text-gray-400 mb-1">🛡️ 已拦截 {blocked} 张外部图片（防追踪）</div>}
      {/* 用 div 自适应高度，避免 iframe 固定高度留下大段空白 */}
      <div
        className="evan-mail-body text-[14px] leading-relaxed text-gray-800"
        style={height ? { maxHeight: height, overflowY: 'auto' } : undefined}
        dangerouslySetInnerHTML={{ __html: clean }}
      />
      <style>{`
        .evan-mail-body img{max-width:100%;height:auto}
        .evan-mail-body a{color:#2563eb}
        .evan-mail-body table{border-collapse:collapse;max-width:100%}
        .evan-mail-body td,.evan-mail-body th{border:1px solid #d1d5db;padding:4px 8px}
        .evan-quote-fold{margin:8px 0}
        .evan-quote-fold>summary{
          display:inline-flex;align-items:center;justify-content:center;
          width:36px;height:22px;border-radius:11px;background:#f3f4f6;color:#6b7280;
          font-size:12px;font-weight:700;letter-spacing:1px;cursor:pointer;list-style:none;user-select:none;
        }
        .evan-quote-fold>summary::-webkit-details-marker{display:none}
        .evan-quote-fold>summary:hover{background:#e5e7eb}
        .evan-quote-fold blockquote{
          margin:4px 0 4px 2px;padding:2px 0 2px 12px;
          border-left:2px solid #d1d5db;color:#4b5563;
        }
      `}</style>
    </div>
  )
}
