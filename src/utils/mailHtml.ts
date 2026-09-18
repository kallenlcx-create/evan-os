// 邮件正文格式工具：text → html，保留换行
export function escapeHtml(s: string){
  return String(s||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
}

/** 纯文本转 HTML：空行=段落，单换行=br */
export function textToHtml(text: string){
  const t = String(text||'')
  if(!t) return ''
  if(/<[a-z][\s\S]*>/i.test(t) && /<br|<p|<div/i.test(t)) return t
  const paras = t.split(/\r?\n\r?\n/)
  return paras.map(p=>{
    const lines = p.split(/\r?\n/).map(l=> escapeHtml(l)).join('<br>')
    return `<p style="margin:0 0 12px 0;line-height:1.6">${lines}</p>`
  }).join('')
}

export function normalizeReplySubject(subject: string){
  const s = String(subject||'').trim()
  if(!s) return ''
  return /^re:/i.test(s) ? s : `Re: ${s}`
}
