# MelodyMail 实施计划

状态：已确认（2026-11-15）。M0 进行中，进度见 `docs/STATE.md`。风险等级：High（涉及登录与数据存储），按 `AGENTS.md`"Change risk"执行。

## 1. 目标

个人自用的邮箱服务，跑在 Cloudflare 开发者平台上。功能：用自有域名收信和发信，提供 Web 邮箱界面和 REST API。一次部署即可运行，无需自管服务器。

已定范围：

- 单用户，只有所有者一个账号。不开放注册，没有多租户、配额和计费，也没有共享邮箱。
- 发信只接 Resend。Cloudflare Email Service 以后需要时再加。
- 界面三语：简体中文（zh-CN）、英语（en）、日语（ja）。
- 前端设计系统用 Astryx（`@astryxdesign/core`）。
- 只有面板中添加的地址前缀能收信，其余拒收。
- 所有 Node 相关操作只用 Bun；wrangler 例外，在 Node 下运行。

不做：

- IMAP/POP3/SMTP 服务端：Workers 不能监听 TCP 端口，所以只能通过 Web 界面和 API 收发。
- 营销群发。

## 2. 技术选型

| 关注点 | 选型 | 理由 |
| --- | --- | --- |
| 运行平台 | 一个 Worker 同时提供 API 和静态前端（Workers Static Assets） | 单次部署，前后端同源 |
| 收信 | Email Routing catch-all → Email Worker（`email()` 处理器），只收面板中添加的前缀，其余拒收 | 原生能力；单封上限 25 MiB |
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
| 前端 | React 19 + Vite + Astryx；路由与数据请求（TanStack Router / Query）在 M4 引入 | Astryx 需要 React 19，提供预编译 CSS，Vite 下无需插件。开发时 Vite 把 `/api` 代理到 `wrangler dev`，比 Cloudflare Vite 插件少一层配置 |
| 样式 | 只用 Astryx 组件属性和主题 token，不引入自定义 CSS 文件，不用 Tailwind | Astryx 的规范（`web/ASTRYX.md`）和 `web/AGENTS.md` 都要求一套 token |
| i18n | 应用文案用 i18next + react-i18next，按语言懒加载；组件内置文案用 Astryx 自带的 zh-CN / ja-JP 语言包；`<html lang>` 随语言切换；`scripts/check-i18n.ts` 检查三种语言的 key 一致 | 中日共用汉字但字形不同，`lang` 属性决定浏览器选用哪种字形 |
| 测试 | Vitest + `@cloudflare/vitest-plugin`（原 `vitest-pool-workers` 已改名）；脚本测试用 `bun test`；Playwright 端到端在 M4 引入 | 测试跑在本地模拟的 D1、R2、Queues 上 |
| 包管理与运行时 | Bun（workspaces、脚本、测试运行）；所有 Node 相关操作只用 Bun，唯一例外是 wrangler 在 Node 下运行 | 负责人指定；wrangler 不支持 Bun 运行时 |

已知风险：

- Astryx 处于 Beta（0.4.x），API 可能变化。应对：固定版本号，升级时用 `astryx upgrade` 跑 codemod。
- Astryx 主题默认字体 Figtree 不含 CJK 字形。应对：字体栈追加系统 CJK 字体（中文用 PingFang SC / Microsoft YaHei，日文用 Hiragino Sans / Yu Gothic），不加载 CJK 网络字体。
- M0 验证结果（2026-11-15）：Vitest + `@cloudflare/vitest-plugin`、Vite、TypeScript、Biome 都能在 `bun --bun` 下运行；wrangler 命令行明确拒绝 Bun 运行时（"Wrangler does not support the Bun runtime"）。负责人决定（2026-11-15）：只有 wrangler 在 Node 下运行，由 `bun run` 不带 `--bun` 调用；其余仍全部用 Bun。类型检查已改用 `@cloudflare/workers-types`，不依赖 `wrangler types`。
- 改用 Resend 后可能不再需要 Workers Paid，但 Queues、Durable Objects、Rate Limiting 在 Free 计划下是否可用、额度多少，尚未核实，M0 时确认。

## 3. 架构

```text
入站：外部 MTA → Email Routing(catch-all) → email() 处理器
        ├─ 收件地址不在已添加的地址中，或该地址已停用 → setReject()，不落盘
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

地址模型：只有在面板中添加过的前缀才能收信，其他地址一律拒收（负责人 2026-11-15 决定）。

- 一个地址就是"前缀 + 域名"，如 `shop@example.com`；在面板中添加、停用或删除。
- 收信时按收件地址精确匹配，前缀不区分大小写。
- 子地址：`shop+github@example.com` 按 `shop` 匹配，标签记入邮件，方便筛选。这是默认行为，可以在设置中关闭。
- 已停用的地址拒收；拒收发生在落盘之前，被拒的邮件不占存储。
- Email Routing 仍配置为 catch-all 交给 Worker，因为由 Worker 判断收不收，比在 Cloudflare 面板逐条维护路由规则更方便，也不受每个域名 200 条规则的上限限制。

## 4. 目录结构

```text
MelodyMail/
├─ AGENTS.md  CLAUDE.md  REVIEW.md  REQUIREMENTS.md   规则包
├─ .github/AGENTS.md  .github/workflows/
├─ docs/PLAN.md
├─ scripts/
├─ packages/shared/     Zod schema、API 类型（前后端共用；M1 需要时再建）
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
- `addresses`：前缀、所属域名（两者联合唯一）、备注、是否启用、默认发件名、最近收信时间。
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
| M0 | 仓库骨架：Bun workspaces、wrangler 配置、Drizzle、Vitest、lint、Astryx 与 i18n 接入、CI 合并门禁；填写 `REQUIREMENTS.md` 的 Commands 行；核实各组件在 Free 计划下的可用性；核实 wrangler 和 `@cloudflare/vitest-pool-workers` 能在 Bun 下运行 | 本地与 CI 运行同一个 `bun run check` 并通过；空白页在三种语言和亮暗主题下都能渲染 |
| M1 | 认证：首次运行初始化所有者（凭 `SETUP_TOKEN` secret）、登录、Passkey、TOTP、会话、登录限流 | 集成测试：未登录访问每个端点都返回 401；初始化只能执行一次 |
| M2 | 域名与地址：添加域名、DNS 记录指引（MX、SPF、DKIM、DMARC）、添加 / 停用 / 删除地址（前缀 + 域名）、备注 | |
| M3 | 收信：email 处理器、R2 落盘、队列解析、附件、FTS 索引、未添加或已停用地址拒收 | 真实 `.eml` 样本：多种编码、大附件、畸形 MIME |
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
- Cloudflare 计划：先用 Workers Free，M3 实测收信解析的 CPU 后再决定是否升级（见第 9 节）。

## 9. 免费计划调研（2026-11-15）

来源：Cloudflare 各产品的 pricing 和 limits 文档页（页面更新于 2026-10-30 至 11-13）、resend.com/pricing。

| 组件 | 免费额度 | 对本项目 |
| --- | --- | --- |
| Workers | 每天 100,000 次请求；每次调用 10 ms CPU；每次调用 50 个子请求 | 请求量充足。10 ms CPU 是唯一的硬约束，见下文 |
| Email Routing / Email Worker | 免费计划可用；单封上限 25 MiB；收信处理器计入 Workers 的 CPU 和内存限制 | 可用 |
| D1 | 每天读 500 万行、写 10 万行；单库 500 MB，账号共 5 GB；每次调用最多 50 次查询；Time Travel 7 天 | 正文和附件必须放 R2，D1 只存元数据和 FTS 文本 |
| R2 | 每月 10 GB 存储、100 万次 A 类操作、1000 万次 B 类操作；出口流量免费 | 充足 |
| KV | 每天读 10 万次；写、删、列举各 1,000 次；1 GB | 只缓存设置，符合计划 |
| Queues | 每天 10,000 次操作（投递一条约 3 次，约 3,300 条/天）；消息保留 24 小时，不可配置；单条 128 KB | 够用；消息只放 R2 键，不放邮件内容 |
| Durable Objects | 只支持 SQLite 后端；每天 10 万次请求、13,000 GB-s 时长、写 10 万行 | 一个实例加 Hibernation API 够用；不用 Hibernation 会按连接时长持续计费 |
| Rate Limiting 绑定 | 官方文档没有写计划限制；社区答复说免费计划可用、无额外费用（未经官方确认）；窗口只能是 10 秒或 60 秒；按机房近似计数 | 只能作滥用防护；严格的登录锁定要用 D1 或 Durable Object 计数 |
| Cron Triggers | 每个账号 5 个 | 够用 |
| Resend Free | 每天 100 封、每月 3,000 封；3 个域名；1 个 Webhook 端点（全部事件）；数据保留 30 天 | 自用够用；Pro 为 20 美元/月 |

超出免费额度时，对应操作直接报错，不会自动扣费。

**主要风险：每次调用 10 ms CPU。** 文档写明队列消费者与其他 Worker 共用同一个单次调用 CPU 上限，所以解析放进队列也绕不开这个限制。CPU 时间只算主动计算，不算等待网络和存储。小邮件解析应该在限制内；带大附件的邮件需要做 base64 解码，可能超出（推测，尚未实测）。超出时这次调用失败。Workers Paid 起步 5 美元/月，默认每次 30 秒 CPU，可调到 5 分钟。

据此调整设计：

- `email()` 只做三件事：查地址、把原始邮件流式写入 R2、入队。不在这里解析。
- 队列消费者解析邮件。M3 用真实样本（大附件、多种编码）实测 CPU 时间：普通邮件超过 10 ms 就建议升级 Paid。
- 解析失败或队列消息过期（免费计划只保留 24 小时）不丢邮件：原始邮件已在 R2。Cron 定期把"已落盘未解析"的邮件重新入队。
- FTS 只索引正文的前一段文本，控制 D1 体积（单库 500 MB）。
