// 后台常驻邮件同步服务 - 不随切页暂停，全局单例
import { listAccounts, syncReal } from '../repositories/emailRepository'

export type EmailSyncConfig = {
  enabled: boolean
  intervalMinutes: number // 1,5,10,30,60,1440
  limit: number | 'all'
  lastSyncAt?: string
  nextSyncAt?: string
}

const LS_KEY = 'evan:emailSyncConfig'
const EVT_PROGRESS = 'evan-email-sync-progress'
const EVT_DONE = 'evan-email-synced'

let timer: number | null = null
let syncing = false
let progress = { done:0, total:0, status:'' as string }

function loadConfig(): EmailSyncConfig{
  try{
    const raw = localStorage.getItem(LS_KEY)
    if(raw) return JSON.parse(raw)
  }catch{}
  return { enabled:false, intervalMinutes:30, limit:30 }
}
function saveConfig(c: EmailSyncConfig){
  localStorage.setItem(LS_KEY, JSON.stringify(c))
  window.dispatchEvent(new CustomEvent('evan-email-config-changed'))
}
export function getEmailSyncConfig(){ return loadConfig() }
export function setEmailSyncConfig(patch: Partial<EmailSyncConfig>){
  const cur = loadConfig()
  const next = { ...cur, ...patch }
  saveConfig(next)
  if(next.enabled) startAutoSync()
  else stopAutoSync()
  return next
}

function emitProgress(p: Partial<typeof progress>){
  progress = { ...progress, ...p }
  window.dispatchEvent(new CustomEvent(EVT_PROGRESS, {detail: {...progress}}))
}
function emitDone(detail:any){
  window.dispatchEvent(new CustomEvent(EVT_DONE, {detail}))
  // 同时触发全局数据更新事件，供全景/拓扑/客户等监听
  window.dispatchEvent(new CustomEvent('evan-emails-updated', {detail}))
  window.dispatchEvent(new CustomEvent('evan-customers-updated', {detail}))
}

export async function syncAllEmails(limit: number|'all' = 30): Promise<number>{
  const lim = limit==='all' ? 1000000 : Number(limit)||30
  if(syncing) return 0
  syncing=true
  emitProgress({ status:'同步中...', done:0, total:1 })
  try{
    const accounts = await listAccounts()
    if(accounts.length===0) throw new Error('未绑定邮箱')
    let totalAdded=0
    for(let i=0;i<accounts.length;i++){
      const acc = accounts[i]
      let offset=0
      let accTotal=0
      // 分批拉取，每批200，实时展示数量
      while(true){
        emitProgress({ status:`同步 ${acc.email} 已拉 ${offset}封`, done: offset, total: 1 })
        const res:any = await syncReal(acc.id, 200, offset)
        const added = typeof res==='object' ? res.added : Number(res)||0
        const hasMore = typeof res==='object' ? res.hasMore : false
        const batchTotal = typeof res==='object' ? res.total : 0
        if(added>0){ totalAdded+=added; offset+=added; accTotal+=added }
        emitProgress({ status:`已同步 ${offset}/${batchTotal||'?'} 封`, done: offset, total: batchTotal||offset+1 })
        // 达到本次限额或无更多则停
        if(!hasMore || added===0) break
        if(offset>=lim) break
        // 让出主线程，避免阻塞UI
        await new Promise(r=> setTimeout(r, 50))
      }
    }
    emitDone({ total: totalAdded, limit: lim })
    // 更新配置时间
    const cfg=loadConfig(); cfg.lastSyncAt=new Date().toISOString();
    cfg.nextSyncAt=new Date(Date.now()+ cfg.intervalMinutes*60000).toISOString();
    saveConfig(cfg)
    return totalAdded
  } finally {
    syncing=false
    emitProgress({ status:'空闲', done:0, total:0 })
  }
}

export function isEmailSyncing(){ return syncing }
export function getEmailSyncProgress(){ return {...progress} }

export function startAutoSync(){
  stopAutoSync()
  const cfg=loadConfig()
  if(!cfg.enabled) return
  const tick = async()=>{
    if(document.visibilityState!=='visible') return
    if(syncing) return
    try{ await syncAllEmails(cfg.limit) }catch{}
  }
  // 立即算下次时间
  const cfg2=loadConfig()
  cfg2.nextSyncAt=new Date(Date.now()+ cfg2.intervalMinutes*60000).toISOString()
  saveConfig(cfg2)
  timer = window.setInterval(tick, cfg.intervalMinutes*60000)
  // 定时展示倒计时
  window.setInterval(()=>{
    const c=loadConfig()
    if(c.nextSyncAt) emitProgress({ status:`下次 ${new Date(c.nextSyncAt).toLocaleTimeString()}` })
  }, 30000)
}

export function stopAutoSync(){
  if(timer){ clearInterval(timer); timer=null }
}

// 供 Layout/App 启动时调用
export function initEmailSync(){
  const cfg=loadConfig()
  if(cfg.enabled) startAutoSync()
}
