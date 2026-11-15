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

Then open `/setup` on the Worker's domain and enter the same value. Setup runs once; after it
succeeds, the token no longer opens anything. For `wrangler dev`, put the value in
`worker/.dev.vars` instead.

### Clear a recovery lockout

Five failed recovery attempts within 15 minutes lock recovery for 15 minutes. Waiting 15 minutes
opens it again. To open it at once, delete the counted failures from `worker/`:

```sh
bun run wrangler d1 execute melodymail --remote --command "DELETE FROM login_attempts"
```

Use `--local` instead of `--remote` for the `wrangler dev` database. The command deletes only the
failure counts; it does not change any credential.
