# 旧笔记本变身同步服务器指南（零成本）

> 硬件要求：能开机、能联网即可。功耗 10-30W，电费忽略不计。

## 第 0 步：笔记本基础环境

1. 安装 **Node.js LTS**（https://nodejs.org 下载 windows 安装包）
2. 安装 **MySQL Community Server**（https://dev.mysql.com/downloads/installer/）
   - 安装时记住 root 密码
   - 用命令建库：`mysql -u root -p -e "CREATE DATABASE evan_sync CHARACTER SET utf8mb4"`
3. 把本项目的 `server/` 文件夹整个拷贝到笔记本，比如 `D:\evan-server\`
4. 启动测试：
   ```bash
   cd /d D:\evan-server
   npm i
   set SECRET=换成一长串随机字符abc123xyz789
   set DB_PASS=你的MySQL密码
   node server.mjs
   ```
   看到 `[sync-server] listening on :3000` 即成功。Ctrl+C 退出。

## 第 1 步：让笔记本常驻运行（三选一）

- **最简单**：电源设置改为「接通电源时永不睡眠」，保持命令行窗口开着
- **推荐**：用 [NSSM](https://nssm.cc) 把 server.mjs 注册成 Windows 服务（开机自启、崩溃自动重启）
  ```bash
  nssm install EvanSync "C:\Program Files\nodejs\node.exe" "D:\evan-server\server.mjs"
  nssm set EvanSync AppEnvironmentExtra SECRET=你的随机串 DB_PASS=你的密码
  nssm start EvanSync
  ```
- 备选：`npm i -g pm2` 后 `pm2 start server.mjs --name evan-sync`

## 第 2 步：网络穿透（二选一）

### 方案 A：Tailscale（零域名，5 分钟跑通）

1. 笔记本和**所有手机/电脑**都安装 Tailscale（https://tailscale.com），用同一账号登录
2. 笔记本上开启 HTTPS 服务（自动签发有效证书）：
   ```bash
   tailscale serve --bg 3000
   ```
   得到形如 `https://笔记本名.tailXXXX.ts.net` 的地址
3. 各设备打开 Evan OS → ☁️ 云同步 → 服务器地址填该 HTTPS 地址 → 登录 → 同步

> 优点：不暴露公网，只有你的设备能连。缺点：新设备需装 Tailscale App。

### 方案 B：Cloudflare Tunnel（公网网址，手机免装 App）

1. 需要一个域名（任何注册商，接入 Cloudflare DNS）
2. 笔记本安装 cloudflared：
   ```bash
   winget install Cloudflare.cloudflared
   cloudflared tunnel login
   cloudflared tunnel create evan-sync
   cloudflared tunnel route dns evan-sync sync.你的域名.com
   cloudflared tunnel run evan-sync
   ```
3. 云同步页服务器地址填 `https://sync.你的域名.com`

> 临时试用可先跑快速隧道（无需域名，重启换址）：
> `cloudflared tunnel --url http://localhost:3000`

## 第 3 步：验证

1. 笔记本浏览器打开 `http://localhost:3000/changes` → 应返回 401（未登录），说明服务活着
2. 手机开流量（不连 WiFi）打开 Evan OS → 云同步 → 登录 → 立即同步
3. 两台设备各改一条数据 → 双方同步 → 数据一致 ✅

## 常见问题

| 问题 | 处理 |
|------|------|
| 页面是 HTTPS 但请求被拦截 | 服务器必须是 HTTPS（用上面 tailscale serve / CF Tunnel 即可） |
| 笔记本重启后服务没了 | 用 NSSM 注册为服务，或把启动命令放入「启动」文件夹 |
| MySQL 服务没随开机启动 | services.msc 里把 MySQL80 设为自动 |
| 想省电 | 同步是手动的，笔记本不必 24 小时开机——开机后各设备点一次同步即可 |

## 安全提醒

- `SECRET` 换成 32 位以上随机串（令牌签名密钥）
- 不要把 SECRET / DB_PASS 提交进 GitHub（server/.gitignore 已排除 .env）
- CF Tunnel 方案建议把 CORS 白名单从 `*` 改成你的 Pages 域名（server.mjs 内注释处）
