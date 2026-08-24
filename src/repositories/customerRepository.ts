import { db } from '../db'
import type { Customer, Opportunity, Order, Communication } from '../types'
import { uid, now, type Result, ok, err } from './result'
import { createEvent } from './eventRepository'
import { createRelation } from './relationRepository'

// ====== Customer Repository ======

export async function createCustomer(data: Partial<Customer>): Promise<Result<Customer>> {
  const id = data.id || uid()
  const customer: Customer = {
    id,
    type: 'customer',
    title: data.title || data.contactName || data.company || '',
    description: data.description || '',
    emoji: '👤',
    tags: data.tags || [],
    relations: [],
    company: data.company,
    contactName: data.contactName,
    email: data.email,
    phone: data.phone,
    country: data.country,
    website: data.website,
    stage: data.stage || 'lead',
    value: data.value,
    currency: data.currency,
    notes: data.notes,
    createdAt: now(),
    updatedAt: now(),
  }

  try {
    await db.customers.add(customer)
    await createEvent('object.created', 'user', 'customer', id, { title: customer.title })
    return ok(customer)
  } catch (e) {
    return err(`创建客户失败: ${e}`)
  }
}

export async function getAllCustomers(): Promise<Customer[]> {
  try { return await db.customers.toArray() } catch { return [] }
}

// ====== Opportunity Repository ======

export async function createOpportunity(data: Partial<Opportunity>): Promise<Result<Opportunity>> {
  const id = data.id || uid()
  const opp: Opportunity = {
    id,
    type: 'opportunity',
    title: data.title || '',
    description: data.description || '',
    emoji: '💼',
    tags: data.tags || [],
    relations: [],
    stage: data.stage || 'prospecting',
    value: data.value,
    currency: data.currency,
    expectedCloseDate: data.expectedCloseDate,
    probability: data.probability,
    customerId: data.customerId,  // legacy
    createdAt: now(),
    updatedAt: now(),
  }

  try {
    await db.opportunities.add(opp)
    await createEvent('object.created', 'user', 'opportunity', id, { title: opp.title })

    // 如果有 customerId，建立 customer ← opportunity 的 belongs_to 关系
    if (data.customerId) {
      await createRelation('opportunity', id, 'customer', data.customerId, 'belongs_to', {
        source: 'manual',
      })
    }

    return ok(opp)
  } catch (e) {
    return err(`创建商机失败: ${e}`)
  }
}

export async function getAllOpportunities(): Promise<Opportunity[]> {
  try { return await db.opportunities.toArray() } catch { return [] }
}

// ====== Order Repository ======

export async function createOrder(data: Partial<Order>): Promise<Result<Order>> {
  const id = data.id || uid()
  const order: Order = {
    id,
    type: 'order',
    title: data.title || data.orderNumber || '',
    description: data.description || '',
    emoji: '📦',
    tags: data.tags || [],
    relations: [],
    orderNumber: data.orderNumber,
    status: data.status || 'pending',
    amount: data.amount,
    currency: data.currency,
    orderDate: data.orderDate,
    deliveryDate: data.deliveryDate,
    customerId: data.customerId,  // legacy
    opportunityId: data.opportunityId, // legacy
    items: data.items,
    createdAt: now(),
    updatedAt: now(),
  }

  try {
    await db.orders.add(order)
    await createEvent('object.created', 'user', 'order', id, { title: order.title })

    // 建立关系
    if (data.customerId) {
      await createRelation('order', id, 'customer', data.customerId, 'belongs_to')
    }
    if (data.opportunityId) {
      await createRelation('order', id, 'opportunity', data.opportunityId, 'created_from')
    }

    return ok(order)
  } catch (e) {
    return err(`创建订单失败: ${e}`)
  }
}

export async function getAllOrders(): Promise<Order[]> {
  try { return await db.orders.toArray() } catch { return [] }
}

// ====== Communication Repository ======

export async function createCommunication(data: Partial<Communication>): Promise<Result<Communication>> {
  const id = data.id || uid()
  const comm: Communication = {
    id,
    type: 'communication',
    title: data.title || '',
    description: data.description || '',
    emoji: '📧',
    tags: data.tags || [],
    relations: [],
    channel: data.channel || 'email',
    direction: data.direction || 'outbound',
    participants: data.participants,
    customerId: data.customerId,  // legacy
    opportunityId: data.opportunityId, // legacy
    orderId: data.orderId,    // legacy
    summary: data.summary || '',
    actionItems: data.actionItems,
    nextSteps: data.nextSteps,
    communicatedAt: data.communicatedAt || now(),
    createdAt: now(),
    updatedAt: now(),
  }

  try {
    await db.communications.add(comm)
    await createEvent('object.created', 'user', 'communication', id, { title: comm.title })

    // 建立关系
    if (data.customerId) {
      await createRelation('communication', id, 'customer', data.customerId, 'related_to')
    }

    return ok(comm)
  } catch (e) {
    return err(`创建沟通记录失败: ${e}`)
  }
}

export async function getAllCommunications(): Promise<Communication[]> {
  try { return await db.communications.toArray() } catch { return [] }
}
