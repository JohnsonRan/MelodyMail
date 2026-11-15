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

## M1: authentication (done 2026-11-16)

Design: `docs/M1-auth.md`, matching the code and the owner rulings below. Merged through pull
request #1 as `8f55f86` after a final review PASS on `6de6520`, the owner's walkthrough in a real
browser, and CI green.

### Owner rulings (2026-11-15)

- A. Recovery lockout counts per client IP (5 failures / 15 min lock that IP) and globally (20
  failures / 15 min lock everyone). Both reservations are atomic and come before verification.
  The README `wrangler d1 execute` command clears both. Numbers as proposed; unchanged.
- B. Step-up re-authentication: adding (checked at options) or deleting a Passkey, signing out other
  sessions and regenerating the recovery key need a Passkey assertion on the current session within
  5 minutes (`sessions.reauth_at`); else 403 `reauth_required`. `POST /auth/reauth/options` and
  `/auth/reauth/verify` refresh it. Sessions created by setup, sign-in or recovery start fresh.
- C. A successful recovery signs out every other session.
- D. `POST /auth/recovery-key` regenerates the recovery key while signed in (needs B); Settings >
  Security has "Regenerate recovery key" with confirmation.
- E. Reduce size and time before any limit is raised; limits in `REQUIREMENTS.md` stay as they are.
- F. A session opened by a successful recovery stays fresh for step-up until the first Passkey
  is added on that session, or at most 30 minutes after the recovery, whichever comes first.
  Setup and sign-in sessions keep the 5-minute window (`sessions.recovery_fresh_until`,
  migration 0002, `26082c2`; copy says 30 minutes, `1cd4169`). Was open question 1.
- G. Owner request (2026-11-15, amended 2026-11-16): the session list shows each session's IP
  address and location. Amended: location comes only from `request.cf`, written with the session
  (`a84e692`); the ip.sb lookup was dropped so the owner's IP is not sent to a third party.
  Originally: location from ip.sb,
  looked up after the response with a `request.cf` fallback (migration 0003, `a7f07cd`, web
  `721c00a`). The owner's IP is sent to ip.sb.

### Done

- Schema in Drizzle (`worker/src/db/schema.ts`); migrations `0000_auth.sql` and
  `0001_session_reauth.sql` (adds nullable `sessions.reauth_at`) generated with
  `bun --bun drizzle-kit generate`. The Worker queries D1 with prepared SQL.
- `wrangler.jsonc`: D1 binding `DB` without `database_id`; Rate Limiting binding `AUTH_LIMITER`.
- Worker: setup, Passkey sign-in, recovery (per-IP and global lockout, ends other sessions),
  logout, Passkey and session management, step-up re-authentication, recovery-key regeneration.
  Default-deny authorization through `publicRoute`; origin check on non-GET `/api/*`; own RFC
  6238 TOTP; `@simplewebauthn/server` 14 (its `isoBase64URL` replaces a local base64url).
- Web: TanStack Router with `/setup`, `/login`, `/recover`, `/`, `/settings/security`;
  `withReauth` runs the Passkey prompt on `reauth_required` and retries; regenerate dialog reuses
  `RecoveryKeyPanel`. Pages and the signed-in shell are lazy chunks; Astryx zh-CN / ja-JP catalogs
  load per locale.
- Bun benchmark `worker/bench/auth.ts`; numbers in `REQUIREMENTS.md`, "Numbers".
- README: local run, `SETUP_TOKEN`, remote migration before the first `/setup`, lockout clearing.

### Review fixes (review of 2026-11-15, "FIX FIRST")

1. Recovery lockout race (Medium). Count and reserve are one `INSERT ... SELECT` before
   verification (`9fae8ac`, then `8c1e64e`; per-IP plus global in `b60208c`). Test "evaluates at
   most 5 of 20 concurrent wrong attempts" failed on the old code with
   `expected 20 to be less than or equal to 5` and passes now; repeated 5 times green. The
   per-IP and global versions each have a concurrency test (20 from one IP; 40 from 40 IPs).
2. `passkeys/verify` bare catch (Low). Only a stored credential id answers 409
   `passkey_exists`; anything else goes to `onError` (`ee2fedb`). The new test (insert failing
   for another reason) answered 409 before the fix, 500 `internal` after.
3. README remote migration (Low). `bun run --cwd worker db:migrate:remote` is a README step
   before the first `/setup`; not chained into `deploy`, so a production schema change stays an
   explicit step (`a1b8f19`).
4. Shared writes moved from `routes.ts` to `auth/store.ts` (`c14aecc`).
5. RP ID comment now says `localhost` (`a1b8f19`).
6. Local base64url replaced by `isoBase64URL` from `@simplewebauthn/server/helpers` (`a9ccbb1`).
7. a. Confirmed: the logged simplewebauthn error quoted the stored and the submitted challenge.
      The reason is now redacted (quoted values and long tokens become an ellipsis);
      `test/log-redaction.spec.ts` fails on the old code for registration and assertion
      (`b0b7163`).
   b. Not confirmed by reading: Enter in the setup-token field runs only the token submit
      (Astryx `TextInput` calls `onEnter` on keydown), and nothing moves focus to the step-1
      button. Confirmed nearby: `onEnter` and clicks ignored `busy`, so key repeat started
      overlapping requests. A ref guard now allows one action at a time (`1489dfd`). Not checked
      in a browser.

### Size and time (E), dev workstation Ryzen 9 9950X3D, Bun 1.4.4

| Item | Limit | Before | After | Change |
| --- | --- | --- | --- | --- |
| Worker suite, vitest Duration, 3 runs interleaved, load 67-70% | 2 s | 6.70-7.56 s | 4.54-4.91 s | pre-bundle `@simplewebauthn/server` (about 240 modules) in vitest (`76a0f1f`) |
| Merge gate `bun run check`, 3 runs | 6.2 s | 9.7-9.9 s (load not recorded) | 7.9-8.2 s (load 55-67%) | follows from the suite |
| First paint (index.html and preloads), gzip -6 | (none) | 384 kB | 309 kB | signed-in shell is a lazy chunk (`45cda59`) |
| Entry chunk, gzip -6 | 270 kB | 67 kB | 14 kB | same |
| Total JS + CSS, gzip -6 | 460 kB | 505 kB | 508 kB | regenerate dialog added about 3 kB |

Where the time and bytes go, and what getting under would take:

- Worker suite: one test file alone takes 1.9-2.1 s (vitest start, workerd, transform of the
  Worker entry). Files already run in parallel (sequential: 15 s). The 2 s limit fits only an
  almost empty suite; getting under needs a different measure (for example per-file time) or a
  higher limit. Owner decision.
- Merge gate: test 6.1 s of the total (with `bun run --filter` overhead), build 1.0 s, typecheck
  1.0 s, the rest under 0.4 s each. No step builds twice; the worker typecheck checks `src` twice
  (about 0.4 s, `tsc -p .` without and `-p test` with test types), kept because the first pass
  catches `src` code that leans on test-only types. Running independent steps concurrently
  would bring it near the test time (about 6 s); not done, it changes the gate's shape.
- Total bundle: a source-map attribution (minified bytes) shows Astryx core about 890 kB
  (motion 97 kB, theme 84 kB, gestures 79 kB, hooks 75 kB, Layer 60 kB, BottomSheet 54 kB,
  Resizable 32 kB), react-dom 207 kB, TanStack Router 65 kB, i18next with the ICU parser 76 kB,
  app code 21 kB, uqr 10 kB, `@simplewebauthn/browser` 9 kB, heroicons 7 kB (tree-shaken).
  No module is duplicated across chunks. The prebuilt `astryx.css` is 49.6 kB gzip and holds
  every component's styles. Getting under 460 kB (about 48 kB) needs one of: compiling Astryx
  styles with StyleX instead of the prebuilt CSS (`web/ASTRYX.md` says no compiler here), or
  dropping components (Toast and Stepper together are an estimated 10 kB gzip), or replacing
  TanStack Router (an estimated 20 kB gzip, against the M1 design). Owner decision.

### Verified, with the command

- `bun run check`: green at every commit; intermediate commits were checked with the rest of the
  tree stashed.
- `bun --bun vitest run` in `worker/`: 94 tests against the D1 in workerd.
- Ablation (`AGENTS.md`, Tests), script removes or inverts one hunk per run: 85 hunks, 84 turned at
  least one test red; ruling F added 7 more, all red (91 entries after dropping the /passkeys/verify
  guard). Covered: every hunk listed in the first M1 report (origin check, authorization, rate
  limit, setup, challenges, sign-in, recovery, sessions, Passkeys, TOTP, input and error handling),
  plus the review fixes (atomic reservation, window prune, retryAfter, passkey_exists re-check, both
  log redactions) and the rulings (per-IP limit, global limit, global row only with the per-IP row,
  retryAfter per counter, clearing both counters, recovery ending other sessions, fresh-auth null
  and expiry checks, sessions starting fresh, reauth updating only the current session, regenerated
  key stored, and requireFreshAuth on each of its routes; five then, four after the second review).
  Survivor: the explicit `if (!passkey)` in `checkAssertion`; without it `verifyAuthentication`
  throws inside its own `try` and also answers 401. Kept as the explicit check. The
  counter-regression rule is enforced by `@simplewebauthn/server` and covered by a test. The web
  in-flight guard has no test (the web app has no test runner); it was checked by reading.
- `wrangler dev` (local, port 8788, before the rulings): state, setup token, login options,
  403 and 401 paths, SPA routes. `db:migrate:local` applies without `database_id` and reruns as
  a no-op on a database with rows.
- Benchmark: `bun worker/bench/auth.ts`, 3 runs (see `REQUIREMENTS.md`).

### Not verified

- The owner ran setup and sign-in in Chrome with a real Passkey (2026-11-15) and checked the
  signed-in pages; the phone-width shots of the signed-in pages were not taken.
- `vite dev` behind its `/api` proxy (Origin and RP ID come from the request URL).
- Rate Limiting binding on the real Free plan; production `cpuTime`.
- `cf-connecting-ip` is set by Cloudflare in production; in `wrangler dev` and tests it comes
  from the request, so the per-IP counter falls back to the key `unknown` when it is missing.

### Open questions for the owner

1. The recovery lock is a sliding window: it lasts until the oldest counted attempt is 15
   minutes old, so at most 15 minutes, not exactly 15 minutes after the latest failure.
2. `/api/auth/state` is fetched on every route change (one small request); no cache.

Limits: re-baselined by the owner in `ef2b073` (merge gate 10 s, slowest test package 6 s, bundle
total re-baselined); no longer open.

### Second review (2026-11-15, "FIX FIRST")

1. Step-up lapse between `/passkeys/options` and `/passkeys/verify` (Low, reproduced): the
   re-authentication challenge replaced the add-passkey challenge in the one `mm_challenge`
   cookie, so the retried verify failed. `requireFreshAuth` now guards only
   `/passkeys/options`; `addPasskey` no longer wraps verify (`f0a9aac`). Test "add-passkey
   survives a step-up between options and verify": before `retry 401
   {"error":"verification_failed"}`, after green (`bun --bun vitest run test/reauth.spec.ts`).
2. `SecurityPage.tsx` 325 lines with nested ternaries (pass bar): split into
   `RecoveryKeySection` (74 lines) and `SecuritySection` (41); the page is 256 lines and reads
   its confirmation copy from one `specOf(kind)` map (`3f93992`).
3. Deferred (source: second review): commit `4820d98` re-wrapped one-line objects in the three
   locale files together with the new keys. Not rewritten, because the branch history stays as
   reviewed; a later formatting-only commit can restore one-line objects if wanted.
4. The new-key screen after a recovery said to add a Passkey within 5 minutes (`e844f2f`); owner
   ruling F replaced that with a 30-minute recovery window and 30-minute copy.
5. Merge gate on a warm tree, `bun run check`, 3 runs: 8.43 s, 8.63 s, 8.65 s (CPU load 48%,
   74%, 88% before each run; 62% after). Limit 10 s, unchanged. The reviewer saw 10.9 s on one
   cold run.

Resolved by the owner rulings above: global lockout abuse (A), step-up re-authentication (B),
recovery ending other sessions (C, was OQ6), recovery-key regeneration (D). Earlier design
questions are now in `docs/M1-auth.md`: RP ID on `localhost`, recovery key of 160 bits, optional
`label` on Passkey registration, `setup_disabled` (503).

### Final review (2026-11-15, "PASS")

Fresh-context Opus review of `ef2b073..23fb694` passed; the owner ruled that this review stands in
for a different model family. Deferred under the Low rule:

1. `worker/src/auth/account.ts:16-18` header comment still says sensitive actions need a Passkey
   assertion in the last 5 minutes; since ruling F a recovery session also passes for up to 30
   minutes. Point it at `requireFreshAuth` when the file is next touched.
2. The `4820d98` locale re-wrap (second review, item 3).
3. Gate timing margin: the reviewer's warm runs took 9.68-9.95 s against the 10 s limit.

Still unverified: the Rate Limiting binding's per-location counting in production (needs a deploy),
and every signed-in page in a real browser with a real authenticator.

### Owner walkthrough (2026-11-15, real Chrome, real Passkey)

Setup and sign-in worked end to end. Fixes from the walkthrough:

1. Passkey and session rows cut the dates with an ellipsis. Row descriptions now go through
   `Meta`, one fact per line, never truncated (`7ffafc0`). Labels (Passkey name, browser and
   system) stay one line; they are short.
2. The app bar envelope filled and overflowed its NavIcon badge; it is now a sized `Icon`
   (`18750cf`). The sign-in card uses a plain `Icon` without a badge and was not affected.
3. Session IP and location (ruling G): worker `a7f07cd`, web `721c00a`. Tests in
   `worker/test/geo.spec.ts`: IP stored; ip.sb answer stored after the response; an ip.sb error
   falls back to `request.cf`; loopback, private and IPv6 loopback skip the lookup; sign-in
   succeeds when ip.sb throws; setup and recovery sessions are located; the list returns the
   fields; a non-IP header is ignored. Ablation: 11 hunks (IP stored, local marked, local skips
   the lookup, ip.sb field mapping, ip.sb status check, cf fallback, each of the three call sites,
   IP validation, list fields), all red. The test setup now rejects every outbound fetch by
   default, so no test can reach ip.sb or any other upstream. 102 worker tests.
4. Deferred item 1 of the final review is done: the `account.ts` header now points at
   `requireFreshAuth` instead of naming 5 minutes.

Not verified: a real ip.sb answer (only mocked; tests never reach it) and `request.cf` values in
production. In `wrangler dev` the client IP is loopback, so no lookup runs.

### Ruling G amended (2026-11-16)

The ip.sb lookup is gone (`a84e692`). Setup, sign-in and recovery write the IP and the
`request.cf` location (country, region, city, `asOrganization`) in the session INSERT: no
`waitUntil`, no subrequest, no follow-up UPDATE. Migration 0003 is unchanged and every column is
still used; `geo_source` is now `cf`, `local` or null. Timezone (`request.cf.timezone`) is not
stored: it needs a new column (migration 0004) and the session list has no use for it yet.

Tests (`worker/test/geo.spec.ts`, 7): IP and `request.cf` location stored at sign-in; setup and
recovery sessions located; loopback, private and IPv6 loopback store no location; sign-in works
without `request.cf`; sign-in makes no outbound request; the list returns the fields; a non-IP
header is ignored. The ip.sb tests were removed. Ablation: 9 hunks (IP, city and source stored in
the INSERT, no location for local addresses, cf city and organization mapping, empty location
without `request.cf`, IP validation, list fields), all red. 101 worker tests. `fetch` stays
mocked to reject in every test.

Not verified: `request.cf` values in production (in `wrangler dev` the client IP is loopback, so
sessions show "this device or local network").

### Deferred after merge (final review of 6de6520, PASS)

1. `worker/test/apply-migrations.ts:11-12` comment still names the removed ip.sb lookup as an
   example; drop the example, keep the reject-by-default fetch mock.
2. `GET /sessions` types rows as `{ id } & Record<string, unknown>`; restore column types when the
   file is next touched.
3. Hypothesis: on a loaded host (CPU 88%) the reviewer measured `bun run check` at 10.7-11.6 s and
   the worker suite at 6.02 s, over the 10 s and 6 s limits. Settle with three runs on an idle host.
4. Hypothesis: a full IPv6 address may wrap mid-value in the session row at phone width. Settle with
   a phone-width screenshot of `/settings/security` showing such a session.
5. Earlier deferrals stand: the `4820d98` locale re-wrap.

## M2: domains, addresses, forwarding targets (done 2026-11-16)

Merged through pull request #2 as `04bdfdf` after a re-review PASS (both Lows fixed), the
owner's UI check in a real browser, and CI green. Risk class High.

### M2 plan

Risk class: High (corrected by the review of fea4c99; first written as Medium). Two things put it
there: `audit()` writes the new `audit_log.detail` column and runs inside the setup, sign-in and
recovery batches, so login answers 500 until migration 0004 is applied (the reviewer dropped the
column and setup failed); and `DELETE /api/domains/:name?deleteAddresses=1` deletes addresses in
bulk and cannot be undone. Proof: integration tests against D1 for every endpoint, every
behaviour hunk ablated, and a review by an independent model family or, when none is available,
the owner (`AGENTS.md`, Model usage).

Scope (`docs/PLAN.md`, section 7, M2):

- Domains: list, add, remove; receive and send switches; a DNS guidance page per domain; a
  "Check DNS" action that asks DNS-over-HTTPS from the Worker. No Resend call (M5).
- Addresses: local part + domain, unique, stored lowercase; enable/disable, note, default sender
  display name, "forward only", default forward targets.
- Forwarding targets: list, add, remove (detaching from addresses after confirmation). No
  Cloudflare API call; the UI says each target must be a verified destination address.
- `email()` is unchanged and still rejects everything (M3 wires the address list in).

Data model (migration `0004`, generated by `bun --bun drizzle-kit generate`; additive only):

- `domains`: `name` (text primary key, lowercase ASCII), `receive_enabled` (default 1),
  `send_enabled` (default 0, sending arrives in M5), `created_at`. The Resend verification state
  waits for M5, which owns its shape.
- `addresses`: `id`, `local_part` (lowercase), `domain` (references `domains.name`, no cascade),
  `note`, `display_name`, `enabled` (default 1), `forward_only` (default 0),
  `last_received_at` (M3), `created_at`. Unique index `(domain, local_part)`: M3 finds a
  recipient with one indexed lookup `WHERE domain = ? AND local_part = ?`, no join.
- `forward_targets`: `id`, `email` (unique, lowercase), `note`, `created_at`.
- `address_forwards`: `(address_id, target_id)` primary key, both `ON DELETE CASCADE`; index on
  `target_id`.
- `audit_log.detail` (nullable): which domain, address or target an event touched. Never a
  secret.

Endpoints (all guarded by the session middleware; none public):

| Method and path | Behaviour |
| --- | --- |
| `GET /api/domains` | list with address counts |
| `POST /api/domains` | `{ name }`; 400 `invalid_domain` / `domain_not_ascii`; 409 `domain_exists` |
| `PATCH /api/domains/:name` | `{ receiveEnabled?, sendEnabled? }` |
| `DELETE /api/domains/:name` | 409 `domain_has_addresses` unless `?deleteAddresses=1` |
| `GET /api/domains/:name/dns` | the records the owner must have (guidance) |
| `POST /api/domains/:name/dns/check` | DoH lookups (MX, TXT SPF, TXT `_dmarc`); each record `found` / `missing` / `different`; 502 `dns_check_failed` when DoH fails |
| `GET /api/addresses` | list with target ids |
| `POST /api/addresses` | create; 400 `invalid_local_part`, `unknown_domain`, `unknown_target`, `forward_only_needs_target`; 409 `address_exists` |
| `PATCH /api/addresses/:id` | enabled, note, display name, forward only, target ids |
| `DELETE /api/addresses/:id` | delete with its target links |
| `GET /api/forward-targets` | list with the number of addresses using each |
| `POST /api/forward-targets` | `{ email, note? }`; 400 `invalid_email`; 409 `target_exists` |
| `DELETE /api/forward-targets/:id` | 409 `target_in_use` unless `?detach=1` |

Validation decisions:

- Domain: trimmed, one trailing dot dropped, lowercased; non-ASCII is refused with
  `domain_not_ascii` (the owner enters the `xn--` form). Chosen over converting to punycode:
  no IDNA mapping ambiguity and no extra code. At least two labels, each 1-63 of `a-z 0-9 -`
  without a leading or trailing hyphen, at most 253 characters, the last label not all digits.
- Local part: lowercased, 1-64 of `a-z 0-9 . _ -`, no leading, trailing or doubled dot. `+` is
  refused because it is the sub-address separator (`docs/PLAN.md`, section 4).
- Forwarding target: `local@domain`, stored lowercase; local part 1-64 printable ASCII without
  spaces, `@`, `<`, `>`, `"`, `,`; the domain passes the domain check.
- Display name: at most 100 characters, no control characters (it becomes a header in M5).
  Note: at most 200 characters.
- "Forward only" needs at least one forward target, so an address can never drop mail by
  configuration. Removing a forward-only address's last target switches it back to store and
  forward in the same batch (owner ruling 5 below).

Expected DNS records (Cloudflare docs "Domain configuration",
https://developers.cloudflare.com/email-service/configuration/domains/, read 2026-11-16): MX
`route1.mx.cloudflare.net`, `route2.mx.cloudflare.net`, `route3.mx.cloudflare.net` (priorities
assigned by Cloudflare), SPF `v=spf1 include:_spf.mx.cloudflare.net ~all`, DMARC TXT at
`_dmarc.<domain>`. Resend's DKIM / SPF / return-path records are shown as placeholders that come
from the Resend dashboard (M5). The DoH endpoint is a `vars` entry (`DOH_URL`), not code.

Impact: new tables only; existing auth tables untouched except the nullable `audit_log.detail`.
Four DoH subrequests per check (MX, SPF, DKIM, DMARC) (limit 50). Web: three new Settings pages and their side
navigation items; `api()` gains `PATCH`.

Verification: `bun run check` at every commit; worker tests for every endpoint (happy path,
validation, uniqueness, case-insensitivity, `+` refused, domain delete refused and forced,
target detach, DNS check found / missing / different and DoH failure with `fetch` mocked); the
route walk in `test/authz.spec.ts` lists every new route as guarded; ablation of each behaviour
hunk; gate timed 3 times with the load recorded. Gate before M2: 9.1 s (one run).

### Done

- `e0f0ed4` migration `0004_domains.sql` (tables above, `audit_log.detail`), generated with
  `bun --bun drizzle-kit generate --name domains`.
- `d9e6668` domain routes, DNS guidance and the DoH check (`worker/src/domains/`); `DOH_URL`
  in `wrangler.jsonc` `vars`.
- `31e2c7a` address and forwarding-target routes (`worker/src/addresses/`).
- `8003ab1` web: Settings > Domains, Domains > DNS records, Addresses, Forwarding; shared
  `PageFrame`, `DataTable` (Astryx `Table`, stacked list rows below 640 px),
  `FormDialog`, `useSettingsPage`; side navigation items; copy in zh-CN, en, ja-JP.
- `a082b3e` tests for the hunks the first ablation pass missed.
- README section "Domains and addresses".
- Not done: the diff review in a fresh context that the Medium risk class asks for.

Usability references: Fastmail keeps domains (with DNS checks) and addresses in separate settings
pages ([custom domains](https://fastmail.help/hc/en-us/articles/360058753394-Custom-domains-with-Fastmail),
[aliases](https://fastmail.help/hc/en-us/articles/360060591073-How-to-set-up-aliases)); MelodyMail
follows that split. Forwarding targets get their own page because Cloudflare keeps destination
addresses as an account-level list, verified once and shared by every address.

### Verified, with the command

- `bun run check` green at every commit; intermediate commits checked with the rest of the tree
  stashed (`git stash push --keep-index -u`).
- `bun --bun vitest run` in `worker/` (at `fea4c99`): 128 tests (27 new in `domains.spec.ts`,
  `dns-check.spec.ts`, `addresses.spec.ts`, `forward-targets.spec.ts`; the route walk in
  `authz.spec.ts` lists the 13 new routes as guarded and answers 401 on each without a session).
- `fetch` stays mocked to reject by default; the DNS tests replace it with a fake DoH zone and
  assert the request goes to `DOH_URL` with `accept: application/dns-json`.
- Ablation (`AGENTS.md`, Tests): a script removes or inverts one behaviour hunk at a time in
  `worker/src` (validation, every route guard and status, audit writes, the delete guards, the
  force and detach parameters, the DoH request, status and parsing, each found / missing /
  different rule, boolean mapping, the audit detail) and runs the four M2 test files plus the
  route walk. First pass: 91 hunks, 85 red, 6 survived. Five got a test (`a082b3e`): strict path
  id (`5.0` named address 5), DoH HTTP status with a parseable body, the answer type filter (a
  CNAME in an MX answer), the malformed domain on address create, and the PATCH field check; each
  is red now. Survivor kept: sorting `targetIds` in the address response. SQLite returns them in
  primary-key order already, so no test can tell; the sort keeps the order a contract rather
  than an accident of the index.
- Merge gate `bun run check` on an idle host, 3 runs: 6.75 s, 6.34 s, 6.72 s (CPU load 0-1%
  before each run; Ryzen 9 9950X3D). Worker suite vitest Duration 3.85 s. This also settles M1
  deferred item 3 (idle-host timing): under both limits (10 s, 6 s).
- Bundle after M2 (vite build, gzip -6): total JS + CSS 566 kB (limit 610 kB, was 508 kB),
  first paint 312 kB (limit 370 kB), entry chunk 15 kB (limit 270 kB).
- `bun run --cwd worker db:migrate:local`: 0004 applied on the local database that already held
  the M1 owner and a session; a second run reported "No migrations to apply".
- `bun run astryx -- doctor --built src`: no failure; its four warnings are in files M2 did not
  touch (`AuthFrame`, `MailShell` inline styles, `QrCode` raw svg, theme font proof).

### Not verified

- No screenshot of any new page: this run had no browser tools. `web/AGENTS.md` asks for phone
  and desktop shots in both themes with real data before review; the owner should see them before
  merge.
- Real DoH answers from `cloudflare-dns.com` (tests use a fake zone only; no test traffic to a
  real upstream).
- The stacked layout below 640 px, and that `Value` (no wrapping) never overflows: a value
  longer than the phone width (for example a 64-character prefix) would overflow its row.

### Owner rulings (2026-11-16, answer "同意" to the five open questions)

1. Removing a domain together with its addresses (`?deleteAddresses=1`) needs step-up
   re-authentication; a stale session gets 403 `reauth_required` and the web app runs
   `withReauth`. Removing a domain without addresses does not (`fe6af35`).
2. Forwarding targets stay stored lowercase in full. Unverified risk (raised by the reviewer): a
   destination address verified at Cloudflare in mixed case may not match the lowercase target
   at `forward()` time. Check on a real account in M3.
3. Supported widths: phone 390 px, laptop 1280 px, wide 1920 px (`REQUIREMENTS.md`, Numbers).
   Tables stack below Astryx's sm breakpoint, 640 px (`DEFAULT_WIDTH_BREAKPOINTS.sm`); the
   media query now excludes 640 itself (`00f8945`).
4. The DNS check also looks up `cf2024-1._domainkey.<domain>` (TXT), the key Email Routing
   signs forwarded mail with. Name and form from the Cloudflare page cited in `dns.ts`
   (`v=DKIM1; h=sha256; k=rsa; p=<key>`): one v=DKIM1 record with a non-empty `p=` is found,
   none is missing, anything else is different (`4a14924`, `83bd958`).
5. A forward-only address never loses its last target: `DELETE /forward-targets/:id?detach=1`
   switches each forward-only address whose last target it was to store and forward in the same
   batch, and address create and update run the same correction in their batch. The web
   confirmation names the addresses using the target and the ones that start keeping a copy
   (`0a01fdb`). The 409 that asks for `?detach=1` first listed the addresses too; no caller
   read the list, so the re-review had it dropped (`67a7897`).

### Verified after the review and the rulings

- `bun --bun vitest run` in `worker/`: 132 tests.
- Red before, green after: "lets a forward-only address left without targets be edited"
  (review item 2, `expected 400 to be 200` before `bcc40dd`); "switches a forward-only address
  that loses its last target to store and forward", "lets a forward-only address without
  targets from before the ruling be edited" (red with the `worker/src/addresses` changes of
  `0a01fdb` stashed).
- Ablation of the new hunks (14): PATCH check only when changing forwarding (3 hunks), forced
  delete step-up and its condition, the DKIM name, missing rule, key rule and version tag, the
  detach switch and its last-target condition, the PATCH correction, the create correction: all
  red now, no survivor. The version tag first survived and got a test (`83bd958`). The create
  correction first survived because the parallel test (20 pairs per run) never reached the window
  between the target check and the batch; re-review item 1 replaced that loop with a
  deterministic test (`c145984`): a temporary trigger deletes the target right after the address
  row is written, and the address must come back `{ forwardOnly: false, targetIds: [] }`. Red
  with the correction removed, green with it (`bun ablate-m2b.ts create-keeps-targeted`).
- `bun run check` green at every commit; `bun run check:requirements` green with the widths
  row filled and its "Not yet enforced" row removed.
- Merge gate at `c145984`, 3 runs: 7.91 s, 7.86 s, 8.18 s wall (CPU load 51%, 3%, 3% before each
  run); worker suite vitest Duration 4.83 s, 4.82 s, 4.97 s. Limits 10 s and 6 s. Slower than the
  6.3-6.7 s / 3.85 s measured at `fea4c99` on the same host; not investigated (the step-up and
  ruling tests add setups and Passkey assertions).

### Re-review of ee668b6 ("PASS", two Lows)

1. The 20-pair parallel test never reached the race window: replaced by the trigger test
   (`c145984`), see the ablation line above.
2. The 409 `target_in_use` carried an address list no caller read, built outside `fail()`:
   dropped with its query and test assertion (`67a7897`).

### Review of fea4c99 ("FIX FIRST")

1. Risk class is High, not Medium (process). The plan above now says so and why. No code change.
2. A forward-only address left without targets by a detach could not be edited: PATCH refused
   even `{ enabled: false }` and `{ forwardOnly: false }` with `forward_only_needs_target`, and
   the dialog disabled the forward-only switch while it was on. PATCH now checks only when the
   request turns forward-only on or replaces the targets; the switch stays usable while on
   (`bcc40dd`). Test "lets a forward-only address left without targets be edited": before
   `expected 400 to be 200`, after green (`bun --bun vitest run test/forward-targets.spec.ts`).
3. Hypothesis: a create with targetIds racing a detach leaves a state no serial order gives.
   Not reproduced (that test was later replaced, see the re-review): test "ends a create racing a detach in a state some serial order gives"
   (`db5336d`) ran 20 pairs per run, 3 instrumented runs and 5 plain runs; every pair ended
   with the detach first and the create refused (`unknown_target`). By reading: a create that
   passes its target check before the detach and writes after it ends with the address
   forward-only and without links, the same state as create-then-detach, so no atomic guard was
   added then. Owner ruling 5 above removed that state altogether (`0a01fdb`).
4. README: migration 0004 must be applied right after the deploy, because setup, sign-in and
   recovery depend on it.
5. `NOTE_MAX` is one export in `domains/validate.ts` (`468a7c6`).

### Deferred

- `SecurityPage` still draws its own `Layout` and loading code; move it onto `PageFrame` and
  `useSettingsPage` when it is next touched (source: M2, consistency).
- Resend domain verification state (`domains` column) waits for M5, which owns its shape.
- The send switch is stored but has no effect until M5.

## M3: inbound mail (in progress, branch `m3-inbound`)

Design: `docs/M3-inbound.md`. Risk class High (stored data, mail delivery, migration 0005). Not
merged; waits for the independent review the risk class asks for.

### Done

- `d608929` migration `0005_inbound.sql`: `messages` (no foreign key on `address_id`, so
  deleting an address neither fails nor deletes its mail), three indexes, and `messages_fts`
  (FTS5, trigram tokenizer, written by hand after the generated SQL).
- `7464e49` bounded parse (`worker/src/mail/parse.ts`, postal-mime 4.2.1): first 64 KB, then
  the whole 256 KB slice only when the prefix has no text or HTML part; nesting depth 32, 500
  parts, header size capped. Fixtures in `worker/test/fixtures` (ASCII, `-text` in
  `.gitattributes`); the 20 MiB message is generated in memory.
- `055d29c` `email()` (`worker/src/mail/inbound.ts`): recipient lookup, reject before storing,
  forward-only forwarding with the audit row, R2 storage through `FixedLengthStream`, the
  `messages` row, forward-and-keep, enqueue. R2 bucket `MAIL` and queue producer `INBOUND` in
  `wrangler.jsonc`.
- `aa8c9f0` queue consumer and cron (`worker/src/mail/consumer.ts`): consumer `max_batch_size`
  1, `max_retries` 5, retry delay 60 s; cron `*/15 * * * *` re-enqueues up to 100 messages still
  `stored` after 15 minutes. REQUIREMENTS "Background work" now has a row.
- `b2dd4d2` `worker/bench/parse.ts` and its REQUIREMENTS number; its "Not yet enforced" row is
  gone.
- `9e16a97` linear HTML-to-text reduction (review of 2c9e9c4, item 1).
- Owner rulings: `830f76d` forward instead of bouncing, `e594fad` attempt counter (migration
  0006), `b44a34a` one 64 KB pass with tighter limits, `30ea82b` search builder, `a7a4f0b`
  concurrent gate (see Owner rulings).
- `a062220` drops a target dedupe that could not trigger; `d52e3c1` adds the ablation gap
  tests (see Ablation). README section "Inbound mail":
  migration 0005 right after deploy, the queue create command, the catch-all rule.

### Cloudflare facts checked (2026-11-16)

1. `forward()` after `message.raw` was read: the official local-development example reads the
   whole stream (`new Response(message.raw).arrayBuffer()`) and then calls `message.forward()`
   (https://developers.cloudflare.com/email-service/local-development/routing/). The design's
   order (store, then forward) is kept. Not run against the real service.
2. A thrown error in `email()`: not documented. The Workers API page
   (https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) documents
   only `setReject()`, "a permanent SMTP error". Community reports
   (https://community.cloudflare.com/t/is-it-possible-to-return-a-transient-failure-from-an-email-worker/599938,
   https://community.cloudflare.com/t/email-worker-upstream-error/457228) describe
   "521 5.3.0 Upstream error", also permanent. The handler still throws on an R2 or D1 failure
   (open question 1). Both sources are cited in `inbound.ts`.
3. Queue provisioning: the Wrangler configuration page lists Queues under automatic provisioning
   (https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning),
   and the installed wrangler 4.162.0 has a `QueueHandler` that creates a missing queue on
   deploy. The README still gives `wrangler queues create melodymail-inbound` for the error case.

### Verified, with the command

- `bun run check` green at every commit; each commit was checked with the rest of the tree
  stashed (`git stash push --keep-index -u`). The fixtures kept their CRLF (`od -c`,
  `git ls-files --eol` shows `i/crlf`).
- `bun --bun vitest run` in `worker/`: 192 tests after the review fix (184 before), 61 of them
  in `inbound.spec.ts`, `consumer.spec.ts` and `parse.spec.ts` against D1, R2 and Queues in
  workerd. The real queue delivers to the real consumer in the test runtime, so three tests run
  the whole path: `email()`, R2, queue, range read, parse, `parsed` row (one of them with a
  20 MiB message).
- Every test the design lists: rejects (unknown, disabled, receive off) store nothing; tag kept;
  any case matches; forward-only forwards once per target and stores nothing; loop header keeps;
  all forwards failing keeps (without forwarding again); store-and-forward stores first,
  forwards once, records a failure without throwing; an R2 or D1 failure throws before any
  forward; a queue send failure leaves `stored` and the cron step re-enqueues it to `parsed`;
  the consumer parses and is idempotent (sequential and concurrent redelivery); a refused parse
  becomes `parse_failed`; the FTS row is found by `MATCH`, Chinese included. Added: nothing
  throws after a forward when the audit or `forward_failed` write fails; forward errors are
  logged without addresses; a failing cron job is logged by name and fails the run.
- Charsets parse in workerd as in Bun: GBK, GB18030 (with a 4-byte character), Big5,
  ISO-2022-JP, Shift_JIS, EUC-JP; QP and base64 bodies; encoded-word subjects in Chinese and
  Japanese.
- Benchmark `bun worker/bench/parse.ts`, 3 runs (load 23-35%): worst fixture p95 0.67-0.79 ms
  (the 20 MiB slice), all fixtures p95 0.36-0.37 ms. Before the first pass was added, a full
  pass over 256 KB measured 1.3-2.2 ms median and 2.4-3.9 ms p95 at 40% load.

### Ablation

A script removes or inverts one behaviour hunk at a time in `worker/src/mail/*.ts` and
`errorText` in `worker/src/http.ts`, and runs the three M3 test files. 64 hunks: recipient
parsing (case, empty local part, tag split, empty tag), the lookup, each reject condition, the
target list, the loop header, the forward header, the caught forward failure, the forward-only
branch and its early return, the audit row and its caught failure, the R2 key layout, the row's
`forward_failed`, tag and `last_received_at`, forward-and-keep and its forward-only exclusion,
recording a forward failure and its caught failure, the enqueue and its caught failure, log
redaction; in the consumer the stored-only select, the range read, both `parse_failed` paths and
their guard, the FTS and UPDATE guards, the FTS sender fallback, the parsed status, thread key,
snippet and attachment flag, ack and retry; in the cron the age, status, order, limit, send, the
contained job and the failed run; in the parse the slice cap, the first pass and its condition,
the nesting limit, HTML to text, the text and snippet caps, both attachment rules, display
names, Cc, References, the thread key order and fallback, entity decoding and script removal.

First pass: 60 of 64 red. The gap tests in `d52e3c1` came from the earlier gaps (the writes after
a forward, redaction, the stored-only select, concurrent redelivery, the sender fallback) and from
two survivors of this pass: the slice cap (the old test could not see past the 8 KB text cap) and
the attachment flag for an attachment outside `multipart/mixed`. Both are red now.

Two survivors kept: `AND status = 'stored'` on the `parse_failed` UPDATE and on the `parsed`
UPDATE. The consumer selects only a stored row, and two deliveries of the same job parse the same
bytes, so they write the same values; no test can tell the guard from its absence. The guards
keep a later status from being overwritten if that ever stops holding. The FTS insert guard,
which does change the result under concurrent redelivery, is covered.

### Gate timing

| Point | Merge gate wall, 3 runs | Worker suite (vitest Duration) | CPU load before each run |
| --- | --- | --- | --- |
| Before M3 (`69563bb` with postal-mime installed) | 9.52, 8.93, 8.79 s | 5.95, 5.48, 5.36 s | 51%, 19%, 22% |
| M3 code before the ablation gap tests | 10.82, 10.73, 10.99 s | 7.01, 7.26, 7.44 s | 31%, 32%, 41% |
| M3 at `d52e3c1` | 10.78, 10.61, 10.60 s | 7.18, 7.07, 7.05 s | 54%, 24%, 38% |
| M3 at `9e16a97` (review fix 1) | 11.07, 10.63, 9.08 s | 7.16, 7.40, 6.31 s | 31%, 26%, 7% |

Both limits (10 s merge gate, 6 s slowest test package) are exceeded. The suite without the
three M3 files measured 6.26 and 6.54 s at the same time (load about 30%), so M3 adds about
0.7 s and the suite was already at the limit on this host. Transform is 79-80% of the suite
time; pre-bundling postal-mime in the vitest optimizer did not change it (7.30, 7.14, 6.49 s)
and was not kept. No test was weakened. Owner decision: re-baseline, or reduce (for example by
merging test files).

### Review of 2c9e9c4 ("FIX FIRST")

1. **Quadratic HTML reduction (High, reproduced).** `htmlToText` used `/<[^>]*>/g` and a lazy
   `<(script|style|head)...</\1>` regex, both quadratic on sender HTML. Fixed in `9e16a97`: one
   forward scan with `indexOf`; an unterminated tag, comment or skipped element drops the rest;
   the scan stops at twice the 8 KB text it needs. Reviewer's repro, `parseSlice` on a 60 KB
   `text/html` message, 3 runs each under Bun 1.4.4:

   | Input | Before | After |
   | --- | --- | --- |
   | normal HTML (`<p>hello world</p>` repeated) | 4.2, 0.6, 0.9 ms | 5.9, 1.8, 1.2 ms (first run includes warm-up) |
   | `"<"` repeated 60,000 times | 381, 377, 376 ms | 0.5, 0.5, 0.5 ms |
   | `"<head"` repeated 12,000 times | 238, 234, 243 ms | 0.5, 0.7, 0.5 ms |

   Six 250 KB adversarial bodies (`<` without `>`, `<head`, `<script ` never closed, `<!--`
   without `-->`, an attribute without `>`, `&amp` without `;`) are gated inputs of
   `bun worker/bench/parse.ts` (p95 0.13-0.25 ms over 3 runs) and unit tests that check the text
   returned. Ablation of the new hunks: 10, 9 red after one more test (text after 20,000 empty
   tags, for the one-space-per-run rule). Survivor kept: the output cap in the scan loop; the
   result is sliced to the same length afterwards, so only the work it saves differs.

2. **postal-mime on crafted input (measured; not changed).** `parseSlice` under Bun 1.4.4,
   100 runs each after 20 warm-up runs, CPU load 24%, current limits (500 parts, nesting depth
   32, header size 256 KB):

   | Input (within the 256 KB slice) | Median | p95 | Result |
   | --- | --- | --- | --- |
   | 499 parts of 1 byte (18 KB) | 2.05 ms | 3.69 ms | parsed |
   | 5,000 parts (over the limit) | 1.43 ms | 3.08 ms | throws, `parse_failed` |
   | nesting depth 31 | 0.14 ms | 0.43 ms | parsed |
   | nesting depth 2,000 (over the limit) | 0.12 ms | 0.33 ms | throws |
   | one 250 KB folded Subject | 1.52 ms | 2.73 ms | parsed, subject cut to 998 |
   | 5,000 `X-` headers | 1.82 ms | 3.46 ms | throws (header size) |
   | Subject of 12,000 B encoded words | 1.95 ms | 3.04 ms | throws (header size) |
   | Subject of 12,000 Q encoded words (GBK) | 2.20 ms | 3.59 ms | throws (header size) |
   | boundary never closed, 250 KB text part | 0.84 ms | 1.77 ms | parsed |
   | boundary never closed, 250 KB base64 part, no text | 1.65 ms | 3.22 ms | parsed, no text |
   | 499 base64 parts of 500 bytes, no text | 11.70 ms | 15.06 ms | parsed, no text |
   | one 250 KB line without CRLF | 0.08 ms | 0.20 ms | parsed |
   | 250 KB of bare CR | 0.05 ms | 0.11 ms | parsed |

   Over the 3 ms p95 budget: many parts (worst: 499 parts with no text, 11.7 ms median, both
   passes walk them), header-heavy messages, and a slice with no text part (open question 3).
   Measured with `maxPartCount: 50` and `maxHeadersSize: 64 KB` (then reverted): every input
   above except the no-text base64 part drops to p95 0.11-2.04 ms (the parts and header cases
   throw early, 0.15-0.86 ms median); the no-text base64 part stays at 1.90 ms median, 3.33 ms
   p95. Proposal for the owner (open question 9): lower `maxPartCount` to 50 and
   `maxHeadersSize` to 64 KB, so such messages become `parse_failed` quickly and the browser
   parses them; together with open question 3 (skip the full pass when the first 64 KB has no
   text), which bounds the last case. A real message with more than 50 MIME parts in its first
   256 KB, or more than 64 KB of headers across its parts, would then have no search text or
   snippet.

3. **Export with an FTS5 table (Medium, docs).** Reproduced locally:
   `bun run wrangler d1 export melodymail --local` fails with "cannot export databases with
   Virtual Tables (fts5)"; `--table messages` exports. M7 constraint, recorded below.

### M7 constraint: backups and messages_fts

- A whole-database `wrangler d1 export` fails while `messages_fts` exists, so PLAN's periodic
  export to R2 must export table by table (`--table`), skipping `messages_fts`.
- The search text lives only in `messages_fts`. A restore rebuilds it: after importing the
  tables, set `status = 'stored'` on the restored `parsed` rows (and clear their parsed columns
  if wanted); the cron step re-enqueues them, 100 per run, and the consumer re-parses each from
  its R2 object. The restore procedure in M7 has to say this, and that it costs one queue round
  per message.
- D1 Time Travel (PLAN's 7-day restore) is not an export and is not affected.

### Not verified

- Real Email Routing delivery, `forward()` to a real verified destination (including the M2
  note about a destination verified in mixed case against the lowercase target), and what the
  sending server sees when `email()` throws.
- `wrangler deploy` creating the queue and the bucket (no real account used).
- Production `cpuTime` of `email()`, the consumer and the cron run.
- Queue retry timing and the 24-hour retention on the Free plan: tests call the consumer
  directly for retries; only the immediate delivery runs in workerd.
- `forward()` after a failed R2 write that read part of `message.raw` (the forward-instead
  path of ruling 1): the docs show a forward after a full read only.

### Owner rulings (2026-11-16, reply "同意" to the M3 open questions)

1. **Storage failure forwards instead** (was open question 1, `830f76d`). An R2 or D1 failure in
   `email()` for an address with targets (and no loop header) forwards to them, writes the
   audit row `mail_forwarded_unstored` (address id, counts, and the key of an R2 object already
   written, for the M7 sweep) and returns; nothing is stored, so nothing forwards twice. It
   throws, so the sender gets the bounce, when no forward goes out: no targets, the loop header,
   a forward-only address whose forwards all failed, or every fallback forward failing. Tests:
   R2 failure with targets; D1 insert failure with targets (orphan named); no fallback forward
   going out; no targets (R2 and D1); loop header; forward-only with all forwards failing.
   Ablation: 7 hunks; the "no targets" condition survived (the fallback already rethrows with
   no targets) and was removed; the rest red.
2. **Attempt counter** (was open question 2, `e594fad`, migration 0006 `attempts` default 0).
   The consumer increments it in its own write before reading R2 or parsing. A failing fifth
   try sets `parse_failed` and acks; a delivery past 5 sets `parse_failed` without parsing; the
   cron sets `parse_failed` on stuck rows that used 5 tries and re-enqueues only the rest.
   Tests: 5 failed tries end `parse_failed` with the raw object kept; a success on try 3 ends
   `parsed`; a killed fifth try gives up on the next delivery without reading R2; the cron skips
   `parse_failed` and used-up rows. Ablation: 5 hunks, all red. `db:migrate:local` applied 0006
   on the local database with rows; a second run reported nothing to apply.
3. **Second pass at 128 KB**: replaced by ruling 9 before it was built.
4. **Short search terms** (was open question 4, `30ea82b`). `buildSearch` in
   `worker/src/mail/search.ts`: terms of 3 or more characters form one `MATCH` of quoted
   phrases; shorter terms each add an escaped `LIKE` over subject, sender and body; every term
   must match; no route until M4. Tests: 1-, 2- and 3-or-more-character Chinese, Japanese and
   Latin terms; every term required; `%`, `_`, `"`, `\`, column filters, `OR`, `NEAR`, `*` and
   an unbalanced quote taken literally. Ablation: 9 hunks; the sender column first survived and
   got a test (`张三`); all red.
5. **Concurrent gate** (was open question 8, `a7a4f0b`). `scripts/check.ts` runs the seven
   steps at once with `Bun.spawn`, prints each step's output and exit code, exits 1 when any
   fails; CI still calls `bun run check`. A planted lint violation made it exit 1 naming `lint`.
   Slowest test package limit 9 s (owner approval); merge gate limit stays 10 s.
6. **Settled as recorded**: the 20 MiB raw message fixture (was question 5), the header-only
   loop guard (question 7), and the parse benchmark checked by hand and in review rather than in
   the merge gate (question 6).
7. **Parse only the first 64 KB** (was open question 9, option A; replaces ruling 3,
   `b44a34a`). One postal-mime pass over 64 KB (the R2 range read is 64 KB); at most 50 parts
   and 64 KB of headers, over either the message becomes `parse_failed`; the second pass, its
   tests and its benchmark case are gone. A message whose text starts after 64 KB is `parsed`
   with an empty snippet and no search text; `has_attachments` comes from what the slice shows.
   Tests: more than 50 parts and more than 64 KB of headers are refused (parse level) and end
   `parse_failed` (consumer level); text after 64 KB gives `parsed` with an empty snippet; the
   15 fixtures are unchanged. Ablation: 4 hunks, all red. Benchmark, 3 runs of 200 per input,
   CPU load 2-6%: worst p95 1.20-1.61 ms over 36 inputs (15 fixtures, the 20 MiB message, text
   after 64 KB, the 13 crafted MIME shapes, the 6 adversarial HTML bodies); all inputs together
   median 0.07 ms, p95 0.52-0.57 ms. Every input is gated.

Verified after the rulings: `bun run check` green at every commit (each checked with the rest of
the tree stashed); 206 worker tests. Merge gate (concurrent), 3 runs at `a7a4f0b`: 6.52, 7.27,
7.78 s wall, worker suite 5.48, 6.12, 6.62 s, CPU load 14%, 9%, 10%. Both under their limits
(10 s, 9 s).

### Re-review of 5b9e290 ("FIX FIRST")

1. **Superlinear HTML text building (Medium, reproduced).** `htmlToText` appended to one string
   and read its last character back per tag. `a007117` collects the text in an array joined
   once and keeps the length and the trailing-space state in variables; the output is byte for
   byte the same for every fixture, crafted message and adversarial body (snapshot compared
   before and after). `parseSlice` under Bun, 200 runs: `<b>x</b>` x 7500 (60 KB) median
   3.85 ms, p95 4.61 ms before (the bench exited 1), median 0.63-0.81 ms, p95 0.74-1.05 ms
   after; 60 KB of table cells median 2.84 ms, p95 3.44 ms before, median 0.52-0.64 ms, p95
   0.78-0.87 ms after. Both are gated bench inputs and unit tests. Benchmark, 3 runs at load
   1-10%: worst p95 1.23-1.35 ms over 38 inputs. Ablation: 4 hunks, 2 red; the text-end
   tracking and the length count survive because they only bound the work under the 16 K cap,
   and the 8 KB text is the same either way.
2. **PLAN said 256 KB (Low).** `docs/PLAN.md` sections 2 and 4 now say 64 KB.

### Open questions for the owner

None open from M3.

### Deferred

- R2 objects without a row (a failed D1 insert after the R2 write) stay until the M7 sweep.
- The Durable Object notification after a parse arrives with the mail UI (M4).
- `has_attachments` is decided from the first 64 KB, so an attachment part that starts later is
  seen only through a `multipart/mixed` top-level type (ruling 7).
