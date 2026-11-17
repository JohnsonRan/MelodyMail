# MelodyMail

[简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md)

MelodyMail is a single-owner mail service for your own domain that runs on one Cloudflare Worker
on the Workers Free plan. It receives, stores, sorts and sends mail, and the owner signs in with a
Passkey instead of a password.

## Requirements

- A Cloudflare account and a domain whose DNS is on Cloudflare.
- Bun 1.4.4, Node.js (wrangler runs on Node) and git.
- Optional: a Resend account for sending, a Telegram bot for new-mail cards.

## Deploy

These are the shortest steps from a blank Cloudflare account. The full procedure, with every
check and the optional features, is in [docs/RUNBOOK.md](docs/RUNBOOK.md).

1. Choose the final hostname first, for example `mail.example.com`. Passkeys are bound to that
   host, so a Passkey created on another host does not work on it.
2. Install and run the checks:

   ```sh
   git clone https://github.com/JohnsonRan/MelodyMail.git
   cd MelodyMail
   bun install --frozen-lockfile
   bun run check
   ```

3. Sign in to Cloudflare. Every later command runs in `worker/`:

   ```sh
   cd worker
   bun run wrangler login
   ```

4. Create the database, the bucket and the queue, and start your local deploy file:

   ```sh
   bun run wrangler d1 create melodymail --no-update-config
   bun run wrangler r2 bucket create melodymail-mail --no-update-config
   bun run wrangler queues create melodymail-inbound
   cp deploy.example.jsonc deploy.local.jsonc
   ```

   In `deploy.local.jsonc`, set `database_id` to the id that `d1 create` printed and the route
   pattern to your hostname. Git ignores this file.

5. Apply the migrations, deploy, and check the health endpoint:

   ```sh
   git pull
   bun run migrate:prod
   bun run deploy:prod
   curl https://mail.example.com/api/health
   ```

   The answer is `{"ok":true}`. `migrate:prod` and `deploy:prod` refuse (exit 1) unless you are on
   a clean `main` that equals `origin/main`.

6. Set the setup token. Paste the random value when wrangler asks:

   ```sh
   openssl rand -base64 32
   bun run wrangler secret put SETUP_TOKEN --config .wrangler-production.jsonc
   ```

7. In the Cloudflare dashboard, onboard the domain to Email Routing (Compute > Email Service >
   Email Routing > Onboard Domain), accept the records it adds, and set the catch-all address to
   "Send to a Worker", `melodymail`. Add a DMARC TXT record on `_dmarc`.

Optional features switch on with Worker secrets:

| Feature | Secrets |
| --- | --- |
| Sending through Resend | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `UPLOAD_URL_KEY` |
| Web Push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |
| Telegram cards | `TELEGRAM_BOT_TOKEN` |

The steps for each are in [docs/RUNBOOK.md](docs/RUNBOOK.md#optional-features).

## First use

1. Open `https://mail.example.com/setup`. Enter the setup token, create a Passkey, add the TOTP
   seed to an authenticator app, and keep the recovery key outside the computer.
2. Delete the setup token. Setup runs only once:

   ```sh
   bun run wrangler secret delete SETUP_TOKEN --config .wrangler-production.jsonc
   ```

3. In Settings > Domains, add your domain and choose "Check DNS".
4. In Settings > Addresses, add an address, for example `you@example.com`.
5. Send a mail to it from another account. It appears in the Inbox within a minute.

## Update and roll back

From the repository root:

```sh
git pull
bun install --frozen-lockfile
bun run check
cd worker
bun run migrate:prod
bun run deploy:prod
```

Migrations always run before the code and only move forward. The runbook's
[Update](docs/RUNBOOK.md#update) section records a restore point first; its
[Roll back](docs/RUNBOOK.md#roll-back) section covers code rollback and what it leaves behind.

## Backups

D1 Time Travel can restore the database to any minute of the last 7 days. The Worker also writes a
daily export of the database to R2. Raw mail has no second copy inside the account, so copy the
bucket to your own disk once a month. Restores, the off-account copy and the routine checks are in
[docs/RUNBOOK.md](docs/RUNBOOK.md#backups).

## Develop locally

From the repository root:

```sh
cp worker/.dev.vars.example worker/.dev.vars
bun run --cwd web build
bun run --cwd worker db:migrate:local
bun run --cwd worker dev
```

Set `SETUP_TOKEN` in `worker/.dev.vars` first. Open `http://localhost:8787/setup`. Use
`localhost`, not `127.0.0.1`: browsers do not accept an IP address for Passkeys. `bun run check` is
the merge gate.

## More

- [docs/REFERENCE.md](docs/REFERENCE.md): what each feature does (rules, forwarding, notifications,
  sending, the REST API).
- [worker/src/api/openapi.json](worker/src/api/openapi.json): the OpenAPI document of the REST API.
- [docs/RUNBOOK.md](docs/RUNBOOK.md): deployment, updates, backups, restores and monitoring.
