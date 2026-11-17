# MelodyMail

[English](README.md) · [日本語](README.ja-JP.md)

MelodyMail 是一个单用户邮件服务，用于你自己的域名，运行在 Workers 免费计划的一个 Cloudflare Worker 上。它负责收取、存储、整理和发送邮件，所有者用通行密钥登录，不使用密码。

## 要求

- 一个 Cloudflare 账户，以及一个 DNS 托管在 Cloudflare 上的域名。
- Bun 1.4.4、Node.js（wrangler 运行在 Node 上）和 git。
- 可选：用于发信的 Resend 账户，用于新邮件卡片的 Telegram 机器人。

## 部署

以下是从全新 Cloudflare 账户开始的最短步骤。包含全部检查和可选功能的完整流程请参阅 [docs/RUNBOOK.md](docs/RUNBOOK.md)（英文）。

1. 先确定最终的主机名，例如 `mail.example.com`。通行密钥绑定到这个主机名，在其他主机名上创建的通行密钥在这里无法使用。
2. 安装并运行检查：

   ```sh
   git clone https://github.com/JohnsonRan/MelodyMail.git
   cd MelodyMail
   bun install --frozen-lockfile
   bun run check
   ```

3. 登录 Cloudflare。之后的所有命令都在 `worker/` 中运行：

   ```sh
   cd worker
   bun run wrangler login
   ```

4. 创建数据库、存储桶和队列，并创建本地部署文件：

   ```sh
   bun run wrangler d1 create melodymail --no-update-config
   bun run wrangler r2 bucket create melodymail-mail --no-update-config
   bun run wrangler queues create melodymail-inbound
   cp deploy.example.jsonc deploy.local.jsonc
   ```

   在 `deploy.local.jsonc` 中，把 `database_id` 设为 `d1 create` 输出的 ID，把路由的 pattern 设为你的主机名。git 会忽略此文件。

5. 应用迁移、部署，然后检查健康检查端点：

   ```sh
   git pull
   bun run migrate:prod
   bun run deploy:prod
   curl https://mail.example.com/api/health
   ```

   应返回 `{"ok":true}`。只有当前分支是干净的 `main` 且与 `origin/main` 一致时，`migrate:prod` 和 `deploy:prod` 才会运行，否则拒绝运行（退出码 1）。

6. 添加设置令牌。wrangler 提示时粘贴生成的随机值：

   ```sh
   openssl rand -base64 32
   bun run wrangler secret put SETUP_TOKEN --config .wrangler-production.jsonc
   ```

7. 在 Cloudflare 控制面板中，为域名启用 Email Routing（“Compute > Email Service > Email Routing > Onboard Domain”），接受它添加的记录，再把 catch-all 地址设为“Send to a Worker”并选择 `melodymail`。在 `_dmarc` 上添加一条 DMARC TXT 记录。

可选功能通过 Worker 机密开启：

| 功能 | 机密 |
| --- | --- |
| 通过 Resend 发信 | `RESEND_API_KEY`、`RESEND_WEBHOOK_SECRET`、`UPLOAD_URL_KEY` |
| Web Push 推送 | `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT` |
| Telegram 卡片 | `TELEGRAM_BOT_TOKEN` |

各功能的设置步骤请参阅 [docs/RUNBOOK.md](docs/RUNBOOK.md#optional-features)。

## 首次使用

1. 打开 `https://mail.example.com/setup`。输入设置令牌，创建通行密钥，把 TOTP 种子添加到身份验证器应用，并把恢复密钥保存在电脑之外。
2. 删除设置令牌。首次设置只能运行一次：

   ```sh
   bun run wrangler secret delete SETUP_TOKEN --config .wrangler-production.jsonc
   ```

3. 在“设置 > 域名”中添加你的域名，然后选择“检查 DNS”。
4. 在“设置 > 地址”中添加一个地址，例如 `you@example.com`。
5. 从另一个账户给它发一封邮件。一分钟内，邮件会出现在“收件箱”中。

## 更新与回滚

在仓库根目录中运行：

```sh
git pull
bun install --frozen-lockfile
bun run check
cd worker
bun run migrate:prod
bun run deploy:prod
```

迁移总是先于代码运行，并且只向前推进。运行手册的[更新](docs/RUNBOOK.md#update)一节会先记录还原点；[回滚](docs/RUNBOOK.md#roll-back)一节说明如何回滚代码以及回滚后的遗留影响。

## 备份

D1 Time Travel 可以把数据库还原到过去 7 天内的任意一分钟。Worker 还会每天把数据库导出到 R2。原始邮件在账户内没有第二份副本，因此请每月把存储桶复制到你自己的磁盘。还原、账户外副本和例行检查请参阅 [docs/RUNBOOK.md](docs/RUNBOOK.md#backups)。

## 本地开发

在仓库根目录中运行：

```sh
cp worker/.dev.vars.example worker/.dev.vars
bun run --cwd web build
bun run --cwd worker db:migrate:local
bun run --cwd worker dev
```

先在 `worker/.dev.vars` 中设置 `SETUP_TOKEN`，然后打开 `http://localhost:8787/setup`。请使用 `localhost`，不要使用 `127.0.0.1`：浏览器不接受用 IP 地址创建通行密钥。`bun run check` 是合并门禁。

## 更多

- [docs/REFERENCE.md](docs/REFERENCE.md)：各项功能的说明（规则、转发、通知、发信、REST API），英文。
- [worker/src/api/openapi.json](worker/src/api/openapi.json)：REST API 的 OpenAPI 文档。
- [docs/RUNBOOK.md](docs/RUNBOOK.md)：部署、更新、备份、还原和监控，英文。
