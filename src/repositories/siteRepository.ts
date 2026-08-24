// ====== Site Repository —— 独立站（Shopify）数据与分析 ======

import { db } from '../db'
import type { SiteMetric, SiteProduct, SeoKeyword } from '../types'
import { uid, now, type Result, ok, err } from './result'

// ---------- 产品 ----------

export async function upsertProductByHandle(data: Partial<SiteProduct> & { handle: string }): Promise<Result<SiteProduct>> {
  const existing = await db.siteProducts.where('handle').equals(data.handle).first()
  const ts = now()
  if (existing) {
    const merged: SiteProduct = { ...existing, ...data, id: existing.id, updatedAt: ts }
    await db.siteProducts.put(merged)
    return ok(merged)
  }
  const product: SiteProduct = {
    id: uid(),
    handle: data.handle,
    title: data.title ?? data.handle,
    status: data.status ?? 'active',
    price: data.price,
    currency: data.currency ?? 'USD',
    inventory: data.inventory,
    vendor: data.vendor,
    tags: data.tags ?? [],
    updatedAt: ts,
  }
  await db.siteProducts.add(product)
  return ok(product)
}

export async function getAllProducts(): Promise<SiteProduct[]> {
  try {
    return await db.siteProducts.toArray()
  } catch {
    return []
  }
}

// ---------- 指标 ----------

export async function upsertMetric(m: Partial<SiteMetric> & { date: string }): Promise<Result<SiteMetric>> {
  const existing = await db.siteMetrics.get(m.date)
  const record: SiteMetric = existing
    ? { ...existing, ...m, id: m.date }
    : {
        id: m.date,
        date: m.date,
        visitors: m.visitors ?? 0,
        ordersCount: m.ordersCount ?? 0,
        conversionRate: m.conversionRate ?? 0,
        revenue: m.revenue,
        currency: m.currency ?? 'USD',
        adSpend: m.adSpend,
        repeatOrderRate: m.repeatOrderRate,
        seoTopKeywords: m.seoTopKeywords,
        source: m.source ?? 'manual',
        createdAt: now(),
      }
  await db.siteMetrics.put(record)
  return ok(record)
}

export interface SiteAnalytics {
  days: number
  totalVisitors: number
  totalOrders: number
  totalRevenue: number
  avgConversionRate: number
  totalAdSpend: number
  roas: number                    // 广告回报率 revenue / adSpend
  avgRepeatOrderRate: number
  cpcEstimate: number             // adSpend / visitors
}

/** 近 N 天经营分析（按日期窗口过滤，无数据的天自动忽略） */
export function analyzeMetrics(metrics: SiteMetric[], days = 7, nowMs = Date.now()): SiteAnalytics {
  const cutoff = new Date(nowMs - days * 86400000).toISOString().slice(0, 10)
  const sorted = [...metrics]
    .filter(m => m.date >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, days)
  const n = sorted.length || 1
  const totalVisitors = sorted.reduce((s, m) => s + (m.visitors || 0), 0)
  const totalOrders = sorted.reduce((s, m) => s + (m.ordersCount || 0), 0)
  const totalRevenue = sorted.reduce((s, m) => s + (m.revenue || 0), 0)
  const totalAdSpend = sorted.reduce((s, m) => s + (m.adSpend || 0), 0)

  return {
    days: sorted.length,
    totalVisitors,
    totalOrders,
    totalRevenue,
    avgConversionRate: Number((sorted.reduce((s, m) => s + (m.conversionRate || 0), 0) / n).toFixed(2)),
    totalAdSpend,
    roas: totalAdSpend > 0 ? Number((totalRevenue / totalAdSpend).toFixed(2)) : 0,
    avgRepeatOrderRate: Number((sorted.reduce((s, m) => s + (m.repeatOrderRate || 0), 0) / n).toFixed(1)),
    cpcEstimate: totalVisitors > 0 ? Number((totalAdSpend / totalVisitors).toFixed(3)) : 0,
  }
}

export async function getRecentMetrics(days = 7): Promise<SiteMetric[]> {
  try {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
    const rows = await db.siteMetrics.where('date').aboveOrEqual(cutoff).toArray()
    return rows.sort((a, b) => b.date.localeCompare(a.date))
  } catch {
    return []
  }
}

// ---------- SEO 关键词 ----------

export async function upsertSeoKeyword(k: { keyword: string; position?: number; volume?: number; difficulty?: number; targetUrl?: string }): Promise<Result<SeoKeyword>> {
  const all = await db.seoKeywords.toArray()
  const existing = all.find(x => x.keyword === k.keyword)
  const record: SeoKeyword = {
    id: existing?.id ?? uid(),
    keyword: k.keyword,
    position: k.position ?? existing?.position,
    volume: k.volume ?? existing?.volume,
    difficulty: k.difficulty ?? existing?.difficulty,
    targetUrl: k.targetUrl ?? existing?.targetUrl,
    checkedAt: now(),
  }
  await db.seoKeywords.put(record)
  return ok(record)
}

export async function getAllSeoKeywords(): Promise<SeoKeyword[]> {
  try {
    return await db.seoKeywords.toArray()
  } catch {
    return []
  }
}
