# MelodyMail 实施计划

状态：已确认（2026-11-15），下一步 M0。风险等级：High（涉及登录与数据存储），按 `AGENTS.md`"Change risk"执行。

## 1. 目标

个人自用的邮箱服务，跑在 Cloudflare 开发者平台上。功能：用自有域名收信和发信，提供 Web 邮箱界面和 REST API。一次部署即可运行，无需自管服务器。

已定范围：

- 单用户，只有所有者一个账号。不开放注册，没有多租户、配额和计费，也没有共享邮箱。
- 发信只接 Resend。Cloudflare Email Service 以后需要时再加。
- 界面三语：简体中文（zh-CN）、英语（en）、日语（ja）。
- 前端设计系统用 Astryx（`@astryxdesign/core`）。

不做：

- IMAP/POP3/SMTP 服务端：Workers 不能监听 TCP 端口，所以只能通过 Web 界面和 API 收发。
- 营销群发。

## 2. 技术选型

| 关注点 | 选型 | 理由 |
| --- | --- | --- |
| 运行平台 | 一个 Worker 同时提供 API 和静态前端（Workers Static Assets） | 单次部署，前后端同源 |
| 收信 | Email Routing catch-all → Email Worker（`email()` 处理器） | 原生能力；单封上限 25 MiB |
| 发信 | Resend API，用 Resend Webhook（Svix 签名）回写投递状态 | 已确认先只接 Resend；用一个 `sendMail()` 模块，不预先抽象多提供方 |
| 数据库 | D1 + Drizzle ORM + FTS5 全文搜索 | D1 支持 FTS5；Drizzle 管理迁移与类型 |
| 缓存 | KV，只缓存设置和域名表 | KV 最终一致，不用于会话和计数 |
| 限流 | Workers Rate Limiting 绑定（登录、发信、API） | 防止凭据泄露后被滥用 |
| 文件 | R2：原始 `.eml` 和附件 | 无出口费用 |
| 异步任务 | Queues：收信解析、发信重试 | 收信处理器只做落盘和入队；解析失败可以重试 |
| 实时推送 | 一个 Durable Object（WebSocket Hibernation） | 新邮件即时通知；单用户只需一个实例 |
| 定时任务 | Cron Triggers | 清理垃圾箱、回收 R2 孤儿对象 |
| 后端框架 | Hono + Zod + OpenAPI 生成 | 体积小，Workers 原生支持 |
| 认证 | Better Auth（D1 存储）：密码、Passkey、TOTP；API Key 供脚本使用 | 不自己写密码和会话逻辑 |
| 前端 | React 19 + Vite（`@cloudflare/vite-plugin`）+ TanStack Router / Query + Astryx | Astryx 需要 React 19，提供预编译 CSS，Vite 下无需插件 |
| 样式 | Astryx 主题 token，加上 CSS Modules 补少量自定义样式；不用 Tailwind | `web/AGENTS.md` 要求一套 token，避免两套设计系统并存 |
| i18n | i18next + react-i18next，按语言懒加载；`<html lang>` 随语言切换 | 中日共用汉字但字形不同，`lang` 属性决定浏览器选用哪种字形 |
| 测试 | Vitest + `@cloudflare/vitest-pool-workers`；Playwright 端到端 | 测试跑在本地模拟的 D1、R2、Queues 上 |
| 包管理 | pnpm workspaces | |

已知风险：

- Astryx 处于 Beta（0.4.x），API 可能变化。应对：固定版本号，升级时用 `astryx upgrade` 跑 codemod。
- Astryx 主题默认字体 Figtree 不含 CJK 字形。应对：字体栈追加系统 CJK 字体（中文用 PingFang SC / Microsoft YaHei，日文用 Hiragino Sans / Yu Gothic），不加载 CJK 网络字体。
- 改用 Resend 后可能不再需要 Workers Paid，但 Queues、Durable Objects、Rate Limiting 在 Free 计划下是否可用、额度多少，尚未核实，M0 时确认。

## 3. 架构

```text
入站：外部 MTA → Email Routing(catch-all) → email() 处理器
        ├─ 收件地址在屏蔽列表 → setReject()
        ├─ 原始邮件写入 R2  raw/{yyyy}/{mm}/{id}.eml
        └─ 投递 Queue: inbound
      inbound 消费者 → postal-mime 解析 → 附件写 R2 → D1 写 messages / attachments / FTS
        → 匹配规则（转发、标记） → Durable Object 推送到在线页面

出站：Web/API → POST /api/messages/send（带幂等键）→ D1 记录 status=queued → Queue: outbound
      outbound 消费者 → Resend API → 写 sent / 按退避重试，最终 failed
      Resend Webhook → POST /api/webhooks/resend（验签，公开端点）→ 更新 delivered / bounced

前端：浏览器 → 同一 Worker
        /api/*  → Hono 路由（run_worker_first）
        其余    → 静态资源（SPA 回退）
```

地址模型：catch-all 意味着域名下任何地址都能收信。某个地址第一次收到邮件时自动记下，之后可以给它设备注、设屏蔽、设规则。这样就不需要"临时邮箱"功能，泄露的地址直接屏蔽即可。

## 4. 目录结构

```text
MelodyMail/
├─ AGENTS.md  CLAUDE.md  REVIEW.md  REQUIREMENTS.md   规则包
├─ .github/AGENTS.md  .github/workflows/
├─ docs/PLAN.md
├─ scripts/
├─ packages/shared/     Zod schema、API 类型（前后端共用）
├─ worker/
│  ├─ wrangler.jsonc
│  ├─ migrations/
│  └─ src/
│     ├─ index.ts       fetch / email / queue / scheduled 入口
│     ├─ routes/        auth, addresses, messages, domains, rules, keys, settings, webhooks
│     ├─ mail/          inbound.ts（解析）、send.ts（Resend）
│     ├─ db/            Drizzle schema
│     ├─ do/            Hub Durable Object
│     └─ lib/           鉴权中间件、限流、R2 签名 URL、日志
└─ web/
   └─ src/  routes/  components/  locales/{zh-CN,en,ja}/
```

## 5. 数据模型（D1，初稿）

- `user`、`session`、`account`、`passkey`、`two_factor`：由 Better Auth 管理，表中只会有所有者一行。
- `domains`：域名、收信开关、发信开关、Resend 域名验证状态。
- `addresses`：地址、所属域名、备注、是否屏蔽、默认发件名、首次 / 最近收信时间。
- `messages`：地址、方向（in/out）、Message-ID、线程键、发件人、收件人、主题、摘要、大小、标志（已读、星标、归档、垃圾箱）、R2 原始对象键、出站状态（queued/sent/delivered/bounced/failed）、幂等键。
- `messages_fts`：FTS5 虚表，索引主题、发件人、正文文本。
- `attachments`：消息、文件名、MIME、大小、R2 键、Content-ID。
- `rules`：条件（地址、发件人、主题）→ 动作（转发、标记、归档、删除）。
- `api_keys`：只存哈希和前缀。
- `settings`：系统设置，读取时经 KV 缓存。
- `audit_log`：登录与敏感操作。

## 6. 里程碑

每个里程碑结束时：门禁全绿，更新 `REQUIREMENTS.md` 对应行，提交。

| 编号 | 内容 | 验证 |
| --- | --- | --- |
| M0 | 仓库骨架：pnpm workspace、wrangler 配置、Drizzle、Vitest、lint、Astryx 与 i18n 接入、CI 合并门禁；填写 `REQUIREMENTS.md` 的 Commands 行；核实各组件在 Free 计划下的可用性 | 本地与 CI 运行同一个 `pnpm check` 并通过；空白页在三种语言和亮暗主题下都能渲染 |
| M1 | 认证：首次运行初始化所有者（凭 `SETUP_TOKEN` secret）、登录、Passkey、TOTP、会话、登录限流 | 集成测试：未登录访问每个端点都返回 401；初始化只能执行一次 |
| M2 | 域名与地址：添加域名、DNS 记录指引（MX、SPF、DKIM、DMARC）、地址列表、备注、屏蔽 | |
| M3 | 收信：email 处理器、R2 落盘、队列解析、附件、FTS 索引、屏蔽地址拒收 | 真实 `.eml` 样本：多种编码、大附件、畸形 MIME |
| M4 | Web 邮箱：收件箱、会话线程、阅读（HTML 放进沙箱 iframe，默认拦截远程图片）、搜索、标记、实时推送 | Playwright 截图：手机和桌面宽度、亮暗主题、三种语言 |
| M5 | 发信：撰写、回复 / 转发（线程头）、附件、草稿、出站队列与重试、Resend Webhook 状态回写 | 重复提交和并发提交都只发出一封（幂等键） |
| M6 | 规则与 API：收信规则、REST API + API Key、OpenAPI 文档 | |
| M7 | 运维：Cron 清理、备份（D1 Time Travel + 定期导出到 R2）与恢复手册、部署文档、README（中英日） | 在空白 Cloudflare 账号上按 README 从零部署一遍 |

## 7. 安全要点

- 收到的 HTML 邮件只在 `sandbox` iframe 中渲染，配合严格 CSP；远程图片默认不加载。
- API Key 只存哈希；Resend API Key 和 Webhook 签名密钥放在 Worker secret 中；任何密钥都不进日志。
- 所有端点默认要求授权。公开端点只有两个：Resend Webhook（验签）和首次初始化（凭 `SETUP_TOKEN`，执行一次后失效）。
- 可选加固：在 Web 界面路径前加一层 Cloudflare Access，`/api/webhooks/*` 不经过 Access。
- 附件下载使用短时效签名 URL。

## 8. 前置条件

- 域名托管在 Cloudflare DNS，并启用 Email Routing。
- Resend 账号，发信域名在 Resend 完成验证，准备好 API Key。
- Cloudflare 计划：M0 核实后确定。
