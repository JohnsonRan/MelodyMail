# MelodyMail 实施计划

状态：草案，待负责人确认（见文末"待确认问题"）。风险等级：High（涉及登录、发信信誉与数据存储），按 `AGENTS.md`"Change risk"先评审计划再编码。

## 1. 目标

基于 Cloudflare 开发者平台的一站式邮箱服务：自有域名收信、发信、Web 邮箱界面、REST API 与管理后台，一次部署即可运行，无需自管服务器。

不做（平台限制或超出范围）：

- IMAP/POP3/SMTP 服务端。Workers 不能监听 TCP 端口，客户端只能用 Web 界面或 API。
- 营销群发。Cloudflare Email Sending 只用于事务性邮件，群发需走 Resend 等第三方并遵守退订要求。

## 2. 技术选型

| 关注点 | 原定 | 计划采用 | 理由 |
| --- | --- | --- | --- |
| 运行平台 | Workers | Workers（一个 Worker 同时提供 API 与静态前端） | Workers Static Assets 取代 Pages，单次部署 |
| 收信 | 未定 | Email Routing → Email Worker（`email()` 处理器），catch-all 规则 | 原生，免费计划可用；单封上限 25 MiB |
| 发信 | Cloudflare Email / Resend | Cloudflare Email Service（`send_email` 绑定）为主，Resend 为备，统一 `MailSender` 接口 | Email Sending 目前为 Beta，需 Workers Paid；任意收件人需先接入发信域名；单封 50 收件人、25 MiB |
| 数据库 | D1 | D1 + Drizzle ORM + FTS5 全文搜索 | D1 支持 FTS5；Drizzle 管理迁移与类型 |
| 缓存 | KV | KV 只缓存读多写少的配置（域名表、系统设置） | KV 最终一致，不适合会话和计数 |
| 限流 | 无 | Workers Rate Limiting 绑定 | 强一致计数，替代用 KV 做限流 |
| 文件 | R2 | R2 存原始 `.eml` 与附件，下载走签名 URL | 无出口费用 |
| 异步任务 | 无 | Cloudflare Queues：收信解析、发信重试、Webhook 投递 | 收信处理器只做落盘与入队，解析失败可重试 |
| 实时推送 | 无 | Durable Objects（WebSocket Hibernation），每用户一个 | 新邮件即时通知，空闲不计费 |
| 定时任务 | 无 | Cron Triggers | 清理过期临时邮箱、回收 R2 孤儿对象 |
| 后端框架 | 无 | Hono + Zod 校验 + OpenAPI 生成 | 体积小，Workers 原生 |
| 认证 | 无 | Better Auth（D1 存储）：密码、Passkey、TOTP 两步验证；API Key；Turnstile 防注册滥用 | 现成实现，不自写密码与会话逻辑 |
| 前端 | 无 | React + Vite（`@cloudflare/vite-plugin`）+ TanStack Router/Query + Tailwind CSS + shadcn/ui + i18n（zh-CN / en） | 与 Worker 同仓构建、同源部署 |
| 测试 | 无 | Vitest + `@cloudflare/vitest-pool-workers`（真实 D1/R2/Queues 本地模拟）、Playwright 端到端 | 符合 `worker/AGENTS.md`"Verification" |
| 包管理 | 无 | pnpm workspaces | |

## 3. 架构

```text
入站：外部 MTA → Email Routing(catch-all) → email() 处理器
        ├─ 校验收件地址存在、配额未超 → 否则 setReject()
        ├─ 原始邮件写入 R2  raw/{yyyy}/{mm}/{id}.eml
        └─ 投递 Queue: inbound-parse
      inbound-parse 消费者 → postal-mime 解析 → 附件写 R2 → D1 写 messages/attachments/FTS
        → 转发规则 / Webhook（Queue: webhooks） → Durable Object 推送到在线客户端

出站：Web/API → POST /api/messages/send → D1 记录 outbox(queued) → Queue: outbound
      outbound 消费者 → MailSender(Cloudflare | Resend) → 成功写 sent / 失败按退避重试，最终 failed

前端：浏览器 → 同一 Worker
        /api/*  → Hono 路由（run_worker_first）
        其余    → 静态资源（SPA 回退）
```

## 4. 目录结构

```text
MelodyMail/
├─ AGENTS.md  CLAUDE.md  REVIEW.md  REQUIREMENTS.md   规则包（已就位）
├─ .github/AGENTS.md  .github/workflows/              CI
├─ docs/PLAN.md                                       本文件
├─ scripts/check-requirements.py  test_check_requirements.py
├─ packages/shared/     Zod schema、API 类型、常量（前后端共用）
├─ worker/              后端 Worker
│  ├─ wrangler.jsonc
│  ├─ migrations/       D1 迁移（Drizzle 生成）
│  └─ src/
│     ├─ index.ts       fetch / email / queue / scheduled 入口
│     ├─ routes/        auth, mailboxes, messages, domains, keys, webhooks, admin
│     ├─ mail/          inbound 解析、MailSender 接口及 cloudflare / resend 实现
│     ├─ db/            Drizzle schema 与查询
│     ├─ do/            UserHub Durable Object
│     └─ lib/           鉴权中间件、限流、R2 签名 URL、日志
└─ web/                 前端 SPA
   └─ src/  routes/  components/  locales/
```

## 5. 数据模型（D1，初稿）

- `users`、`sessions`、`accounts`、`passkeys`：Better Auth 管理。
- `domains`：域名、收信开关、发信开关、发信提供方、DNS 校验状态。
- `mailboxes`：地址、所属用户、类型（永久 / 临时）、过期时间、配额。
- `aliases`：别名到邮箱的映射，含通配。
- `messages`：邮箱、方向（in/out）、Message-ID、线程键、发件人、收件人、主题、摘要、大小、标志（已读、星标、删除）、R2 原始对象键、状态（queued/sent/failed，出站用）。
- `messages_fts`：FTS5 虚表（主题、发件人、正文文本）。
- `attachments`：消息、文件名、MIME、大小、R2 键、Content-ID。
- `rules`：转发、自动标记、Webhook 触发条件。
- `api_keys`：只存哈希与前缀，带作用域。
- `webhooks`、`webhook_deliveries`：目标 URL、签名密钥（加密存储）、投递记录。
- `settings`：系统设置，读取经 KV 缓存。
- `audit_log`：管理操作与登录事件。

## 6. 里程碑

每个里程碑结束时：门禁全绿、更新 `REQUIREMENTS.md` 对应行、提交。

| 编号 | 内容 | 验证 |
| --- | --- | --- |
| M0 | 仓库骨架：pnpm workspace、wrangler 配置、Drizzle、Vitest、lint、CI 合并门禁、填写 `REQUIREMENTS.md` 的 Commands 行 | `pnpm check` 本地与 CI 一致通过 |
| M1 | 认证：注册（Turnstile）、登录、Passkey、TOTP、会话、管理员初始化 | 集成测试覆盖越权与账号枚举 |
| M2 | 域名与邮箱：添加域名、DNS 记录指引与校验、创建永久 / 临时邮箱、别名 | 授权测试：每个端点以错误角色调用 |
| M3 | 收信：email 处理器、R2 落盘、队列解析、附件、FTS 索引、拒收未知地址 | 用真实 `.eml` 样本（含编码、超大附件、畸形 MIME）跑本地队列 |
| M4 | Web 邮箱：收件箱、阅读（HTML 沙箱化 iframe、远程图片默认拦截）、搜索、标记、删除、实时推送 | Playwright 截图：手机与桌面宽度、亮暗主题 |
| M5 | 发信：撰写、回复 / 转发（线程头）、附件、草稿、出站队列与重试、Cloudflare / Resend 切换 | 重复提交与并发提交只发一次（幂等键） |
| M6 | 开放能力：REST API + API Key、OpenAPI 文档、Webhook（HMAC 签名、重试） | Webhook 重放与乱序测试 |
| M7 | 管理后台：用户、域名、配额、发信提供方、系统设置、审计日志 | |
| M8 | 运维：Cron 清理、备份（D1 Time Travel + 导出到 R2）与恢复手册、部署文档、README | 在空账号上按 README 从零部署一遍 |

## 7. 安全要点

- 收到的 HTML 邮件只在 `sandbox` iframe 中渲染，配合严格 CSP；远程图片默认不加载。
- API Key、Webhook 密钥只存哈希或加密值；任何密钥不进日志（`AGENTS.md`"Secrets"）。
- 所有端点默认要求授权，公开端点在路由定义处显式标记（`worker/AGENTS.md#authz`）。
- 发信按用户限流并记录，防止账号被盗后群发拖垮域名信誉。
- 附件下载使用短时效签名 URL，校验归属。

## 8. 前置条件

- 域名托管在 Cloudflare DNS（Email Service 的硬性要求）。
- Workers Paid 计划（Email Sending 发往任意收件人需要；Queues、Durable Objects 也建议付费计划）。
- 可选：Resend 账号与 API Key（备用发信）。

## 9. 待确认问题

1. 产品定位：个人 / 团队自用的完整邮箱，多租户 SaaS，还是以临时邮箱为主？影响注册策略、配额与计费设计。
2. 是否已有 Workers Paid 计划？没有的话 M5 发信先只接 Resend。
3. 首期支持的界面语言：仅简体中文，还是中英双语？
4. 是否需要多用户共享邮箱（如 support@ 由多人处理）？需要则数据模型加入成员关系。
5. 提交签名：全局已配置 SSH 签名，沿用即可，请确认。
