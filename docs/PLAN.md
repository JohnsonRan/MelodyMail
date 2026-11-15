# MelodyMail 实施计划

状态：已确认（2026-11-15）。M0 已完成，下一步 M1，进度见 `docs/STATE.md`。风险等级：High（涉及登录与数据存储），按 `AGENTS.md`"Change risk"执行。

## 1. 目标

个人自用的邮箱服务，跑在 Cloudflare 开发者平台上。功能：用自有域名收信和发信，提供 Web 邮箱界面和 REST API。一次部署即可运行，无需自管服务器。

已定范围（负责人 2026-11-15 决定）：

- 单用户，只有所有者一个账号。不开放注册，没有多租户、配额和计费，也没有共享邮箱。
- 只用 Cloudflare Workers Free 计划，暂不考虑 Paid。所有设计都要能在免费额度内运行，约束见第 2 节。
- 发信只接 Resend（免费版）。
- 界面三语：简体中文（zh-CN）、英语（en）、日语（ja-JP）。
- 前端设计系统用 Astryx（`@astryxdesign/core`）。
- 只有面板中添加的地址前缀能收信，其余拒收。
- 所有 Node 相关操作只用 Bun；wrangler 例外，在 Node 下运行。

不做：

- IMAP/POP3/SMTP 服务端：Workers 不能监听 TCP 端口，所以只能通过 Web 界面和 API 收发。
- 营销群发。

## 2. 免费计划约束

调研日期 2026-11-15，来源是 Cloudflare 各产品的 pricing / limits 文档页和 resend.com/pricing。超出免费额度时，对应操作直接报错，不会自动扣费。

| 组件 | 免费额度 | 设计上的应对 |
| --- | --- | --- |
| Workers | 每天 100,000 次请求；**每次调用 10 ms CPU**；每次调用 50 个子请求；静态资源请求免费且不限量 | 见下文"CPU 预算" |
| Email Routing / Email Worker | 可用；单封上限 25 MiB；收信处理器计入 Workers 的 CPU 和内存限制 | `email()` 只做查地址、落盘、入队 |
| D1 | 每天读 500 万行、写 10 万行；单库 500 MB；每次调用最多 50 次查询 | 正文和附件不进 D1；FTS 只索引正文开头；列表用索引和游标分页 |
| R2 | 每月 10 GB、100 万次 A 类、1000 万次 B 类操作；出口免费 | 原始邮件、发件副本、待发附件都在 R2 |
| KV | 每天写 1,000 次 | 只缓存设置 |
| Queues | 每天 10,000 次操作（约 3,300 条消息）；保留 24 小时；单条 128 KB | 只用于收信；消息只放 R2 键 |
| Durable Objects | 只支持 SQLite 后端；每天 10 万次请求、13,000 GB-s | 一个实例，必须用 Hibernation API |
| Rate Limiting 绑定 | 文档没写计划限制，社区答复说免费可用（未经官方确认）；窗口 10 秒或 60 秒；按机房近似计数 | 只作滥用防护；严格的登录锁定在 D1 里计数 |
| Cron Triggers | 每个账号 5 个 | 用一个触发器，按时间分派任务 |
| Resend Free | 每天 100 封、每月 3,000 封；3 个域名；1 个 Webhook 端点；保留 30 天；附件可用 URL（`path`）传入；支持 `Idempotency-Key`（24 小时） | 发信限额在界面上显示 |

### CPU 预算

每次调用只有 10 ms CPU，队列消费者也一样。CPU 只算主动计算，不算等待网络和存储。原生流式管道（例如把 R2 对象直接作为响应体返回）几乎不占 JS CPU。由此定下四条规则：

1. **Worker 不做与邮件大小成正比的 JS 计算。** 不解码附件，不在服务端完整解析大邮件，不在服务端清洗 HTML。
2. **重活交给浏览器。** 打开邮件时，Worker 把 R2 里的原始 `.eml` 原样流给浏览器；浏览器在 Web Worker 里用 postal-mime 解析，正文放进沙箱 iframe 渲染，附件在浏览器里生成文件下载。
3. **服务端只做有上限的解析。** 队列消费者只读原始邮件的前 256 KB（R2 范围读取），提取头部、摘要、搜索用的正文文本和"有无附件"标记。工作量有上限，与邮件总大小无关。
4. **登录不用慢哈希。** 用户自设密码必须用 scrypt、PBKDF2 这类故意很慢的哈希，单次就会超过 10 ms。所以不设密码：主登录方式用 Passkey（验签是原生 ECDSA，开销很小）；备用方式是系统生成的 128 位恢复密钥加 TOTP。恢复密钥熵足够高，存 SHA-256 即可，不需要慢哈希。

CPU 无法在 workerd 测试里直接测量：workerd 为防侧信道攻击，计算期间 `performance.now()` 不前进。改用两种方式：

- 本地用 Bun 跑同一套解析代码作基准，单封预算 3 ms（为云端较慢的 CPU 留出约 3 倍余量）。
- 部署后查看 Workers Logs 记录的每次调用 `cpuTime`。

## 3. 技术选型

| 关注点 | 选型 | 理由 |
| --- | --- | --- |
| 运行平台 | 一个 Worker 同时提供 API 和静态前端（Workers Static Assets） | 单次部署，前后端同源 |
| 收信 | Email Routing catch-all → `email()`，只收面板中添加的前缀 | 原生能力 |
| 发信 | Resend API，在请求内同步调用，带 `Idempotency-Key`；附件以签名 URL 交给 Resend 拉取 | 一次 fetch，几乎不占 CPU；Worker 不做 base64 编码；失败时界面提示并可重试，不需要出站队列 |
| 投递状态 | Resend Webhook（Svix 签名，原生 HMAC 校验） | 免费版有 1 个端点 |
| 数据库 | D1 + Drizzle ORM + FTS5 | 搜索在 D1 侧执行，不占 Worker CPU |
| 缓存 | KV，只缓存设置 | 免费版每天只能写 1,000 次 |
| 限流 | Rate Limiting 绑定防滥用；登录失败计数放 D1 | 绑定是近似计数 |
| 文件 | R2 | 出口免费 |
| 异步任务 | Queues，只用于收信解析 | 隔离解析失败，可重试 |
| 实时推送 | 一个 Durable Object（WebSocket Hibernation） | 空闲不计时长 |
| 定时任务 | 一个 Cron Trigger | 重新入队未解析邮件、清空回收站、回收 R2 孤儿对象 |
| 后端框架 | Hono + Zod | 体积小 |
| 认证 | 自建精简认证：`@simplewebauthn/server`（Passkey）、TOTP（Web Crypto HMAC）、会话令牌（256 位随机数，D1 只存 SHA-256），Cookie 设 `HttpOnly; Secure; SameSite=Strict` | Better Auth 默认用 scrypt 处理密码，体积也大；单用户只需这几样，且都基于成熟库或原生密码学 |
| 前端 | React 19 + Vite + Astryx；TanStack Router / Query 在 M4 引入；postal-mime 在浏览器的 Web Worker 中运行 | 解析放在浏览器，见 CPU 预算 |
| 样式 | 只用 Astryx 组件属性和主题 token | `web/ASTRYX.md`、`web/AGENTS.md` |
| i18n | i18next 按语言懒加载；Astryx 自带 zh-CN / ja-JP 组件文案；`scripts/check-i18n.ts` 检查 key 一致 | |
| 测试 | Vitest + `@cloudflare/vitest-plugin`；`bun test` 跑脚本测试和解析基准；Playwright 在 M4 引入 | |
| 包管理与运行时 | Bun；wrangler 在 Node 下运行 | 负责人决定 |

已知风险：

- Astryx 处于 Beta（0.7.x），API 可能变化。应对：固定版本号，升级时用 `astryx upgrade` 跑 codemod。
- 打开大邮件要下载整封原始邮件。Worker 只做流式转发，不占 CPU，但浏览器要下载全部字节。界面在打开前显示邮件大小。
- 浏览器端解析依赖 JS。不支持 JS 的客户端无法阅读邮件；自用场景可接受。
- 中日文字体：Windows 上系统回退字体显示正常；macOS、iOS、Android 尚未验证。

## 4. 架构

```text
入站：外部 MTA → Email Routing(catch-all) → email()
        ├─ 地址未添加或已停用 → setReject()，不落盘
        ├─ 原始邮件流式写入 R2  raw/{yyyy}/{mm}/{id}.eml（原生管道）
        ├─ D1 写一行 status=stored
        └─ Queue: inbound（只放 id）
      inbound 消费者 → R2 范围读取前 256 KB → 有上限的解析
        → D1 写头部、摘要、FTS 文本、has_attachments，status=parsed
        → 匹配规则 → Durable Object 通知在线页面
      Cron → 把 status=stored 超过 15 分钟的邮件重新入队（防止队列消息 24 小时过期后丢失）

阅读：浏览器 → GET /api/messages/:id/raw → Worker 鉴权后把 R2 对象体直接作为响应返回
      浏览器 Web Worker 用 postal-mime 解析 → 正文进沙箱 iframe，附件生成 Blob 下载

出站：浏览器上传附件 → PUT /api/uploads → Worker 把请求体直接写入 R2（原生管道）
      POST /api/messages/send（带幂等键）→ D1 记录 → 调用 Resend
        （附件以带 HMAC 签名、1 小时有效的 URL 传入 `path`，Resend 自行拉取）
        → 成功写 sent，失败写 failed 并在界面上可重试（同一幂等键，不会重复发出）
      发件副本（收件人、主题、正文 JSON、附件 R2 键）存入 R2
      Resend Webhook → POST /api/webhooks/resend（验签）→ 更新 delivered / bounced

前端：/api/* → Hono 路由；其余 → 静态资源（SPA 回退）
```

地址模型（负责人 2026-11-15 决定）：

- 一个地址就是"前缀 + 域名"，如 `shop@example.com`，在面板中添加、停用或删除。
- 只有添加过的地址能收信，其他一律拒收；拒收发生在落盘之前。
- 前缀不区分大小写。
- 子地址：`shop+github@example.com` 默认按 `shop` 匹配，标签记入邮件；可在设置中关闭。
- Email Routing 配置为 catch-all 交给 Worker，由 Worker 判断收不收，不受每个域名 200 条规则的上限限制。

## 5. 目录结构

```text
MelodyMail/
├─ AGENTS.md  CLAUDE.md  REVIEW.md  REQUIREMENTS.md   规则包
├─ .github/AGENTS.md  .github/workflows/
├─ docs/PLAN.md  docs/STATE.md
├─ scripts/                 门禁脚本、解析基准
├─ worker/
│  ├─ wrangler.jsonc
│  ├─ migrations/
│  └─ src/
│     ├─ index.ts           fetch / email / queue / scheduled 入口
│     ├─ routes/            auth, addresses, messages, uploads, domains, rules, keys, settings, webhooks
│     ├─ mail/              store.ts（落盘）、headers.ts（有上限的解析）、send.ts（Resend）
│     ├─ auth/              passkey, totp, recovery, session
│     ├─ db/                Drizzle schema
│     ├─ do/                Hub Durable Object
│     └─ lib/               鉴权中间件、限流、签名 URL、日志
└─ web/
   └─ src/  routes/  components/  mail/（postal-mime Web Worker）  locales/{zh-CN,en,ja-JP}/
```

共享的 Zod schema 等到前后端都需要时，再建 `packages/shared/`。

## 6. 数据模型（D1，初稿）

- `owner`：只有一行。TOTP 密钥、恢复密钥哈希、创建时间。
- `passkeys`：凭据 ID、公钥、签名计数、设备备注。
- `sessions`：令牌哈希、创建 / 过期时间、最近活动、User-Agent 摘要。
- `login_attempts`：按时间窗口记录失败次数，用于锁定。
- `domains`：域名、收信开关、发信开关、Resend 域名验证状态。
- `addresses`：前缀、所属域名（两者联合唯一）、备注、是否启用、默认发件名、最近收信时间。
- `messages`：地址、方向（in/out）、状态（stored/parsed/sent/delivered/bounced/failed）、Message-ID、线程键、发件人、收件人、主题、摘要、大小、has_attachments、标志（已读、星标、归档、回收站）、R2 键、子地址标签、幂等键。
- `messages_fts`：FTS5 虚表，索引主题、发件人、正文开头的文本（上限 8 KB）。
- `uploads`：待发附件的 R2 键、文件名、MIME、大小、过期时间。
- `rules`：条件（地址、发件人、主题）→ 动作（标记、归档、删除）。不做自动转发：Email Routing 的 `forward()` 只能发往已验证地址；改走 Resend 又会占用每天 100 封的额度。
- `api_keys`：只存哈希和前缀。
- `settings`：系统设置，读取时经 KV 缓存。
- `audit_log`：登录与敏感操作。

## 7. 里程碑

每个里程碑结束时：门禁全绿，更新 `REQUIREMENTS.md` 对应行，提交并推送，CI 通过。

| 编号 | 内容 | 验证 |
| --- | --- | --- |
| M0 | 仓库骨架、门禁、CI、Astryx 与三语外框、免费计划调研 | 已完成（2026-11-15） |
| M1 | 认证：首次运行凭 `SETUP_TOKEN` 初始化所有者并注册第一个 Passkey；Passkey 登录；恢复密钥 + TOTP 备用登录；会话；登录失败锁定（D1）与限流绑定 | 集成测试：未登录访问每个非公开端点都返回 401；初始化只能执行一次；锁定后有恢复途径。Bun 基准：每个认证请求的 JS 计算低于预算 |
| M2 | 域名与地址：添加域名、DNS 记录指引（MX、SPF、DKIM、DMARC）、添加 / 停用 / 删除地址、备注 | |
| M3 | 收信：`email()` 落盘与拒收、队列、有上限的解析、FTS、Cron 重新入队 | 真实 `.eml` 样本（多种编码、25 MiB 大附件、畸形 MIME）：解析基准每封低于 3 ms；未添加的地址拒收且不落盘 |
| M4 | Web 邮箱：列表、会话线程、浏览器端解析与阅读（沙箱 iframe，默认拦截远程图片）、附件下载、搜索、标记、实时推送 | Playwright 截图：手机和桌面宽度、亮暗主题、三种语言 |
| M5 | 发信：撰写、回复 / 转发（线程头）、附件上传、草稿、幂等发送、Resend Webhook、发信额度显示 | 重复提交和并发提交都只发出一封 |
| M6 | 规则与 API：收信规则、REST API + API Key、OpenAPI 文档 | |
| M7 | 运维：备份（D1 Time Travel 7 天 + 定期导出到 R2）与恢复手册、部署文档、README（中英日） | 在空白 Cloudflare 账号上按 README 从零部署一遍 |

## 8. 安全要点

- 收到的 HTML 邮件只在 `sandbox` iframe 中渲染（不允许脚本），配合严格 CSP；远程图片默认不加载。
- 浏览器端解析不降低安全性：解析结果只进沙箱 iframe，不进应用自身的 DOM。
- 没有用户自设密码。Passkey 防钓鱼；恢复密钥只在初始化时显示一次。
- API Key、会话令牌、恢复密钥只存 SHA-256 哈希；Resend API Key、Webhook 签名密钥、签名 URL 的 HMAC 密钥放在 Worker secret 中；任何密钥和邮件内容都不进日志。
- 所有端点默认要求授权。公开端点：健康检查、Resend Webhook（验签）、首次初始化（凭 `SETUP_TOKEN`，执行一次后失效）、给 Resend 拉取附件的签名 URL（1 小时有效）。
- 可选加固：在 Web 界面路径前加一层 Cloudflare Access，`/api/webhooks/*` 和签名 URL 不经过 Access。

## 9. 前置条件

- 域名托管在 Cloudflare DNS，并启用 Email Routing。
- Resend 账号，发信域名在 Resend 完成验证，准备好 API Key。
- Cloudflare Workers Free 计划即可。
