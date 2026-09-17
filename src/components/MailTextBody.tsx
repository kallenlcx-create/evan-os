// 纯文本邮件：Gmail 式引用折叠（On ... wrote / 在...写道）
import { useState } from 'react'

const QUOTE_SPLIT =
  /\n(?=(?:On\s.+?wrote:|On\s.+\s<[^>]+>\s+wrote:|-{2,}\s*Original Message\s*-{2,}|在\s*.+\s*写道[：:]|From:\s*Sent:\s*To:\s*Subject:))/i

export function splitMailQuote(text: string): { head: string; quote: string } {
  const t = String(text || '')
  if (!t) return { head: '', quote: '' }
  const parts = t.split(QUOTE_SPLIT)
  if (parts.length < 2) return { head: t, quote: '' }
  return { head: parts[0], quote: parts.slice(1).join('\n') }
}

/** 正文 + 默认折叠的历史引用（···） */
export default function MailTextBody({ text, maxHead = 20000 }: { text: string; maxHead?: number }){
  const { head, quote } = splitMailQuote(text)
  const [open, setOpen] = useState(false)
  if (!text) return <div className="text-sm text-gray-400">(无正文)</div>
  return (
    <div className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
      {head.slice(0, maxHead)}
      {quote && (
        <div className="mt-2">
          {!open ? (
            <button
              type="button"
              onClick={()=> setOpen(true)}
              title="展开引用历史"
              className="inline-flex items-center justify-center min-w-[36px] h-[22px] px-2 rounded-full bg-gray-100 text-gray-500 text-xs font-bold tracking-widest hover:bg-gray-200"
            >···</button>
          ) : (
            <>
              <button
                type="button"
                onClick={()=> setOpen(false)}
                title="收起引用"
                className="mb-1 inline-flex items-center justify-center min-w-[36px] h-[22px] px-2 rounded-full bg-gray-100 text-gray-500 text-xs font-bold hover:bg-gray-200"
              >▴</button>
              <div className="border-l-2 border-gray-300 pl-3 text-gray-600 whitespace-pre-wrap">
                {quote.slice(0, maxHead)}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
