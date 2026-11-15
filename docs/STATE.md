# STATE

Working state for the current milestone. The plan is in `docs/PLAN.md`.

## M0: repository skeleton (done 2026-11-15)

- Bun workspaces `worker` and `web`; Bun pinned to 1.4.4. wrangler alone runs on Node (owner
  ruling); `bun run dev` starts the Worker and Vite, `bun run deploy` builds and deploys.
- Worker: Hono app with `GET /api/health` and a JSON 404 for unknown API routes; `email()` rejects
  every recipient until the address list exists (M2/M3). Static assets from `web/dist`, with
  `/api/*` always reaching the Worker.
- Web: React 19, Vite, Astryx 0.7.16 (neutral theme), `AppShell` with folder navigation and a
  centred empty inbox state; language (zh-CN, en, ja-JP) and theme (system, light, dark)
  selectors, remembered in `localStorage`.
- Gate: `bun run check` (lint, typecheck, worker tests, script tests, i18n check, build,
  requirements check) passes locally in 4.6–5.9 s and in CI.
- CI: first run on GitHub (`JohnsonRan/MelodyMail`, run 43715005562) passed; the job took 17 s.
- Rules that do not apply (money, ledger, card numbers, key files) were deleted by owner ruling.

Verified by screenshot (wrangler dev, Chrome on Windows):

- Desktop: zh-CN light, en dark, ja-JP light render; CJK text uses the system fallback fonts with
  the right glyph forms for each `lang`.
- Phone width (390 px, through an iframe because the window could not be resized): no horizontal
  scroll (scrollWidth 389 = viewport), the side navigation collapses into a menu button.
- Found and fixed: the empty state sat at the top of the content area and its icon did not render.
  It is now wrapped in Astryx `Center` with an `Icon`; re-shot centred on desktop and phone.

Not verified:

- CJK fallback on macOS, iOS and Android (only Windows was checked).
- Phone width on a real device or a resized window; only the iframe was checked.

Owner ruling (2026-11-15): design for Workers Free only. `docs/PLAN.md`, section 2 holds the
limits and the CPU budget: no JS work proportional to mail size in the Worker, mail parsed in the
browser, a bounded 256 KB header parse server-side, and no user-chosen password (slow hashes break
the 10 ms CPU cap).

## M1: authentication (built, waiting for review)

Design: `docs/M1-auth.md` (written 2026-11-15). Work is on branch `m1-auth`; it merges only after
the owner reviews it. Not pushed; no pull request yet.

### Done

- Schema in Drizzle (`worker/src/db/schema.ts`); migration `worker/migrations/0000_auth.sql`
  generated with `bun --bun drizzle-kit generate` (drizzle-kit runs under Bun). Drizzle is used
  for the schema only; the Worker queries D1 with prepared SQL.
- `wrangler.jsonc`: D1 binding `DB` without `database_id`; Rate Limiting binding `AUTH_LIMITER`
  (10 per 60 s). Tests apply the migrations with `applyD1Migrations` and empty the tables
  before each test (storage lives as long as a test file in this plugin version).
- Worker: setup, Passkey login, recovery, logout, Passkey and session management, as in the
  design. Default-deny authorization through `publicRoute`; origin check on non-GET `/api/*`;
  recovery lockout in D1; own RFC 6238 TOTP; `@simplewebauthn/server` 14.
- Web: TanStack Router with `/setup`, `/login`, `/recover`, `/`, `/settings/security`;
  `@simplewebauthn/browser`; QR code from `uqr` (Astryx has no QR component). Pages are lazy
  chunks; the Astryx zh-CN / ja-JP catalogs load per locale.
- Bun benchmark `worker/bench/auth.ts` (`bun run --cwd worker bench:auth`); numbers in
  `REQUIREMENTS.md`, "Numbers".
- README with local run, `SETUP_TOKEN` and the lockout-clearing command.

### Verified, with the command

- `bun run check`: green at every commit (59bacb5, 9bbb6d7, 3fdfc32, 0579f57 and the docs
  commit); each intermediate commit was checked with the rest of the tree stashed.
- `bun --bun vitest run` in `worker/`: 68 tests against the D1 in workerd.
- Ablation (`AGENTS.md`, Tests): 69 hunks, each removed or inverted once by a script, worker
  suite run after each. 68 turned at least one test red. Hunks ablated: origin check, 401 on
  guarded routes, 404 for unknown routes, public marker, rate limit, setup-token minimum length
  and compare, constant-time compare, both setup 409 checks, the setup race catch, session cookie
  only after the setup batch, setup challenge required and its expiry, setup TOTP and credential
  checks, TOTP step stored at setup, setup challenge deleted and its cookie cleared, registration
  origin, authentication origin, authentication RP ID, excludeCredentials, challenge single use,
  purpose and expiry, expired-challenge pruning, challenge and session cookie SameSite, login
  verify result, counter stored, expired sessions pruned at login, recovery lock check, failure
  recorded, key check, TOTP check, key normalisation, key rotation, compare-and-set condition and
  result, failures cleared on success, lockout needs five, window spread, lock duration, failure
  pruning, absolute and idle expiry, ended session deleted, last-seen throttle and write, session
  lifetime, `/state` authenticated flag, Passkey label, audit event, logout delete and cookie,
  add-Passkey verification, last-Passkey guard, 404 on unknown Passkey, session list filter and
  hidden id, revoke others, TOTP window, replay and format, JSON object check and parse error,
  `onError` without detail.
  - Survived: the `if (!passkey)` check in `POST /login/verify`. Without it, the missing row
    makes `verifyAuthentication` throw inside its own `try`, which also answers 401. Kept as the
    explicit check; it changes no response.
  - The counter-regression rule itself is enforced by `@simplewebauthn/server`; the test
    "rejects a sign counter that went backwards" covers it.
- `wrangler dev` (local, port 8788): `GET /api/auth/state`, wrong and right setup token, login
  options, missing Origin (403), no session (401), recovery before setup (401), SPA routes 200.
  `db:migrate:local` applies without `database_id` and reruns as a no-op on a database with
  rows.
- Benchmark: `bun worker/bench/auth.ts`, 3 runs (see `REQUIREMENTS.md`).
- `bun run astryx -- doctor --built .` in `web/`: no failures; warnings are the inline styles
  from the Astryx login-card template and the M0 shell, and the QR `<svg>` (not an icon).

### Not verified

- No real browser or authenticator has run the flows; only the software authenticator in the
  tests. Screenshots (phone and desktop, light and dark, three locales) are for the
  orchestrator.
- `vite dev` with its `/api` proxy: Origin and RP ID come from the request URL, which may not
  match the browser origin behind the proxy. Use `wrangler dev` on `localhost`.
- Rate Limiting binding on the real Free plan (miniflare counts exactly; production is
  approximate and per location).
- CPU time in production (Workers Logs `cpuTime`); only the Bun benchmark exists.
- Port 8787 on this machine is held by an older `wrangler dev` (not started in this work) that
  still has the M0 config; it hot-reloads source but has no `DB` binding, so it answers 500 on
  auth routes. Restart it before taking screenshots.

### Open questions

1. RP ID on `127.0.0.1`: the design says the same build works on `127.0.0.1` in dev, but
   browsers reject an IP address as a WebAuthn RP ID. The README says to use `localhost`. No code
   change needed; the design text should say `localhost`.
2. Recovery key length: the design says 128 random bits formatted as 8 groups of 4 base32
   characters, but 32 base32 characters hold 160 bits. The code uses 160 bits (20 bytes) to keep
   the format. Confirm.
3. Extra optional `label` field on `POST /setup/verify` and `POST /passkeys/verify`, so the web
   app can name Passkeys in the owner's language (default "Passkey"). Additive; confirm.
4. `SETUP_TOKEN` too short answers 503 `setup_disabled`; the design names no code for it.
5. Numbers over their limits after M1 (limits not changed, owner decides):
   - merge gate `bun run check`: 9.7–9.9 s, 3 runs (limit 6.2 s);
   - worker suite (vitest Duration, mostly transform): 5.7–5.8 s, 3 runs (limit 2 s);
   - frontend total JS + CSS gzip: 505 kB (limit 460 kB). The first paint loads 384 kB
     (index.html and its preloads); the entry chunk alone is 67 kB (limit 270 kB).
6. Should a successful recovery also sign out every other session? The design does not say;
   not done.
7. `/api/auth/state` is fetched on every route change (one small request); no cache. Fine for
   now; revisit if it shows in latency.
