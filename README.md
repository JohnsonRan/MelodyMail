# MelodyMail

MelodyMail is a single-owner mail service that runs on one Cloudflare Worker on the Workers Free
plan. The owner signs in with a Passkey; there is no password.

## Install

Requires Bun 1.4.4 and Node.js (wrangler runs on Node). From the repository root:

```sh
bun install
bun run check
```

`bun run check` is the merge gate: lint, typecheck, tests, i18n check, build and requirements check,
run at the same time by `scripts/check.ts`; each step prints its output and exit code when it ends.

## Run locally

```sh
cp worker/.dev.vars.example worker/.dev.vars   # then set SETUP_TOKEN in it
bun run --cwd web build
bun run --cwd worker db:migrate:local
bun run --cwd worker dev
```

Open `http://localhost:8787/setup`. Use `localhost`, not `127.0.0.1`: browsers do not accept an
IP address as a Passkey relying party, so Passkeys fail on `127.0.0.1`.

## Authentication

The owner signs in with a Passkey. The fallback is a recovery key plus a code from an
authenticator app (TOTP). Both are created during first-run setup.

### Set the setup token

First-run setup needs the `SETUP_TOKEN` Worker secret. The Worker refuses setup while the secret
is missing or shorter than 32 characters. Generate a random value and store it as a secret from
`worker/`:

```sh
openssl rand -base64 32
bun run wrangler secret put SETUP_TOKEN
```

`bun run deploy` does not change the database. Before the first `/setup`, and after every deploy
that adds a migration, apply the migrations to the remote D1 database:

```sh
bun run --cwd worker db:migrate:remote
```

Without them, every auth route answers 500. Then open `/setup` on the Worker's domain and enter
the same value. Setup runs once; after it
succeeds, the token no longer opens anything. For `wrangler dev`, put the value in
`worker/.dev.vars` instead.

### Clear a recovery lockout

Recovery counts failed attempts in two ways. One IP address gets at most five in any 15 minutes;
all addresses together get at most 20. A lock lasts until the oldest counted attempt is 15 minutes
old (at most 15 minutes). The global ceiling locks recovery for everyone, the owner included. To
open both at once, delete the counted failures from `worker/`:

```sh
bun run wrangler d1 execute melodymail --remote --command "DELETE FROM login_attempts"
```

Use `--local` instead of `--remote` for the `wrangler dev` database. The command deletes only the
failure counts; it does not change any credential.

## Domains and addresses

Apply migration 0004 right after deploying this version, before anyone signs in: setup, sign-in
and recovery write to its `audit_log.detail` column and answer 500 until it exists (see "Set the
setup token" for when migrations run):

```sh
bun run --cwd worker db:migrate:remote
```

1. The domain must use Cloudflare DNS with Email Routing turned on.
2. In Settings > Domains, add the domain. Its "DNS records" page lists the Email Routing MX, SPF,
   DKIM and DMARC records; "Check DNS" asks Cloudflare's DNS-over-HTTPS resolver
   (`DOH_URL` in `worker/wrangler.jsonc`) and marks each record found, missing or different.
3. In Settings > Addresses, add each address that may receive mail. A prefix holds a-z, 0-9,
   `.`, `_` and `-`; `+` is reserved for tags such as `shop+news`.
4. In Settings > Forwarding, add the addresses mail may be forwarded to. Each must first be a
   verified destination address in the Cloudflare dashboard (Email Routing > Destination
   addresses, at most 200 per account).

## Inbound mail

Apply migrations 0005 and 0006 right after deploying this version: `email()` writes every
received message to the `messages` table and throws until it exists, so mail sent in the meantime
is refused, and the queue consumer fails until the `attempts` column exists (see "Set the setup
token" for when migrations run):

```sh
bun run --cwd worker db:migrate:remote
```

`bun run deploy` creates the R2 bucket `melodymail-mail` and the queue `melodymail-inbound` when
they are missing (wrangler's automatic provisioning). If the deploy stops with
`Queue "melodymail-inbound" does not exist`, create the queue from `worker/` and deploy again:

```sh
bun run wrangler queues create melodymail-inbound
```

1. In the Cloudflare dashboard, open the domain's Email Routing > Routing rules and set the
   catch-all address to "Send to a Worker", choosing `melodymail`.
2. Only addresses added in Settings > Addresses receive mail. Mail to any other address, to a
   disabled address, or to a domain with receiving switched off is refused before anything is
   stored. `shop+news@` is delivered to `shop@` with the tag `news` kept on the message.
3. Each received message is stored in R2 and parsed by the queue consumer. A Cron Trigger every
   15 minutes re-queues messages that are still unparsed after 15 minutes. After five failed
   parse tries a message is marked as not parsed; its raw copy stays in R2.
4. An address with forwarding targets forwards every message to each of them, with the header
   `X-MelodyMail-Forwarded: 1`; a message that already carries it is kept and not forwarded
   again. A forward-only address keeps no copy, unless every forward fails.
5. If a message cannot be stored, an address with forwarding targets forwards it to them instead
   (recorded in the audit log); an address without targets refuses it, and the sender gets a
   bounce.

## Mailbox

Apply migration 0007 after deploying this version (`bun run --cwd worker db:migrate:remote`).
It only adds indexes, so the mailbox works before it is applied, just slower. The deploy also
creates the `Hub` Durable Object (SQLite-backed, as Workers Free requires) that pushes new-mail
events to open pages.

Messages are parsed in the browser. Sender HTML is shown in a sandboxed frame without scripts,
remote images stay blocked until "Show remote images" is chosen for that message, and
attachments are always downloaded, never opened in the app.

To fill a local mailbox with the test fixtures, start the Worker and run the seed script. It
sends every `.eml` in `worker/test/fixtures` through the real `email()` handler of `wrangler dev`
and creates `shop@example.com` and `news@example.com` in the local database:

```sh
bun run --cwd worker dev          # in one terminal
bun scripts/seed-mail.ts          # in another
```

The browser security suite needs Chromium for Playwright once:
`bunx playwright@1.65.0 install chromium-headless-shell`. Then run it from `web/`:

```sh
bun run --cwd web test:browser
```
