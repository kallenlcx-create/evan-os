// ====== Trade Repository —— 外贸业务管道 ======
// 询盘 → 报价 → 谈判 → 付款 → 生产 → 发货 → 售后 → 复购
// 跟进 = 沟通记录（communication.log），不是阶段

import { db } from '../db'
import type { TradeDeal, TradeStage } from '../types'
import { TRADE_STAGE_ORDER } from '../types'
import { uid, now, type Result, ok, err } from './result'
import { createEvent } from './eventRepository'

export async function createTradeDeal(data: Partial<TradeDeal>): Promise<Result<TradeDeal>> {
  if (!data.title) return err('title 不能为空')
  const stage: TradeStage = 'inquiry' // 一律从询盘开始
  const deal: TradeDeal = {
    id: uid(),
    title: data.title,
    customerId: data.customerId,
    stage,
    stageHistory: [{ stage, at: now() }],
    value: data.value,
    currency: data.currency ?? 'USD',
    inquirySource: data.inquirySource,
    assigneeNote: data.assigneeNote,
    tags: data.tags ?? [],
    createdAt: now(),
    updatedAt: now(),
  }
  try {
    await db.tradeDeals.add(deal)
    await createEvent('object.created', 'user', 'process', deal.id, {
      title: deal.title, kind: 'trade_deal', stage,
    })
    return ok(deal)
  } catch (e) {
    return err(`创建询盘失败: ${e}`)
  }
}

/** 阶段推进：只允许沿管道前进或跳到 lost */
export async function advanceTradeStage(id: string, next: TradeStage): Promise<Result<TradeDeal>> {
  const deal = await db.tradeDeals.get(id)
  if (!deal) return err(`商机不存在: ${id}`)

  const curIdx = TRADE_STAGE_ORDER.indexOf(deal.stage)
  const nextIdx = TRADE_STAGE_ORDER.indexOf(next)
  const valid =
    next === 'lost' ||
    (deal.stage !== 'lost' && curIdx >= 0 && nextIdx > curIdx)
  if (!valid) {
    return err(`非法阶段流转: ${deal.stage} → ${next}`)
  }

  const updated: TradeDeal = {
    ...deal,
    stage: next,
    stageHistory: [...deal.stageHistory, { stage: next, at: now() }],
    updatedAt: now(),
  }
  await db.tradeDeals.put(updated)
  await createEvent('object.updated', 'user', 'process', id, {
    kind: 'trade_stage', from: deal.stage, to: next,
  })
  return ok(updated)
}

export async function getTradeDeal(id: string): Promise<TradeDeal | undefined> {
  return db.tradeDeals.get(id)
}

export async function getAllTradeDeals(): Promise<TradeDeal[]> {
  try {
    return await db.tradeDeals.toArray()
  } catch {
    return []
  }
}

/** 按阶段统计（看板用） */
export function groupByStage(deals: TradeDeal[]): Record<string, TradeDeal[]> {
  const out: Record<string, TradeDeal[]> = {}
  for (const d of deals) {
    ;(out[d.stage] ??= []).push(d)
  }
  return out
}

/** 管道价值：未流失商机的金额合计 */
export function pipelineValue(deals: TradeDeal[], excludeLost = true): number {
  return deals
    .filter(d => !excludeLost || d.stage !== 'lost')
    .reduce((sum, d) => sum + (d.value ?? 0), 0)
}
