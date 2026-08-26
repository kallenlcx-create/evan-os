// ====== Event Bus —— 自动化触发器接线 ======
// 此前 agentRuntime.handleEvent 与 workflowEngine.handleEvent/tick 全项目零调用方，
// 事件触发与定时触发是纸面功能。本模块在应用启动时把三件事接起来：
//   1. EventRepository 的进程内订阅 → 分发给 Agent on_event 触发器
//   2. 同一事件流 → 分发给 Workflow event 触发器
//   3. 周期 tick → 驱动 Workflow time 触发器
// 仅在真实应用入口调用 startEventBus()；测试环境不调用，行为保持确定性。

import { onEventCreated } from '../repositories/eventRepository'
import { agentRuntime } from './agentRuntime'
import { workflowEngine } from './workflowEngine'

let started = false

export function startEventBus(): void {
  if (started) return
  started = true

  onEventCreated(event => {
    void agentRuntime.handleEvent(event)
    void workflowEngine.handleEvent({
      type: event.type,
      payload: event.payload,
      objectType: event.objectType,
      objectId: event.objectId,
    })
  })

  // 定时触发：每分钟 tick 一次，isTimeDue 内部有 lastRunAt 幂等护栏
  const TICK_MS = 60_000
  setTimeout(() => { void workflowEngine.tick() }, 15_000)
  setInterval(() => { void workflowEngine.tick() }, TICK_MS)
}
