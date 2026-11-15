# MelodyMail

MelodyMail is a single-owner mail service that runs on one Cloudflare Worker on the Workers Free
plan. The owner signs in with a Passkey; there is no password.

## Install

Requires Bun 1.4.4 and Node.js (wrangler runs on Node). From the repository root:

```sh
bun install
bun run check
```

`bun run check` is the merge gate: lint, typecheck, tests, i18n check, build and requirements check.

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

Inbound mail is still refused for every address; receiving and forwarding arrive in M3.
