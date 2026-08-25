# 🧠 Evan OS v1.0 — Personal & Business OS

> **让信息服务于行动，而不是让通知占据注意力。**
> AI 越强大，核心数据越要掌控在用户手里。

本地优先的单文件个人与事业操作系统。React 18 + TypeScript + Vite + Tailwind + Dexie(IndexedDB)。
构建产物为单个 `dist/index.html`，离线可用。

```
npm install && npm run dev     # 开发
npm test                       # 10 个测试套件 · 270+ 断言
npm run build                  # 单文件构建
```

## 🏆 Roadmap（已冻结）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| v0.1 | Prototype | 🟢 |
| v0.2 | 核心数据层：Object / Relation / Event / Repository / Migration | 🟢 |
| v0.3 | 统一搜索：SearchIndex / SearchService / RelationQueryService / Knowledge Graph | 🟢 |
| v0.4 | Memory 长期记忆（AI 只能建议，置信度封顶） | 🟢 |
| v0.5 | Context Engine（收集→过滤→排序→压缩→组装，tokenBudget） | 🟢 |
| v0.6 | Agent Runtime（4 个 Agent + 三级权限 + 审批） | 🟢 |
| v0.7 | Automation Engine（Event/Time/Manual 触发 + AND/OR/NOT 条件） | 🟢 |
| v0.8 | Integrations：Gmail / Hermes / Shopify / Calendar / n8n / MCP | 🟢 |
| v0.9 | Business：外贸八阶段管道 + 独立站经营分析 | 🟢 |
| **v1.0** | **四层数据库 + 架构守卫 + System 总览** | 🏆 |

## 🗄️ 四层数据库

```
第一层 核心对象   goals domains projects tasks customers opportunities orders communications
                 knowledge inspirations questions research experiments decisions reviews processes agents
第二层 系统关系   relations events          ← 一切连接与审计的事实源
第三层 AI         memories agentRuns agentTools agentPermissions contexts
第四层 自动化     workflows workflowVersions workflowSteps workflowRuns approvals
```

共 36 张表（含 v1.1 删除墓碑 deletions），实时计数见应用内「系统架构」页。

## 🛡️ 核心设计原则

**AI 永远不直接操作数据库。**

```
AI → Tool / Command → Permission → Repository → Database → Event
```

- Agent Runner 不 import db（静态扫描守卫，test-system B1）
- 外部适配器禁止直写业务表，只能发 CommandBus 命令（B2）
- 每次写入产生 Event 审计（B3）
- 高风险动作（外发邮件、删除数据、外部 API）必须 Approval → Human → Execute

## 🤖 AI 纵贯线

Data → Relation → Event → Context → Memory → Agent → Workflow → Action → Result → Review

- **Memory** ≠ Knowledge：AI 的长期上下文独立成表；AI 只能 suggest（candidate），用户确认才生效
- **ContextEngine**：定向收集（禁止隐式全库注入）、按 priority×relevance 排序、tokenBudget 贪心裁剪、快照可回放
- **Agent 标准十要素**：身份/目标/指令/Context/Memory/Tools/Permissions/Triggers/Actions/ApprovalPolicy
  - 第一批 4 个：知识整理助手 · 项目助手 · 复盘助手 · 研究助手
- **三级权限**：L1 自动（整理/摘要/建议关系）· L2 建议-确认 · L3 人工批准+显式执行

## 🔌 外部集成

统一 Tool Layer：`外部系统 → Adapter → CommandBus → Repository → Event`
Gmail 收件导入 · Shopify 产品/指标同步 · **Hermes**（未回复客户分析 → 草拟 → L3 发送）· Calendar/n8n/MCP 桩就绪。
不直连任何第三方 API —— 全部 Mock，接口形状已冻结。

## 💼 业务层

外贸管道：询盘 → 报价 → 谈判 → 付款 → 生产 → 发货 → 售后 → 复购（+流失），阶段只进不退、全程留痕。
独立站：产品目录 / 流量 / 转化 / 广告 ROAS / 复购率 / SEO 关键词追踪。

## 📚 页面地图

首页 · 目标 · 工作台（外贸+独立站） · 项目 · 行动 · 成长 · 知识与思考 · 生活 · 统计分析
AI 中心（聚合入口） · Agents · 自动化 · AI 记忆 · Context Inspector · AI 实验室
外部集成 · 云同步 · 系统架构 · 设置

> 侧边栏按「概览 / 工作 / 知识与成长 / AI / 系统」分组折叠。
> 多设备：前端托管 GitHub Pages；数据同步自部署 `server/`（Express+MySQL，见 server/DEPLOY-LAPTOP.md）。
