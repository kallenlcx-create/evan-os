# Gmail API（OAuth）接入指南

目标：Gmail 走官方 API（不限流、可增量），QQ / 网易 / 163 / Outlook 继续走 IMAP，双轨并行。

## 一、Google Cloud Console（做一次，约 5 分钟）

1. 打开 https://console.cloud.google.com/，新建项目（名字随意，如 `evan-os-mail`）
2. **API 和服务 → 库**，搜索 `Gmail API` → **启用**
3. **API 和服务 → OAuth 同意屏幕**：
   - 用户类型选**外部** → 创建
   - 应用名称随便填（如 Evan OS），用户支持电子邮件选你自己
   - 范围：添加 `https://www.googleapis.com/auth/gmail.modify`
   - 测试用户：**加上你自己的 Gmail 地址**（测试模式下只有测试用户能授权）
4. **API 和服务 → 凭据 → 创建凭据 → OAuth 客户端 ID**：
   - 应用类型选 **Web 应用**
   - 已获授权的重定向 URI，添加：
     ```
     https://win-8c09k6b093h.tail73fe40.ts.net/email/oauth/callback
     ```
     （服务器地址换了就改成对应的 `https://你的域名/email/oauth/callback`）
   - 创建后拿到 **Client ID** 和 **Client Secret**

## 二、工作台里填入（30 秒）

1. 打开工作台 → 邮件中心 → 配置 → 提供商选 **Gmail**
2. 展开「高级：Client ID 配置」，填入 Client ID + Secret，保存
3. 点「🔐 用 Google 账号授权绑定」，在弹出的 Google 页面点允许
4. 看到“授权成功”后关闭弹窗，账号旁显示 **OAuth 已连接（增量游标就绪）**

## 三、之后全自动

- 首次点「同步」/「入库」走**全量**（messages.list 分页 + 批量取），自动存 historyId
- 之后每次走**增量**（history.list，只拉新增/删除/已读变化），便宜 60%
- historyId 过期（7 天以上没同步）自动回全量，不用管
- 旧 IMAP 授权码方式仍然可用（新旧可并存），但 Gmail 推荐只用 OAuth

## 四、实时推送（可选，P3）

不配也能用（轮询兜底）。要秒级推送才需要：

1. GCP 项目开通 **Cloud Pub/Sub API**，建主题如 `projects/你的项目/topics/gmail`
2. 给 `gmail-api-push@system.gserviceaccount.com` 该主题的**发布者**权限
3. 建**推送订阅**，推送端点填：
   ```
   https://win-8c09k6b093h.tail73fe40.ts.net/email/push/hook?token=自定一串随机字符
   ```
4. 把同一串 token 配到服务端环境变量 `PUSH_SECRET`
5. 工作台调 `POST /email/gsync` 外，另调 `POST /email/push/watch/:accountId`（body 传 topicName），服务端每天自动续期

## 五、配额说明

- 全量 1.6 万封 ≈ 8 万单位（日额度十亿级，忽略不计）
- 增量一次 2 单位；服务端限并发 8/4，429 自动退避
- 遇到 `Gmail 授权失效` 提示 → 配置抽屉点账号旁「去授权」重绑一次即可
