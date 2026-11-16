# STATE

Working state for the current milestone. The plan is in `docs/PLAN.md`.

## M0: repository skeleton (done 2026-11-15)

- Bun workspaces `worker` and `web`; Bun pinned to 1.4.4. wrangler alone runs on Node (owner
  ruling); `bun run dev` starts the Worker and Vite, `bun run deploy` builds and deploys.
- Worker: Hono app with `GET /api/health` and a JSON 404 for unknown API routes; `email()` rejects
  every recipient until the address list exists (M2/M3). Static assets from `web/dist`, with
  `/api/*` always reaching the Worker.
- Web: React 19, Vite, Astryx 0.7.16 (neutral theme; the local `melody` theme extending it since M5c), `AppShell` with folder navigation and a
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

- Threading replies to mail started in MelodyMail: SES replaces any custom Message-ID (real
  Resend test), so a reply arrives as a new thread. A fix would need the delivered Message-ID
  (not returned by Resend) or matching on subject and participants. Source: real Resend test.
- The quota display may read one low if Resend's quota headers count before the request.
  Source: real Resend test; confirm against Resend's dashboard after the first deploy.
- `SecurityPage` still draws its own `Layout` and loading code; move it onto `PageFrame` and
  `useSettingsPage` when it is next touched (source: M2, consistency).
- Resend domain verification state (`domains` column) waits for M5, which owns its shape.
- The send switch is stored but has no effect until M5.

## M3: inbound mail (done 2026-11-16)

Merged through pull request #3 as `84a903f` after a third-round review PASS and CI green. Risk
class High. The "Not verified" list below needs a real Cloudflare account and stays open until the
first deploy.

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

## M4: web mailbox (done 2026-11-16)

Design: `docs/M4-mailbox.md`. Risk class High (sender-controlled HTML rendered in the owner's
origin, permanent delete, migration 0007). Merged as PR #4 (`1f713f5`) after review PASS on
`3314a5b`, both CI workflows green, and the owner's UI check.

### Owner rulings (2026-11-16)

- Browser-tier limit 21 s: approved.
- `GET /api/messages/:id` stays for the M6 REST API.
- The white mail background in dark mode stays (sender HTML is designed for white). A per-message
  dark-reading toggle is deferred to M4b, below.
- UI checked by the owner; merge approved.
- Bundle total limit raised from 610 kB to 770 kB (reply "同意并开始"); first paint (370 kB)
  stays the main gate. The postal-mime and DOMPurify chunks are the libraries themselves;
  smaller replacements would parse or sanitize less.

### Done

- `001ff64` migration `0007_mailbox_indexes.sql`: folder keyset indexes `(trashed, archived,
  received_at DESC, id DESC)` and `(starred, trashed, received_at DESC, id DESC)`, and a partial
  unread index (`WHERE read = 0`) for the counts. `IF NOT EXISTS`, additive.
- `9affb90` mailbox API (`worker/src/mail/routes.ts`): `GET /api/messages`, `PATCH
  /api/messages`, `GET|PATCH|DELETE /api/messages/:id`, `GET /api/messages/:id/thread`, `GET
  /api/messages/:id/raw`, `GET /api/search` (through a new `searchFilter`; `buildSearch` was removed
  in review fix 3), `GET /api/counts`. All guarded and in the route walk.
- `78821ec` `Hub` Durable Object (`worker/src/mail/hub.ts`, SQLite class in `wrangler.jsonc`
  migrations tag `v1`): hibernatable sockets tagged with the session id hash, `ping`/`pong`
  auto-response, `notify` after each parse in the consumer, `closeSessions` on logout, on
  "sign out other sessions" (`DELETE ... RETURNING id`) and on recovery. `GET /api/events` checks
  the session and that `Origin` equals the request's origin.
- `2b09d3a` reader core (`web/src/reader/`): postal-mime in a Web Worker, DOMPurify, sandboxed
  srcdoc frame with the CSP meta first, `cid:` to `data:` (2 MiB cap), remote images stripped and
  blocked until allowed, octet-stream downloads with a cleaned file name; browser security suite.
- `0e47732` screens: side navigation with counts (folders and one entry per address), search in
  the app bar, list with selection and bulk actions, infinite scroll, reader with thread,
  toolbar and attachments, side by side at 1280 px and wider, one pane below with the open message
  in the URL (`?m=`), live updates, shortcuts `j k Enter e # s u /`. Copy in zh-CN, en, ja-JP.
- `4d84c05` `scripts/seed-mail.ts`: posts every fixture to `wrangler dev`'s
  `/cdn-cgi/local/email` (Cloudflare docs "Test email routing locally", read 2026-11-16), so the
  real `email()`, R2, queue and consumer fill the local mailbox; README section "Mailbox".
- `3e3f559` end-to-end suite against `web/dist` with an in-memory API stand-in; CI workflow
  `.github/workflows/browser.yml`.

Usability references: Gmail's two-pane reading layout and shortcuts
(https://support.google.com/mail/answer/6594), Outlook's reading pane
(https://support.microsoft.com/office/use-and-configure-the-reading-pane-to-preview-messages-2fd687ed-7fc4-4ae3-8eab-9f9b8c6d53f0),
Fastmail's remote-images prompt. The shortcuts follow Gmail.

### Playwright under Bun

Works. `playwright` 1.65.0 (the library, not `@playwright/test`) is driven from `bun test`; it
launches the installed `chromium_headless_shell-1254`, which is why 1.65.0 is pinned (1.65.1
wants revision 1255, 1.64 wants 1248). `bunx --bun playwright install --dry-run
chromium-headless-shell` also runs under Bun. No Node fallback is used anywhere. The test runner
of `@playwright/test` was not tried.

### Rendering-security results (`bun run test:browser`, 32 tests, all green)

- Corpus, each through the real sanitizer and frame in Chromium: script tags (including a remote
  `SRC`), `onerror`/`onload`/`onmouseover`, `<meta http-equiv="refresh">`, `<base href>`, forms
  with inputs and `formaction`, `javascript:`/`data:text/html`/`vbscript:` and mixed-case
  `javascript:` links, SVG with script, `onload` and `foreignObject` iframe, `iframe`/`object`/
  `embed`/`video poster`/`link`, CSS `url()` (absolute and protocol-relative, in `<style>` and in
  `style=`), `@import`, remote `<img>`, 1x1 pixel, `srcset`, `background=`, `<picture><source>`.
  For each: the listed elements and attributes are gone, no `javascript:`/`vbscript:`/
  `data:text/html` survives, the frame has exactly `sandbox="allow-popups
  allow-popups-to-escape-sandbox"`, the srcdoc starts with the CSP meta, the referrer meta is
  present, no sender script posted a message, no popup opened and no remote request left the page.
- Links get `target="_blank" rel="noopener noreferrer"`; inline styles and `<style>` still apply.
- `cid:` image becomes `data:image/png` and loads in the sandbox (naturalWidth 1); a 2 MiB + 1
  byte inline part gets the placeholder; an unknown `cid:` keeps no source.
- HTML attachment: downloaded as `application/octet-stream` with the name
  `../../invoice<1>.html` cleaned to `_.._invoice_1_.html`; no popup, no navigation, no script.
- Each layer alone: with no layer the probes fire (two script messages, remote requests), which
  shows the checks can see a failure; the sandbox alone stops script; the CSP alone stops script
  and every remote load; the sanitizer alone stops script and remote images.
- End to end (built app): hostile message opens in the frame with the exact sandbox, CSP and
  `referrerpolicy`, the frame content renders, nothing remote is requested from the frame,
  opening marks it read, "Show remote images" then loads the pixel; the plain-text link opens a
  new tab without opener or referrer; the HTML attachment downloads without a popup; `j` then
  `Enter` opens, `s` stars, `e` archives and removes the row, `/` focuses search; bulk archive of
  two selected rows sends one `PATCH /api/messages`; 390 px has no sideways scroll and Back
  returns to the list; a Hub event puts the new message on top.

### Verified, with the command

- `bun run check` green at every commit; each commit was checked with the rest of the tree
  stashed (`git stash push -u -- <paths>`).
- `bun --bun vitest run` in `worker/`: 242 tests, 36 more than before M4 (`mailbox.spec.ts`,
  `hub.spec.ts`; the route walk lists the 10 new routes, each answering 401 without a session).
- `bun run test:browser`: 32 tests (23 security corpus, 3 file-name unit tests, 6 end to end),
  3 runs 15.62–15.92 s wall including the build, CPU load 0–3%.
- Merge gate `bun run check` at `a724ae4`, 3 runs: 6.80, 6.84, 6.90 s wall, CPU load 0–3% (limit
  10 s); worker suite 5.80 s (vitest Duration, last run; limit 9 s).
- Local `wrangler dev` (port 8787, started and stopped by this session): `bun
  scripts/seed-mail.ts` stored and parsed all 15 fixtures through the real queue (15 `parsed`
  rows); `db:migrate:local` then reported nothing to apply, and running `0007` again by hand
  succeeded on the database with rows.
- Screenshots, taken with Playwright against that `wrangler dev` and the seeded data (a session
  row written to the local D1, no Passkey): list, a message with an attachment and the HTML-only
  message, at 390, 1280 and 1920 px, light and dark, zh-CN, en and ja-JP (54 files, outside the
  repository). `scrollWidth` equalled the viewport width in all 18 combinations. Found and fixed
  from them: the bulk toolbar was cut off at 390 px (now icon buttons with tooltips), the date
  column took too much width, the reader padded twice in one-pane mode, and the sender repeated.

### Ablation

A script applies one mutation at a time and runs the touched suite (worker: `mailbox`, `hub`,
`authz`; web: the security corpus, or the end-to-end suite after a rebuild).

Worker, 55 hunks: every folder filter, the address filter, the keyset comparison, the id
tiebreak, the next-cursor rule, the limit, folder/cursor/address validation, boolean mapping, the
sender fallback, the bulk limit, id validation and dedupe, `COALESCE` per flag, the empty-change
refusal, both 404s, the thread trash split and order, each raw header, the streamed body, the
missing object, delete only from trash, the FTS delete, the R2 delete and its contained failure,
the audit row, 409 against 404, search without trash, the query length, the search cursor, both
count queries, the events origin and upgrade checks, the session header, the socket tag, the ping
auto-response, notify, the close code, both contained Hub failures, the Hub's own session check,
the consumer notify and the three session closes. First pass: 51 red, 4 survivors:

- the next-cursor rule (`>` against `>=`) and the Hub's refusal of an untagged upgrade: each got a
  test (a list that fills its last page exactly; a direct Hub fetch without the session header),
  both red when ablated;
- the bulk dedupe could not change a result (`IN (json_each)` is a set test) and was removed;
- `id DESC` in `ORDER BY` survives: the folder index already returns rows in `(received_at DESC,
  id DESC)` order, so no test sees the difference. Kept, because the keyset comparison depends on
  that order and a different query plan must not change it.

Web, 35 hunks (reader core against the security corpus and the file-name tests; app wiring
against the end-to-end suite after a rebuild): the sandbox value, the CSP `img-src`, the CSP meta,
the referrer meta, `FORBID_TAGS` as a whole and per tag (meta, base, link, video, iframe, form),
link `target` and `rel`, `cid:` to `data:`, the 2 MiB cap, the used Content-IDs, stripping and
flagging remote attributes, remote CSS in `style=` and in `<style>`, `FORCE_BODY`, the
octet-stream Blob, reserved characters and leading dots in file names; the frame's `sandbox` and
`referrerPolicy` attributes, plain-text link target, the remote-images switch, mark read on open,
removing a row that leaves the view, new mail on top, the `j` and `/` shortcuts, and the bulk
endpoint. First pass: 27 red, 7 survivors, 1 mutation that did not apply (fixed and run: red).
The style-attribute flag and both file-name rules got tests (`a724ae4`), now red. Four
survivors kept: `meta`, `base`, `link` and `iframe` in `FORBID_TAGS`. DOMPurify 3.4.18 already
drops these by default, so no test can tell; they stay so a change of DOMPurify defaults or
options cannot let them through.

Not ablated (no test reaches them): the download-progress state over 5 MiB, the error mapping in
`fetchRaw`, the socket backoff and the redirect to sign-in after close code 4001 or a refused
reconnect, infinite scroll, permanent delete from the reader UI (the route itself is covered by
the worker suite), expanding older thread messages, and revoking the object URL.

### Real Resend test (2026-11-16, owner and coordinator, local `wrangler dev`)

The owner put their own `RESEND_API_KEY` in `worker/.dev.vars` (never read by an agent) and sent
from a new address on their verified domain, without attachments.

- Three messages, to `delivered@resend.dev`, `bounced@resend.dev` and the owner's own mailbox
  (Send clicked twice quickly on the third). Local D1 afterwards: three outbound rows, all `sent`,
  each with a `resend_id`, `maybe_accepted = 0`; the double click made one row and one email.
- The owner's mailbox received the message; the owner reported it rendered correctly.
- Quota after the third send: `daily_used = 2`, `monthly_used = 3`. The owner's panel showed
  "Today 2". The headers most likely carry the count **before** the request (an earlier send this
  month explains the monthly 3). Not confirmed against Resend's dashboard; recorded as a deferred
  item, the display may read one low.
- **Message-ID:** Resend sends through Amazon SES, and the delivered Message-ID is SES's own
  (`<…-000000@ap-northeast-1.amazonses.com>`), unrelated to the Resend id. A probe that set a
  custom `Message-ID` header (a temporary local edit, reverted, never committed) was **not kept**:
  the delivered header was SES's again. So replies to a message started in MelodyMail cannot be
  threaded by our own Message-ID (open question 3 answered: known limitation, deferred).
- Not exercised: the webhook (cannot reach localhost), attachments (Resend cannot fetch from
  localhost), bounce status (`bounced@resend.dev` shows `sent` locally; the bounce is visible only
  in Resend's dashboard).

### Deviations from the design (decisions taken, open to the owner)

1. The frame has a fixed height (`70dvh`) and scrolls inside. The parent cannot measure an
   opaque-origin document and `allow-same-origin` is not added (the design's fallback).
2. "Show remote images" also loads CSS background images: the CSP governs both through
   `img-src`. Only `https:` is allowed after the switch. It applies to the open message only.
3. The list shows one row per message, not one per conversation; toolbar actions act on the open
   message, not the whole thread.
4. An address entry shows that address's Inbox; its count is the unread Inbox mail of it.
5. The thread view leaves trashed messages out unless the opened message is in Trash, where it
   shows only the trashed ones. Search leaves Trash out and pages newest first (rank order cannot
   be keyset-paged).
6. The `table-inbox` template needs a StyleX compiler, which this project does not have; the
   screens follow its structure (table with selection and row-status plugins, reading pane in
   the Layout end slot) without its StyleX parts and without the resize handle.
7. The browser suite is not in `bun run check` (16 s against the 10 s gate); it runs in its own
   workflow on pull requests touching `web/` and nightly on main. REQUIREMENTS now has a
   scheduled tier and an end-to-end wall time (limit 21 s, baseline 17.4 s after the review fixes).
8. Screenshots were taken with Playwright, not with the owner-facing browser tools; the
   orchestrator should show them to the owner (or retake them) before review.

### Open questions for the owner

1. Bundle total is 643.0 kB gzip (642.5 kB before the font fix) against the 610 kB limit (568.4 kB before M4). The parse worker
   (postal-mime, 30.6 kB) and the reader chunk (DOMPurify and the reader, 22.1 kB) load only when
   a message is opened. Options: count lazy reading chunks apart from the total, raise the limit,
   or cut elsewhere (the M1 analysis lists Astryx components and the router). First paint is
   314.6 kB (limit 370 kB) and holds neither library. The limit stays as it is (coordinator, review
   of 5d11b90).
2. (Resolved by review fix 6, `ee93a79`: Figtree is self-hosted.)
3. (Resolved by M4b, `815221c`: a hidden page reads `GET /api/messages/:id` for its
   notification; the REQUIREMENTS exception row is gone.)

### Deferred

- Dark-reading toggle for HTML mail: invert one message on request, images inverted back; the
  default stays white. Source: owner question 2026-11-16; waits for M4b.
- Flag changes are not pushed to other open tabs (only new mail is); a tab refetches on its next
  action or event. Source: this build; waits because the design sends only new-mail events.
- A socket whose session expires on its own (30 days, or 7 idle) stays open until the page
  reloads; its next API call answers 401 and goes to sign-in. Only logout, revoke and recovery
  close sockets.
- Permanent delete removes the FTS row by `message_id`, an UNINDEXED column, so it scans
  `messages_fts`. Storing the FTS rowid on the message would make it a key lookup (M3 schema).
- The `/` shortcut focuses the search field in the app bar; at phone width that field is inside
  the navigation drawer and is not focused.

### Not verified

- Durable Object hibernation billing, real WebSocket behaviour behind Cloudflare, and real mail
  arriving (need a deploy).
- The `browser` workflow has not run in CI (nothing was pushed); `playwright install --with-deps`
  under Bun on Linux is untested.
- Firefox and Safari rendering of the sandboxed frame; only Chromium was driven.
- A walkthrough with a real Passkey session in a real browser; the screenshots used a session row
  written to the local D1.
- WCAG contrast of the new screens was not measured.

### Review of 5d11b90 ("FIX FIRST")

1. **SVG links navigated the mail frame (Medium, reproduced)** — `37c8854`. The hook matched
   `tagName === "A"`; an SVG `<a>` reports lowercase, so `<svg><a href>` kept no target and a
   click loaded the sender's page inside the reader frame, where the frame CSP does not apply.
   Now matched by `localName` (`a`, `area`, and `img` for `cid:`). New corpus cases click an SVG
   link with `href` and with `xlink:href`: before the fix both failed (no `target`/`rel`);
   after, both have `_blank`/`noopener noreferrer`, the click opens a popup and the frame stays at
   `about:srcdoc`. The reviewer's `attack2.test.ts` now shows the frame still at `about:srcdoc`;
   `attack.test.ts` (41 vectors) shows nothing remote with all layers on. Its "sanitizer-only"
   leaks are CSS and SVG `<image>`/`feImage` loads, which the CSP blocks by design. Found with
   it: a relative link (`/api/...`) resolved against the app origin (srcdoc inherits the parent
   URL) and opened an app page in a new tab; links now keep only `http`, `https`, `mailto` and
   `tel`, asserted in the links test. Ablation: back to `tagName` turns both SVG cases red;
   dropping the scheme check turns the links test red.
2. **MailboxPage.tsx 481 lines** — `3d0250a`: split into `useMessageList`, `mailbox/actions.ts`,
   `BulkBar` and `ListBody`; the page is 256 lines, every web file is under 314. End-to-end
   suite unchanged and green.
3. **Dead search builder** — `7e0ca21`: `buildSearch`, `SearchQuery`, `SEARCH_LIMIT` and the
   rank flag are gone; the M3 search tests run `searchFilter` against `messages_fts` with every
   case kept (1/2/3+-character CJK and Latin, every term required, injection inputs literal).
4. **Sender repeated in the reader** — `d898cd5`: the thread line shows the display name with the
   address beside it; the header keeps tag, recipients and date. Re-shot (below).
5. **Vite proxy without WebSocket** — `ebd0012`: `/api` proxy entry now has `ws: true` (Vite
   `server.proxy` passes upgrades only with it; checked by reading the docs, not run); README
   local-run section updated. Still unverified: the app under Vite against the Worker's
   same-origin checks.
6. **Figtree from Google** — `ee93a79`: `@fontsource/figtree` 5.3.0 (OFL-1.1), weights 400–700,
   latin and latin-ext, built into `web/dist`; a Vite alias points the generated
   `astryx-themes.ts` import of the theme's `fonts.css` at `web/src/fonts.css`. No
   `fonts.googleapis.com`/`fonts.gstatic.com` reference is left in `web/dist` (grep). New
   end-to-end test: loading the app makes no third-party request and Figtree loads from
   `/assets/`; with the alias removed it and the hostile-frame test turn red.

Numbers after the fixes (`3d0250a`, vite build, gzip -6): first paint 314.6 kB (limit 370),
entry 15.6 kB, total JS + CSS 643.0 kB (limit 610, unchanged, open question 1). Font files, not
counted above: latin woff2 for the four weights 45.7 kB, all 16 woff2 70.5 kB (woff fallbacks
93.8 kB, fetched only by browsers without woff2).

Verified: `bun run check` green at every commit; 3 runs at `3d0250a`: 6.89, 7.21, 6.72 s wall,
worker suite 5.79, 6.09, 5.66 s, 242 tests, CPU load 0–3%. `bun run test:browser`: 35 tests, 3
runs 16.81–17.62 s, CPU load 1–5%. Screenshots re-taken (all 54, Playwright against a local
`wrangler dev` started and stopped by this session; `scrollWidth` equal to the viewport in all
18 combinations); zh-CN light and dark at 1280 px checked by eye: one sender line, Figtree
rendering.


### Re-review of e97407d ("FIX FIRST", two items)

1. **Scheme-relative links (Medium)** — `817b5f2`. `LINK_SCHEME` accepted `https:/api/x`,
   `http:api` and `http:\evil.example/h`, which resolve against the srcdoc base (the app's page).
   An http(s) link now needs `//` after the scheme: `/^\s*(https?:\/\/|mailto:|tel:)/i`. New
   corpus test with those three forms and `HTTPS:/x`, each as an HTML `href` and an SVG
   `xlink:href`: red before (the first form survived), green after. The reviewer's
   `bypass.test.ts` (20 forms, HTML and SVG each) against the fix: only absolute
   `https://`/`HTTPS://`, a leading-space and an entity-encoded `https://` link, `mailto:` and
   `tel:` keep their href; scheme-relative, backslash, protocol-relative, relative, query, hash,
   `blob:`, `data:`, `javascript:` and tab, newline or control characters inside the scheme lose
   it; the `http:/api/...` click opens no popup.
2. **`senderAddress` regex (Low)** — `a680ce5`. `>s*$` became `>\s*$`; `web/test/sender.test.ts`
   covers trailing whitespace (red with the old pattern, green now).

Verified: `bun run check` green at both commits; `bun run test:browser` 38 tests green.

## M4b: PWA, push notifications and dark reading (done 2026-11-16, PR #5, merge `15054c9`)

Design: `docs/M4b-pwa.md`. Risk class High (a service worker controlling the origin, the VAPID
private key, a table linking sessions to push endpoints, Worker requests to push services).
Branch `m4b-pwa`, not pushed.

### Library choices (checked 2026-11-16)

Web Push (Worker side), candidates from the design:

| Package | Last release | License | Dependencies | Tests | Open issues | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `@mmmike/web-push` 1.5.0 | 2026-10-23 | MIT | none | RFC 8291 Appendix A vector pinned byte for byte; CI on Node, Bun, Deno, Workers, Chrome, Firefox; 100% coverage badge | 0 | **chosen** |
| `@pushforge/builder` 2.0.5 | 2026-04-23 | MIT | none | unit and push integration tests | 1 open PR fixing a base64 fallback and `Math.random()` record padding | older, open hardening fix |
| `@block65/webcrypto-web-push` 2.0.0 | 2026-09-03 | MIT (package.json; the repository has no license file GitHub detects) | `uint8array-extras` | RFC 8291 vectors, snapshots | 1 (dependabot) | not zero-dependency |
| `@portable/web-push` 0.1.0 | 2026-10-27 (first release that day) | MIT | 4 `@portable/*` packages | monorepo | 11 (repository) | too new, Node 24 engines |

Reason: no dependencies, Web Crypto and `fetch` only (no `nodejs_compat` needed, though the
Worker has it for other reasons), the RFC test vector in its own suite, and a Workers CI job.
Risk: a single maintainer with few users; our own round-trip test (below) decrypts its output
with RFC 8291 code written from the RFC, so a regression in the library turns our suite red.
Its own endpoint allowlist (`isPushServiceEndpoint`) differs from the design's (it requires a
subdomain for Mozilla); the Worker uses its own allowlist from the design instead.

PWA: `vite-plugin-pwa` 2.0.0 (2026-10-03, MIT, peer `vite` ^8, the only major that supports Vite
8), `workbox-precaching`/`workbox-routing`/`workbox-window`/`workbox-build` 7.4.1 (2026-05-04,
MIT, its peer range), `@vite-pwa/assets-generator` 2.0.0 (2026-09-12, MIT, sharp 0.35; the
prebuilt `@img/sharp-win32-x64` needed no install script). All pinned exactly.

### Done

- `b8b03be` migration `0008_push_subscriptions.sql` (drizzle-kit, `IF NOT EXISTS`): `id`,
  `session_id` → `sessions.id` `ON DELETE CASCADE`, unique `endpoint`, `p256dh`, `auth`,
  `created_at`. `db:migrate:local` applied it to the local D1 holding 15 messages and 6
  sessions; a second run reported nothing to apply, and running the file again by hand succeeded.
- `884e0d6` push routes (`worker/src/push/`): `GET /api/push/key` (404 `push_not_configured`
  without VAPID), `PUT|DELETE /api/push/subscription`, `POST /api/push/test` (rate limited per
  session by the new `PUSH_LIMITER`, 5 per 60 s). Endpoint allowlist from the design, plus no
  userinfo and no explicit port; key lengths checked; one subscription per session; 10 kept.
  The Hub's `notify` now returns a promise and pushes when it reached no socket; sending joins on
  live sessions, deletes on 404/410, logs only the subscription id and status, TTL 24 h,
  urgency `normal`, 10 per send. All four routes are in the authz route walk.
- `f6636bc` `bun run vapid` (`worker/scripts/vapid.ts`), `worker/.dev.vars.example`, README
  "Notifications".
- `e4d4eb8` `ReaderToolbar.tsx` split out of `Reader.tsx` (288 → 203 lines), no behaviour change.
- `390377c` dark reading: `DARK_READING_STYLE` appended to the srcdoc on request, toggle
  (Astryx `ToggleButton`, `aria-pressed`) in the reader toolbar, dark theme and HTML body only,
  per message, not remembered.
- `2eceafa` the API stand-in of the end-to-end suite moved to `web/test/stub-app.ts`.
- `7afda7a` PWA: manifest, icons from `web/public/logo.svg` (`bun run --cwd web icons`), service
  worker `web/src/sw.ts` (injectManifest; precache, `NavigationRoute` with
  `denylist: [/^\/api\//]`, `SKIP_WAITING`, push, notificationclick, pushsubscriptionchange),
  registration after `load` from `src/pwa/register.ts`, update banner, offline state.
- `815221c` Settings > Notifications (`/settings/notifications`), page-side notification while
  hidden, error copy for `not_subscribed`, `push_failed`, `invalid_subscription`.
- `a90b6b7`, `c0abeaf` and the commit after them: tests added after ablation (below).

Usability references: Gmail desktop notifications
(https://support.google.com/mail/answer/1075549): off until turned on, the browser prompt only
after that click, one switch per device; GitHub Settings > Notifications as its own page.

### Proof

Worker (`bun --bun vitest run`, 287 tests, 45 more than before M4b, in `push.spec.ts` and
`push-hub.spec.ts`; `fetch` stubbed in every test, no request reaches a push service):

- every push route answers 401 without a session (route walk);
- allowlist: accepts the four hosts; refuses `http:`, other hosts, `fcm.googleapis.com@evil`,
  userinfo, a port, lookalike suffixes, the bare `push.apple.com`, IPv4 and IPv6 literals,
  `ftp:`, a non-URL and a 2 KB endpoint; key checks (64/66-byte and compressed points, standard
  padded base64, 15/17-byte auth, missing keys, non-object body);
- upsert by endpoint, one per session, endpoint moved between sessions, 10 kept, DELETE removes
  only this session's row;
- cascade: sign-out, "sign out other sessions", recovery and the expiry sweep each remove the
  session's subscription;
- Hub: pushes when no socket is open (payload decrypted: id, sender name, subject, address, no
  body text), address fallback, null subject, subject cut at 200 code points, nothing while a
  socket is open, nothing to an expired or idle session, at most the 10 newest per send, 410
  deletes, a 500 or a network error and a D1 failure never fail the parse, no endpoint in logs;
- `POST /api/push/test`: `Content-Encoding: aes128gcm`, `TTL: 86400`, `Urgency: normal`, a VAPID
  header whose ES256 JWT verifies against the public key (`aud` the push origin, `sub` the
  configured origin, `exp` in the future), and the body decrypts with the browser's private key
  (RFC 8291 code in `worker/test/push-helpers.ts`, written from the RFC, not from the library);
  404 without a subscription, 410 → 404 and row deleted, 500 → 502 without detail, 429 from the
  limiter, 404 without VAPID.

Browser tier (`bun run test:browser`, 57 tests, 19 more than before M4b):

- `notification.test.ts` (unit): payload to notification options (title, body with the address
  line, tag `message:<id>`, URL `/?m=<id>`), localized fallbacks, the test message, junk payloads;
  click target stays a same-origin path.
- `reader.test.ts`: the whole hostile corpus with dark reading on (no script, no remote
  request, no popup, sandbox and the CSP first unchanged, the style present); computed filters
  (root inverted, `<img>` and `url()` backgrounds inverted back, text not).
- `mailbox.test.ts`: toggle absent in the light theme and for a plain-text message; on, the
  srcdoc gains the filter after an unchanged CSP prefix, sandbox and `referrerpolicy` unchanged,
  nothing remote requested; combines with "Show remote images".
- `pwa.test.ts` (persistent context, service workers allowed): manifest fields and icons,
  `Page.getInstallabilityErrors` empty; the worker controls the page and after browsing Cache
  Storage holds `index.html` and the manifest but no `/api` URL; a navigation to `/api/counts`
  gets JSON; offline reload shows the shell, the offline banner and the list's offline state,
  no error boundary, and recovers when the network returns; a new `sw.js` makes the update banner
  appear and Reload moves the page onto the new worker; Settings > Notifications: not set up,
  subscribe on click (PUT body), test send, unsubscribe (DELETE), blocked; a hidden page with
  push on shows the notification itself (exact title and options), a visible page or push off
  shows none. Chromium's `PushManager` is replaced in these pages: the real one would register
  with Google's push service.

### Ablation

A script applies one mutation at a time and runs the touched suite (worker: `push`, `push-hub`,
`hub`, `authz`; web: the notification unit tests, the reader security suite, or the mailbox and
PWA suites after a rebuild).

Worker, 34 hunks: every allowlist condition (https, userinfo, port, exact hosts, suffixes,
length), the key checks (base64url form, point length, uncompressed point, auth length), the key
route's 404, one subscription per session, the endpoint moving sessions, the cap of 10 on PUT,
DELETE scoped to the session, the test route's limiter, not-configured, not-subscribed, gone and
failed answers, the VAPID subject requirement, TTL, urgency, delete on gone, the logged status,
both live-session conditions, the per-send limit, the subject cut, the display name, the address
in the payload, pushing only without sockets, and the contained push failure. 32 red, 2
survivors. The base64url form got a test (`a90b6b7`), now red. TTL survives: the library's default
is also 86400 s; the option stays so the design's value does not depend on a library default. The
per-send limit was tested before this run (`a90b6b7`); the allowlist's suffix length check could
not change a result and was removed in the same commit.

Web, 42 hunks: the dark-reading style (page, images, `url()` backgrounds, only on request), the
toggle's dark-theme and HTML-only conditions, the frame flag, the per-thread reset; the worker's
`/api` denylist, `SKIP_WAITING`, the shell fallback, registration after load, the update prompt;
the network store's probe, the API failure and answer reports and the offline event; the offline
route guard, the shell reload on recovery, the list's offline state, both banners; the
notification tag, URL, both fallbacks, the address line, the test message, both click-target
checks; the push page's not-configured, blocked, PUT, DELETE and key-mismatch paths; the
hidden-page visibility and push-on checks and the call on each event. 38 red, 4 survivors:

- the stale-key unsubscribe got a test (`pwa.test.ts`), now red;
- the per-thread reset of the dark set could never run (MailboxPage keys the reader by message
  id, so it remounts) and was removed; a test now reopens a message and expects dark reading off;
- the API answer report (`reportNetwork(true)` in `api()`) and the `offline` event survive: the
  2-second probe and the failing API call reach the same state, only later. They stay because
  they make the change immediate.

Not ablated (no test reaches them): the sign-in pages' banners (the stand-in is always signed
in), `pushsubscriptionchange`, `notificationclick` focusing or opening a window, the push event
handler itself (its logic is `notificationFor`, unit-tested), the iOS detection, and the
language choice of the worker's fallback copy.

### Numbers

- `bun run check`: green at every commit, 7.5–8.1 s wall in this session (limit 10 s).
- Bundle (vite build, gzip -6, the same script for both sides): first paint 319.0 kB (314.6
  before, limit 370), entry 16.2 kB (15.6), total 660.0 kB (643.1, limit 770). Service worker
  11.5 kB gzip, 33.0 kB raw, recorded apart. Precache: 130 entries, 2.1 MB.
- `bun run test:browser`: 57 tests, green; timing under "Open questions", 1.

### Deviations from the design (decisions taken, open to the owner)

1. **`VAPID_SUBJECT` setting.** The design asks for the app's own origin as the VAPID subject;
   the queue consumer and the Hub have no request to read it from, so it is a third setting
   (`wrangler secret put VAPID_SUBJECT`). Push stays off while any of the three is unset.
2. **Notifications is its own page** (`/settings/notifications`, in the Manage navigation)
   instead of a section on an existing page: each settings page is about one subject (GitHub has
   the same split). At 1280 and 1920 px the page is one section tall, like Security.
3. **Notification body** is the subject and, on a second line, the address the mail arrived at,
   so the payload's address field is visible. The title is the sender.
4. **Dark reading selectors**: `<picture>` is not listed (its `<img>` matches already; a second
   filter would invert it again) and `<video>` cannot reach the frame. "Elements with a
   background image" means an inline `style` with `url(` or a `background` attribute; a CSS
   gradient or a background set in `<style>` stays inverted, like text colours.
5. **Offline probe.** Besides the `online` event and the next API answer, the app asks
   `/api/health` every 2 seconds while it believes it is offline: the `online` event does not
   fire when the network is up but the Worker cannot be reached, and in Chromium it did not fire
   after a reload made while offline. `/api/health` now has a frontend caller.
6. **Offline route guards.** When `/api/auth/state` gets no answer, the guards let the cached
   page open (the shell, or the sign-in page) instead of failing; recovery runs the guards again.
   The shell shows no data without the API.
7. **Banner placement**: the AppShell banner slot (above the app bar) in the signed-in app, above
   the card on the sign-in pages; offline and update share these places.
8. **One subscription per session.** A new endpoint on the same session replaces the old row, so
   DELETE "the current session's subscription" is unambiguous.

### Owner rulings (2026-11-16, reply "1. 拆出去 2. 可以 3. 可以。推送测试看看")

1. The PWA suite is split out: `bun run test:pwa`, `.github/workflows/pwa.yml` (nightly, by hand,
   and on pull requests that touch the service worker or its build). Its limit is 15 s (baseline
   12.3 s plus 20%).
2. Notification content stays as built: sender, subject and arrival address, no body.
3. The icon is approved.
4. A real push test is allowed: from local `wrangler dev` to the owner's own browser through its
   push service.

### Open questions for the owner

1. **Browser-tier limit after the split.** `bun run test:browser` (47 tests) measures 21.44,
   21.59 and 22.30 s against 21 s. Main before M4b measured 19.9 s on the same host the same day,
   so the host is slower than at the 17.4 s baseline, and the new dark-reading tests add about 2 s.
   Proposed: 26 s (21.8 s plus 20%). **Ruled 2026-11-16 ("改"): 26 s.**

### Deferred

- `reader.test.ts` is 451 lines (415 before M4b), over the 314-line pass bar; the corpus could
  move to its own data file. Source: this build; it waits because it is a test-only refactor.

### Not verified

- Delivery through real push services (FCM, Mozilla, Apple, WNS); `pushsubscriptionchange`; a
  real `notificationclick` focusing a window; iOS Home Screen push; install on Firefox and
  Safari; Hub CPU time per push in production.
- Running under `wrangler dev`: the routes ran in workerd through the vitest pool against D1;
  no VAPID keys were put in the local `.dev.vars`.
- The sign-in pages' offline banner (no screenshot and no test; the stand-in is always signed in).
- WCAG contrast of the new banners and page was not measured.

### Screenshots

144 PNG files in the session scratchpad, folder `shots-m4b` (outside the repository): Settings >
Notifications not set up, off, on, blocked and unsupported (iPhone user agent), offline, and the
update banner, at 390, 1280 and 1920 px, light and dark, zh-CN, en and ja-JP; dark reading off
and on for an HTML newsletter (dark theme only, so 18 of them). `scrollWidth` equalled the
viewport width in all 144. Taken with Playwright against `web/dist` and the in-memory API
stand-in, not `wrangler dev`. The update banner also shows in the dark-reading shots (one
context per combination).

### Review of c0abeaf ("FIX FIRST")

Signing (1Password) was locked during these fixes; each is in the working tree with its commit
message in the session scratchpad; commit order `msgF.txt`, `msgH.txt`, `msgI.txt`,
`msgJ.txt`, then `msgG.txt` (this file). Bundle after the fixes: first paint 319.0 kB, total
660.1 kB, service worker 11.6 kB gzip.

1. **A kept browser subscription lost its row (High, reproduced).** The cascade deletes the row
   on sign-out, recovery, revoke or expiry, while the browser keeps its `PushSubscription`, so
   Settings > Notifications read "on" and nothing was pushed. `resyncSubscription()` in
   `web/src/pwa/push.ts` now PUTs the subscription again each time the signed-in shell mounts
   (`MailboxProvider`, a lazy chunk, not first paint): once per page load and once per sign-in in
   the same page, only with permission granted and only for a subscription made with the
   current key. New tests: the PWA suite opens the app with a kept subscription and expects one
   PUT for the current key and none for a stale one (red with the call removed, green with it);
   `push.spec.ts` signs out and in, PUTs again and expects the test send to be delivered (the
   server half the client relies on; it passes before and after, since the fix is on the client).
2. **One open page silenced every device (Medium, reproduced).** The Hub pushed only when it
   reached no socket at all. `notify` now collects the session tags of the sockets it reached
   and `pushNewMail` skips only those sessions (`p.session_id NOT IN json_each(?)`); a session
   with an open page still notifies itself while hidden. New tests: a subscribed phone gets the
   push while another session's page is open; a page of a session that expired on its own no
   longer blocks the push (both red before, green after); the same-session case still sends
   nothing. README "Notifications" now says "each device that has no MelodyMail page open"; the
   settings copy ("while MelodyMail is closed", on this device) already matched.
3. **Click target escaped the origin (Low, reproduced).** `"/\t/evil.example"` passed the prefix
   checks and `openWindow()` resolved it to `https://evil.example/`. `clickTarget(data, origin)`
   now resolves with `new URL(url, origin)` and keeps only a same-origin path, search and hash;
   the worker passes `self.location.origin`. The unit test adds `/\t/evil.example`,
   `/\evil.example` and `\evil.example` (red before, green after).

### Re-review of the fixes ("PASS", three Lows, all fixed)

1. **Click target (Low).** `"/.//evil.example"` and `https://<origin>//evil.example/x` normalized
   to the path `//evil.example`, which `openWindow()` would resolve against another host.
   `clickTarget` now returns the absolute `href` on the origin (or `<origin>/`). The unit test
   resolves each result against a foreign base and asserts the app's origin (red with the old
   path-only return).
2. **Design text (Low).** `docs/M4b-pwa.md`, "Sending", now states the per-session rule and the
   resync on shell mount.
3. **README (Low).** Sign-out ends a device's notifications until it signs in again.

Hypothesis left for a real device: a phone that suspends the page without closing its socket
counts as "page open" until the runtime notices, so it gets no push in that window.

### Real push test (2026-11-16, owner's Chrome Dev on Windows, local `wrangler dev`)

Allowed by the owner. Local VAPID keys in `worker/.dev.vars` (not committed).

1. Turning push on failed: `PUT /api/push/subscription` answered 400. A new log line
   `push_subscription_rejected` (host only) showed `jmt17.google.com`, the push service of Chrome's
   Dev and Canary channels and other non-stable Chromium builds (Chromium
   `push_messaging_constants.cc`). It was added to the allowlist; the accept test turned red
   without it and green with it.
2. Settings > "Send test notification": delivered.
3. All app tabs closed, one mail posted to `/cdn-cgi/local/email`: the consumer parsed it, the Hub
   pushed, the notification arrived after a delay (urgency `normal`; the push service decides
   timing), and clicking it opened the message.

Still unverified: Firefox, Safari and iOS delivery; stable Chrome's `fcm.googleapis.com` path
(covered only by stubbed tests).

## M5: sending through Resend (done 2026-11-16, PR #6, merge `f1a2bf9`)

Design: `docs/M5-sending.md`. Risk class High (mail to the outside world under the owner's
domains, two public endpoints, three secrets, migration 0009). Waits for the independent review
the risk class asks for, the owner's manual Resend test and the owner's look at the screenshots.

### Owner rulings (2026-11-16)

1. **Body editor: Markdown.** A plain text area; the browser renders it with a maintained library;
   raw HTML in the source is not rendered; DOMPurify before sending; links keep only http(s) and
   mailto; `text` = the Markdown source, `html` = the sanitized rendering in a minimal inline-styled
   document without remote resources; a Write / Preview toggle that previews in the sandboxed mail
   frame; replies quote with `> `; the library only in the compose chunk; first paint must not
   grow; drafts and the sent copy keep the Markdown source (and the sent copy the HTML).
2. **Real Resend test allowed.** The owner puts `RESEND_API_KEY` into `worker/.dev.vars`; the
   coordinator runs the manual test with the owner. The app works with only that key set:
   attachments say they are off without `UPLOAD_URL_KEY`, the webhook answers 404 without
   `RESEND_WEBHOOK_SECRET`. No real mail was sent in this build and `worker/.dev.vars` was not read.
3. **Open and click tracking stays off.** No tracking option is sent; Resend sets tracking per
   domain, so README "Sending" tells the owner to leave it off there.

Rulings on the review of `c1a3ebf` (2026-11-16):

4. **Signed attachment URLs.** `exp` is computed once when the sent copy is prepared, stored in
   it and signed from on every attempt, so a retry is byte-identical; the TTL is 24 hours, as long
   as Resend keeps an idempotency key. Resend's 409 `invalid_idempotent_request` and
   `concurrent_idempotent_requests` must not land as a retryable `failed`.
5. **Resend-reported delivery failure** (`email.failed`): final, no Retry, kept apart from a local
   send failure; the reader says Resend reported it and that the owner forwards the message or
   writes a new one; `claimRetry` refuses it server-side.
6. **Rejected send, then corrected.** After `send_rejected` the compose session gets a new key, so
   the corrected message is a new send and autosave keeps working; a draft save answers
   `already_sent` only for a message at `sent` or later. Network errors, timeouts and 5xx keep
   the key.
7. **First paint** goes back to about 319 kB through a chunk rule in `web/vite.config.ts`; the
   compose chunk stays separate with marked only in it.
8. **Browser tests:** the compose and Markdown suites move to `bun run test:send` with their own
   workflow, limit 14 s; `test:browser` comes back under 26 s.

Rulings on the re-review and the open questions (2026-11-16):

9. **Retry after 24 h (open question 4).** Narrowed by ruling 13. Re-sign with a fresh expiry only when the stored `exp`
   has passed, and write it back to the R2 sent copy so later retries stay byte-identical; safe
   because Resend's idempotency window has closed by then.
10. **A row stuck at `sending` (open question 5).** Its window part is replaced by ruling 13. The reader offers Retry when the row is older
    than 60 s and younger than 24 h, where Resend dedupes; past 24 h it shows "status unknown,
    check Resend" without Retry. `claimRetry` enforces the same window.
11. **The rejected row in Sent (open question 6)** stays as a final record: no Retry, no
    attachment downloads; `claimRetry` refuses it.
12. **REQUIREMENTS "Frontend entry chunk"** is redefined as the entry plus its statically
    preloaded JS, gzip, limit 270 kB.

### Library choices (checked 2026-11-16)

| Package | Release | License | Dependencies | Verdict |
| --- | --- | --- | --- | --- |
| `resend` 6.38.1 | 2026-11-13 | MIT | `postal-mime` 2.7.6, `standardwebhooks` 1.1.1 | **chosen** for the send call |
| `standardwebhooks` 1.1.1 | 2026-08-28 | MIT | `@stablelib/base64`, `fast-sha256` | **chosen** for the webhook signature |
| `svix` 2.10.0 | 2026-11-09 | MIT | `standardwebhooks`; 1.68 MB unpacked (the whole Svix API client) | not needed: it verifies through `standardwebhooks` |
| `marked` 18.2.0 | 2026-11-09 | MIT | none; GFM built in | **chosen** for Markdown |
| `markdown-it` 15.0.3 | 2026-10-16 | MIT | 6 (`linkify-it`, `entities`, `mdurl`, ...) | larger, more dependencies |
| `micromark` 4.0.3 (+ `micromark-extension-gfm`) | 2026-09-26 | MIT | 18 for the core alone | most CommonMark-exact, many small packages |

Resend SDK: one `fetch` per send and no retry of its own; `emails.send(payload, { idempotencyKey })`
sets `Idempotency-Key`; every answer returns the response headers, so the quota headers are read
on success and on error. It reads `process.env` only for an unset key, `RESEND_BASE_URL`,
`RESEND_USER_AGENT` and `RESEND_DEBUG`. The Worker passes the key and `baseUrl` (new var
`RESEND_API_URL`) and never sets `RESEND_DEBUG`, which would make the SDK log upstream error
text. The SDK's error `message` is upstream text and is never returned or logged.

workerd without `nodejs_compat`: a probe Worker importing `resend` and `standardwebhooks`, with a
config that has no compatibility flags, built with `wrangler deploy --dry-run` (200 KiB, gzip
42 KiB) and ran under local `wrangler dev`. `emails.send` against an unreachable base URL returned
the SDK's network error, and `Webhook.sign` reproduced Svix's published test vector
(`v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=`). The probe was removed afterwards.

Worker bundle (`wrangler deploy --dry-run`, gzip -6): 1074 KB raw / 220.0 kB gzip before, 1309 KB
/ 270.3 kB after (wrangler reports 264.8 KiB). The SDK brings its own `postal-mime` 2.7.6 beside
the Worker's 4.2.1. Workers Free allows 3 MB compressed.

Markdown: `marked` has no dependencies and GFM (tables, strikethrough, autolinks, task lists) in
its core. It is not exactly CommonMark in every corner case, which does not matter for mail the
owner writes. Renderer overrides: raw HTML escaped, images as their alt text, task boxes as ☑/☐.
DOMPurify (already in the project) runs as its own instance with a fixed tag list.

### Done

- `031cfc5` migration `0009_sending.sql` (drizzle-kit; every CREATE with `IF NOT EXISTS`):
  `messages` gains `bcc_hdr`, `resend_id` (unique), `idempotency_key` (unique), `error`, and an
  index `(direction, trashed, received_at DESC, id DESC)` for Sent; tables `drafts`, `uploads`,
  `webhook_events`, `send_quota`. `db:migrate:local` applied it to the local D1 holding 16
  messages; a second run reported nothing to apply. The four `ALTER TABLE ... ADD` statements
  cannot run twice by hand (as with 0006); wrangler's migration table prevents a second run.
- `df665b4` Worker (`worker/src/send/`): `POST /api/messages/send`, `GET /api/send/from`,
  `GET /api/send/quota`, drafts CRUD, `PUT|GET|DELETE /api/uploads[/:id]`, the public
  `GET /api/uploads/:id/blob` and `POST /api/webhooks/resend`, the Sent folder (Inbox now lists
  inbound mail only), two cron jobs, Hub event `changed`.
- `66776c8` README "Sending", `bun run upload-key`, `worker/.dev.vars.example`.
- `88a7021` web: compose (a panel from 1280 px, a page below), reply, reply all, forward, Markdown
  with Write / Preview, chips, attachments with progress, autosave, Discard with confirmation,
  the quota line, Sent and Drafts, status and Retry in the reader, shortcuts `c r a f` and
  Ctrl+Enter, copy in three locales (compose strings in their own `compose` namespace).
- `0dc8ea9` Worker tests for the ablation survivors; `0f85969` `useCompose` split (316 lines over
  the pass bar) into `compose/start.ts`; `1894fae` prefill unit tests, two stronger browser tests
  and the redundant link check removed.

Usability references: Gmail compose and shortcuts (https://support.google.com/mail/answer/6594):
`c` compose, `r` reply, `a` reply all, `f` forward, Ctrl+Enter send; a reply to one's own sent
message goes to its recipients, as in Gmail. Gmail and Outlook both list Drafts and Sent beside the
Inbox, autosave drafts and quote the source under "On <date>, <sender> wrote:".

### Proof

Worker (`bun --bun vitest run`, 315 tests at `c1a3ebf` (an earlier count of 336 was wrong), 324 after the review fixes, in `send.spec.ts` and
`send-extras.spec.ts`; `fetch` stubbed in every test, no request reaches Resend):

- route walk: the 10 new session routes answer 401 without a session; exactly the two public
  routes are marked public;
- the request to Resend: `Authorization`, `Idempotency-Key`, the quoted From display name,
  to/cc/bcc, subject, `text` (Markdown) and `html`, no tracking field; the stored row (`sent`,
  `resend_id`, thread key), the R2 JSON copy, the FTS row (search finds it), the quota row, the
  draft with the same key deleted; Sent lists it and Inbox does not;
- validation, each without a Resend call: domain without sending, disabled address, unknown
  address, 51 recipients, a non-address, no recipients, CRLF in the subject, unknown upload,
  31 MiB of attachments, unknown source, a malformed key;
- idempotency: a second request while the first waits for Resend gets 409 `send_in_progress`; a
  repeat afterwards returns the message; one call in total. A failed send and a `sending` row older
  than 60 s are sent again with the same key and the stored copy (a changed body is ignored); a
  fresh `sending` row answers 409;
- replies: `In-Reply-To`, `References` (source References plus its Message-ID), "Re:" once, "RE:"
  kept, the source's thread key, the reply shows in the source's thread; forward: "Fwd:", "FW:"
  kept, no thread headers;
- attachments go as `path` URLs on the request's origin that open the bytes through the public
  route; a sent upload cannot be deleted or attached again;
- error mapping: 429 daily and monthly quota, 429 rate limit, 422, 500 and a network error map to
  `daily_quota_exceeded`, `monthly_quota_exceeded`, `rate_limited`, `send_rejected`,
  `send_failed`, stored on the row; upstream text appears in neither response nor log; a
  malformed error name is logged as null;
- uploads: streamed in and out with octet-stream, `filename*` and nosniff; over 25 MiB 413; bad
  percent-encoding and a newline in the name 400; delete removes the R2 object;
- signed URL: valid; expired, another id, a later expiry, a changed signature, missing `sig`,
  missing `exp` and no parameters all 403 without detail;
- drafts: save, update, list, read with attachments, delete; another key for the same draft and
  the key of another draft 409; saving after the send 409 `already_sent`;
- webhook: Svix test vector; delivered, then a late delayed ignored, bounced final; a replayed
  `svix-id` does nothing; unknown email id and unknown type 200; bad signature, a 6-minute-old
  timestamp and a request without headers 401; 404 without the secret;
- cron: uploads older than 24 h without a live draft or stored message go with their R2 objects;
  young, live-draft and sent uploads stay; replay rows older than 7 days go;
- the quota reads 0 after Resend's UTC day; sending, attachments and the from list report "not
  set up" without their secrets.

Browser tier (`bun run test:browser`, 60 tests, 13 more than before M5):

- `markdown.test.ts`: headings, lists, tables, inline and fenced code, links, autolinks (`<...>`,
  `www.`, `mailto:`), strikethrough, task marks, inline styles; raw `<script>`, `<img onerror>`,
  `<b>` and a raw `<a>` shown as text; `javascript:`, `data:`, `vbscript:` and relative links lose
  their href; an image keeps only its alt text; the sent document has no `<link>`, `<style>`,
  `@import` or `<img>`;
- `compose.test.ts`: `c` opens compose; chips (a non-address refused and named); two files
  attached and one removed; a file over 25 MB refused in the browser; a double click on Send makes
  one request with the Markdown `text`, the sanitized `html` and the upload id; the message appears
  in Sent as "To: ..."; Reply from the toolbar prefills the sender, "Re: Note 1" and the `> `
  quote, and Ctrl+Enter sends with `sourceId`/`sourceKind`; `f` opens a forward with "Fwd:"; `a`
  opens a reply all; autosave waits 2 s (fake clock: nothing at 1.5 s, saved at 2.1 s) and the
  draft opens again from Drafts; a failed send shows the reason and "Send again" resends under the
  same key; the quota warning at 85/100, Send blocked at 100/100 and without a Resend key; Preview
  renders in the sandboxed frame with the CSP first, the script escaped, no `javascript:`, nothing
  remote.

- `quote.test.ts` (unit): "Re:"/"Fwd:" once, the `> ` quote, reply all without the owner's
  addresses, a reply to one's own message going to its recipients, a forward without recipients.

PWA tier (`bun run test:pwa`): 11 tests green, unchanged.

### Numbers

- `bun run check`: green at every commit; 3 runs at the end 8.3, 8.6, 8.6 s, CPU load 1% (limit 10 s); worker
  suite (vitest Duration) 7.40, 7.69, 7.71 s (limit 9 s), 315 tests (336 was a miscount). After the review fixes: below. One fresh-worktree run of `031cfc5` failed in
  the worker suite on a cold cache; it passed on the two reruns and the failure did not repeat.
- `bun run test:browser`: 60 tests green (55 end to end and corpus, 5 prefill unit tests); 3 runs
  31.17–34.07 s (wall 32.5–35.3 s including the build), CPU load 0–2%. The same host ran the 47 suites from before M5 in 20.06 s twice (21.3 s
  wall), so the 8 new tests add about 10 s. Over the 26 s limit: open question 2.
- `bun run test:pwa`: 11 tests green; 3 runs 10.35–10.57 s (wall 11.7–11.8 s), limit 15 s.
- Bundle (vite build, gzip -6, the same script for both sides; the script reproduces the recorded
  M4b numbers on main): entry 16.2 → 16.5 kB; first paint 319.0 → 322.9 kB (limit 370);
  total 660.0 → 736.4 kB (limit 770); the compose chunk `ComposeView` 51.8 kB gzip
  (marked, the compose screens and the Tokenizer, Selector, FileInput, SegmentedControl and
  TextArea components). marked is in no first-paint asset. First paint: open question 1.
- Worker bundle: 220.0 → 270.3 kB gzip (above, "Library choices").

### Ablation

A script applies one mutation at a time and runs the touched suites (worker: `send`,
`send-extras`, `authz`, `mailbox`; web: a rebuild, then `compose.test.ts` and `markdown.test.ts`),
then restores the file.

Worker, 64 hunks: email syntax, key format, file-name control characters and decoding, "Re:" and
"Fwd:" once, References with the Message-ID, the CRLF check, the signed URL's expiry, its id
binding, its parameter format and the blob route's check, uploads off without the key, the
25 MiB limit, delete only unsent and its R2 delete, octet-stream and attachment disposition on
download, drafts (already sent, conflict, key match), the from address (enabled, sending on),
recipient count, none, syntax, subject CRLF, unknown source, In-Reply-To, the source's thread key,
no thread headers on forward, unknown upload, the 30 MiB total, a sent upload not reusable, the
quoted display name, a repeat returning the message, 409 for a fresh `sending` row, retry of a
failed row, `Idempotency-Key`, the FTS row, status `sent`, quota from headers, draft deleted on
send, status `failed`, HTTP 429 for quota, the quota error names, 4xx as rejected, the error-name
filter, uploads linked to the message, the copy stored before the call, the webhook's signature,
replay guard, forward-only rank and 404 without the secret, the four cron conditions and its R2
delete, the cron job registration, the CSRF exemption of the webhook, Inbox inbound only, the Sent
filter, the quota's UTC day and sending off without the key. First pass: 58 red, 5 survivors and
one mutation that did not apply. The five got tests (`0dc8ea9`): the Sent filter, "FW:" kept, a
sent upload attached again, a malformed error name, the quota's UTC day; with the blob-route
mutation fixed, all six are red. 64 of 64 red.

Web, 33 hunks (compose and Markdown against a rebuild and the compose and Markdown suites; the
prefill against `quote.test.ts`): raw HTML as text, images as alt text, the link scheme check
(twice), the tag allowlist, inline styles, task marks, the double-click guard, one key per
session, the HTML part, the source kind, the upload ids, the 2 s debounce, the 25 MB check,
Ctrl+Enter, Send blocked by the quota and without a Resend key, the preview through the reader's
sanitizer, chips refusing non-addresses, the `c`, `a` and `f` shortcuts, the "To:" line in
Sent, the reply button, and in `quote.ts` "Re:" and "Fwd:" once, own addresses left out of reply
all and Cc, a reply to one's own message, a forward without recipients and the `> ` quote. First
pass (26 applied, one mutation that did not apply): 19 red, 7 survivors. Fixed (`1894fae`): the
prefill got unit tests (all 7 `quote.ts` hunks red); the not-set-up test no longer leans on the
used-up quota (red); the preview test asserts the reader's link attributes (red); the link scheme
was checked by a DOMPurify hook and by `ALLOWED_URI_REGEXP`, each enough on its own, so the hook's
check was removed (the allowlist alone, ablated, is red). Two survivors kept: the tag allowlist
(raw HTML is already escaped and DOMPurify's defaults drop the dangerous tags; it stays so an
option change cannot widen the output) and the double-click guard in `useCompose` (the Send
button's loading state already blocks the second click; the guard covers a second Ctrl+Enter
before that state renders). The test counts the script printed for some red hunks are not
reliable (it read the wrong line of Bun's summary); only red or survived is recorded.

Not ablated (no test reaches them): pushing nothing for a `changed` Hub event and refreshing
listed messages on it (the Hub tests cover only new mail), `notifyWhenHidden` only for new mail,
the stale-row path when the stored copy is missing, the Drafts list refresh after compose closes,
upload progress, Discard deleting the draft and its uploads, the forward's re-uploaded
attachments, the reply-from address choice, and the Settings quota section.

### Review fixes (review of `c1a3ebf`, rulings 4–8)

Commits, oldest first: `a0cba04` test upstreams unresolvable, `0fa489d` stored URL expiry,
`d4bf860` idempotency conflicts, `14e098e` `delivery_failed`, `de49981` new key after a
rejection, `564b9eb` webhook race, `b15083a` webhook body cap, `1894adc` vendor chunk,
`34af786` shorter compose tests, `07060b0` `bun run test:send`, `2590830` no quota write on a
conflict, `96c31e0` and `579ae1b` tests found missing by ablation, `86cefed` the review tests in
one file (`worker/test/send-resend.spec.ts`).

- **Ruling 4, URLs.** `SentCopy.attachmentsExpireAt` is set in `prepare` (now + 24 h);
  `deliver` signs from it. Test: a send with an attachment fails with 500, the retry runs with
  `Date.now` ten minutes later, and the two request bodies are byte-identical; `exp` is 24 h
  ahead. The origin still comes from the request, so a retry through another hostname (for
  example `workers.dev` instead of the custom domain) would change the body.
- **Ruling 4, 409.** `errorCode` maps 409 `concurrent_idempotent_requests` and
  `invalid_idempotent_request` (names checked in resend.com/docs/api-reference/errors,
  2026-11-16) to `send_in_progress`; `deliver` then leaves the row `sending`, writes nothing and
  answers 409 `send_in_progress`. Chosen because the first request's success only updates a row
  still `sending`: any other state written by the conflicting attempt could land first and
  overwrite that success, and leaving the row alone needs no new state. After the 60-second
  stale limit a repeat may claim the row again, and Resend answers it with the first result.
  Test (both names): the first request waits inside the Resend stub, the row is made stale, a
  repeat gets the 409, the row stays `sending`, the first request finishes and the row is
  `sent` with its `resend_id`.
- **Ruling 5.** Own status `delivery_failed` (smaller than an error code: no special case in
  `claimRetry`, `DONE` or `SentStatus`'s Retry path; the status column has no CHECK, so no
  migration). The webhook maps `email.failed` to it; it ranks with the final states; a repeat
  returns the message; `claimRetry` takes only `failed`. The reader shows an error banner
  without Retry: en "Resend reported that this message could not be delivered. To send it
  again, forward it or write a new message.", zh-CN and ja-JP likewise; Sent shows the
  "Delivery failed" badge. Tests: worker (webhook, then a repeat returns the message without a
  Resend call) and browser (seeded message opened by URL: badge, banner, no "Send again").
- **Ruling 6.** Worker: a draft save answers `already_sent` only for status other than
  `sending` and `failed`; the draft upsert takes a new key only when the old key's message
  failed with `send_rejected`; a rejection clears `message_id` on its uploads, and a send no
  longer clears an upload's `draft_id`, so the draft lists the attachments again. Browser: on
  `send_rejected` `useCompose` takes a new key and saves the draft at once; compose shows no
  Retry for a rejection. Found while fixing: without the upload hand-back the corrected message
  failed with `unknown_upload`. Tests: worker (after a 500 the draft saves, the key cannot move
  and the upload cannot be deleted; while `sending` the draft saves; after a 422 the draft
  moves to a new key, lists the attachment, and the corrected send goes out under the new key
  with the attachment and deletes the draft) and browser (failure retried under the same key,
  then a rejection without Retry, the draft saved under a new key, the corrected message sent
  under it).
- **Ruling 7.** A code-splitting group in `web/vite.config.ts` puts every `node_modules` module
  that the HTML entry reaches by static imports into one `vendor` chunk; app code and lazy
  chunks keep the automatic split. A first try that grouped every first-paint module also
  folded the entry into one 261 kB chunk (near the 270 kB entry limit); the vendor-only rule
  was kept. Without the rule (measured at `b15083a`): 322.9 kB.
- **Ruling 8.** `test:send` in `web/package.json` and the root; `test:browser` ignores
  `compose.test.ts` and `markdown.test.ts`; `.github/workflows/send.yml` (nightly 03:57, by
  hand, pull requests on `web/src/compose/**`, `SentStatus.tsx`, `sentCopy.ts`,
  `ReaderToolbar.tsx`, `SendStatusLabel.tsx`, the two suites, `stub-send.ts` and the workflow).
  To fit 14 s with the build, the compose suite builds its 25 MB file inside the page instead of
  sending it over CDP (3.5 s to 2.3 s for that test), seeds the delivery-failure message, and
  runs the failure and rejection in one session.
- **Low, test count.** 315 at `c1a3ebf`, 324 now; REQUIREMENTS and this section corrected.
- **Hypothesis A, webhook race: reachable, fixed.** A test that posts `email.delivered` from
  inside the stubbed Resend call (before `resend_id` is stored) got 200 and the svix-id was
  recorded, so Resend would never deliver it again. Now an event whose email id no message
  carries answers 409 and is not recorded; Resend's retry with the same svix-id lands after the
  id is stored. An id that is not ours is retried on Resend's schedule until Resend gives up.
- **Hypothesis B, webhook CPU: fixed.** `standardwebhooks` verify measured in Bun (30 runs per
  size): 4 KB 0.04 ms median, 256 KB 0.88 ms, 1 MB 3.02 ms, 4 MB 12.15 ms. Resend publishes no
  size; its email events carry ids, addresses, subject and timestamps. A body over 256 KB now
  answers 413 before verification; test: a signed 256 KB+ body gets 413, `verify` is never
  called, the status is unchanged, a normal event still passes.
- **Hypothesis C, real traffic from tests: one gap, fixed.** Every Resend call in the tests goes
  through `stubResend`, and `apply-migrations.ts` rejects any other fetch in `beforeEach`; but
  the bindings named the real `https://api.resend.com` and DoH URL, so a request after a mock
  was restored would have gone out. The test bindings now name `.invalid` hosts. Also found:
  wrangler loads `worker/.dev.vars` (the owner's real key) into the test environment; the test
  binding wins, and a test asserts the Worker sees the fake key (compared as a boolean so a
  failure cannot print the key). The file itself was not read.

Ablation of the review fixes (one mutation at a time, the touched suites rerun, the file restored
from a copy): worker 20 hunks, all red against the final test files: the two `.invalid`
bindings, signing from the stored expiry, the 24 h TTL, the expiry in the copy, the 409 mapping,
leaving the row `sending`, `email.failed` to `delivery_failed`, `delivery_failed` in `DONE`,
`already_sent` only at `sent` or later and not for `sending`, the key rotation clause, rotation
only after `send_rejected`, the draft taking the new key, the upload hand-back, the hand-back
only on a rejection, an upload keeping its draft id, not recording an unmatched event, its 409,
the body cap. Web 5 hunks against a rebuild and `compose.test.ts`: the new key, the immediate
draft save, no Retry for a rejection and the reader banner are red; the `delivery_failed` badge
variant survives (the label is the same as plain text and Astryx Badge exposes no attribute to
assert; the other attention statuses have the same untested shape). First pass: 21 of 25 red;
the four survivors were test gaps, fixed in `96c31e0` and `579ae1b`. The vendor chunk rule is
proved by measurement, not a test.

Numbers after the review fixes (2026-11-16, dev workstation, Ryzen 9 9950X3D):

- `bun run check`: green at every commit; 3 runs at `86cefed` 9.64, 10.01, 9.05 s wall, CPU load
  1–3%, and 3 more 9.17, 9.10, 9.59 s; worker suite (vitest Duration) 7.82–8.83 s over those
  runs, 324 tests. One run reached the 10 s limit. One gate run during the vendor-chunk work
  failed in the worker suite with a probe file in `web/`; four reruns passed and the failure did
  not repeat.
- `bun run test:browser`: 52 tests; 3 runs 21.90, 21.45, 21.71 s wall including the build, CPU
  load 1–10% (limit 26 s).
- `bun run test:send`: 9 tests; 3 runs 12.53, 13.20, 12.37 s wall including the build, CPU load
  0–3% (limit 14 s).
- `bun run test:pwa`: 11 tests green; 11.76 s wall (one run; limit 15 s).
- Bundle (vite build, gzip -6, the same script as before; 3 builds identical): entry 16.5 →
  3.4 kB; first paint 322.9 → 311.8 kB (319.0 before M5), 7 assets instead of 31; total 736.7 →
  715.5 kB; compose chunk 51.4 kB, the only chunk with marked.

### Second fix round (re-review of `c1a3ebf..06e2c7b`, "FIX FIRST")

Commits: `f5300a4` a rejected send is final, `ced05f7` the stored origin, `b464062` re-signing an
expired URL, `70fa3df` Retry for a send stuck at `sending`, `c7500d7` the `Content-Length` cap,
`a6c3287` the `send.yml` paths, and the docs commit after them. New worker tests are in
`worker/test/send-resend.spec.ts`; the browser test for the reader states is in
`web/test/compose.test.ts` ("offers Retry in the reader only where it may still send").

- **[High] Reader Retry of a `send_rejected` row.** `claimRetry` takes a `failed` row only when
  its error is not `send_rejected`; a repeat under that key answers 422 `send_rejected` without
  a Resend call. The reader shows the rejection without Retry and lists no attachments for it
  (they went back to the draft). Tests: worker (after the rotation, a Retry with the old key
  answers 422 and Resend's call count stays 1; the corrected send then goes out once) and
  browser (rejected row: banner, no "Send again", no attachment name).
- **Ruling 9 (Q4).** On a retry whose stored `exp` has passed, the route signs a fresh one and
  writes it back to the R2 sent copy. Test: a retry 25 h later carries `exp` = that time + 24 h,
  the R2 copy holds it, and the next retry 10 minutes on sends a byte-identical body.
- **Ruling 10 (Q5).** `claimRetry` takes a `sending` row only between 60 s and 24 h after its
  last attempt (`SENDING_RETRY_MAX_MS`); older answers 409 without a call. The reader offers
  Retry for a `sending` row in that window ("Not finished sending") and, past 24 h, a warning
  "Status unknown" telling the owner to check the Resend dashboard, without Retry; copy in en,
  zh-CN and ja-JP. Tests: worker (25 h old refused with no call, 23 h old sent) and browser
  (10 s: no Retry; 25 h: the unknown banner, no Retry; 5 minutes: Retry sends
  `{ idempotencyKey }`).
- **Ruling 11 (Q6).** The rejected row stays in Sent as a final record (the High fix).
- **Ruling 12.** REQUIREMENTS "Frontend entry chunk" now measures the entry chunk plus the JS
  that `index.html` preloads statically: 263.0 kB (5 files) against 270 kB. No script in the
  repository reads that row; the measuring script is the session's bundle script plus a sum of
  the preloaded JS.
- **Hypothesis 1, another hostname.** The origin is stored in the sent copy with the expiry and
  every attempt signs from it. Test: a send fails, the retry comes through
  `https://mail.other.test`, and the two bodies are byte-identical.
- **Low, webhook.** A `Content-Length` over 256 KB answers 413 before the body is read; the
  length read is still checked for a chunked body. Test: a declared-length request gets 413 and
  `Request.prototype.arrayBuffer` is never called; a stream body without a length gets 413 and
  the signature is never checked.
- **Low, `send.yml`.** Paths added: `web/vite.config.ts`, `web/package.json`,
  `web/src/locales/*/compose.json`, `web/src/reader/MailFrame.tsx`,
  `web/src/reader/sanitize.ts`.

Ablation of the second round (same method): 13 hunks, all red. Worker: `claimRetry` refusing
`send_rejected`, the 422 answer, signing with the stored origin, re-signing an expired URL,
writing it back, the 24 h bound for `sending`, the `Content-Length` cap, the read-length cap.
Web, against a rebuild and `compose.test.ts`: no Retry for a rejection in the reader, no
downloads for it, Retry for a stalled send, the unknown state after 24 h, no Retry under 60 s.
Not ablated: the Banner colour (warning for a stalled or unknown send, error for a failure),
which no test can tell apart.

Numbers after the second round (2026-11-16, dev workstation, Ryzen 9 9950X3D):

- `bun run check`: 9.20, 9.18, 9.46 s wall, CPU load 0–7%; worker suite (vitest Duration)
  7.98, 7.99, 8.22 s; 327 worker tests.
- `bun run test:browser`: 25.14, 21.66, 20.73 s wall including the build, CPU load 1–4%
  (limit 26 s). The first run of the series was slow (23.57 s of test time against 19–20 s),
  as in the reviewer's single run of 25.2 s; the margin under 26 s is small.
- `bun run test:send`: 13.13, 12.89, 12.67 s wall including the build, CPU load 0–3% (limit
  14 s).
- `bun run test:pwa`: 12.25 s wall, one run (limit 15 s).
- Bundle (3 builds identical): entry plus statically preloaded JS 263.0 kB; first paint
  311.8 kB; total 715.9 kB; compose chunk 51.4 kB.

### Third fix round (third review of `m5-sending`, rulings 13 and 14)

Commits: `6dd5cb2` the retry window from the first attempt (Worker, migration 0010, design doc),
`a4053a1` "Send as a new message" in the reader and compose, and the docs commit after them.

Rulings of 2026-11-16 on the third review:

13. **Retry window from the first attempt** (replaces the window part of ruling 10 and narrows
    ruling 9). Every message stores the time of its first attempt; the window is that time plus
    24 h minus a safety margin. Inside it, a Retry of a non-final row (stale `sending`, or
    `failed` other than `send_rejected`) sends the same body under the same key and is never
    re-signed. Past it, a row whose outcome is unknown (`sending`, or `failed` after a network
    error, a timeout or a 5xx) is refused with 409, left unchanged, and nothing is called; the
    reader shows "Status unknown, check Resend" with "Send as a new message", which opens compose
    prefilled from the sent copy under a new key with a warning that the earlier message may
    already have been delivered. Re-signing after `exp` only when every attempt on the key got a
    definite "not accepted" (429). Copy in zh-CN, en and ja-JP.
14. **Browser tier limit** 26 s → 30 s (owner approval 2026-11-16).

- **[Medium] The sliding window.** New columns (migration `0010_send_window.sql`):
  `first_attempt_at`, set at insert, before the first Resend request; `maybe_accepted`, set by an
  attempt whose outcome is unknown and never cleared. The stored `attachmentsExpireAt` was not
  used: ruling 9 moved it on every re-sign, it lives in R2 where the claim cannot read it
  atomically, and the flag needs D1 anyway. Margin: **5 minutes** (`RETRY_WINDOW_MARGIN_MS`), so
  the window is 23 h 55 min (`RETRY_WINDOW_MS`). The route decides from the row it read:
  - past the window and unknown (status `sending`, or `maybe_accepted = 1`), not a rejection:
    409 `send_status_unknown` with the message id, no write, no call;
  - past the window, `failed`, `maybe_accepted = 0` (every attempt a 429, or a local failure
    before any call): claimed as a fresh first attempt; `first_attempt_at` moves to now and the
    attachment URLs are re-signed and written back. Moving it is safe because Resend accepted
    none of the earlier requests; if Resend kept the key anyway, a different body under it gets
    409 `invalid_idempotent_request`, which leaves the row `sending`;
  - inside the window: the claim of rulings 4 and 10, same stored body, never re-signed.
  `maybe_accepted` is set by `send_failed` (5xx, network error, timeout: the SDK reports no
  status) and by taking over a `sending` row (an attempt that never answered); a 429 leaves it
  alone; a 4xx is final as before. The fresh claim also requires `maybe_accepted = 0` in SQL,
  against a concurrent attempt that ended unknown between the read and the claim. The message
  detail returns `firstAttemptAt` and `maybeAccepted` for the reader.
  Migration: outbound rows from before it that are unfinished get `first_attempt_at = 0` and
  `maybe_accepted = 1` (unknown, past the window: only "send as new"); finished ones get
  `received_at`. Production holds no outbound rows (not deployed).
- **Reviewer's note on ruling 9.** Re-signing now happens only past the window and only for a
  row with `maybe_accepted = 0`; a `failed` row from a network error, a timeout or a 5xx is
  refused instead.
- **"Send as a new message".** Compose kind `again` (URL `kind=again&src=<id>`): from address,
  To, Cc, Bcc, subject and Markdown text from the sent copy; no reply source and no thread
  headers; a new idempotency key (a new compose session); a warning Banner. Attachments are
  **copied**: the browser downloads each through `GET /api/uploads/:id` and uploads it again for
  the new draft, as a forward of a sent message already does. Re-referencing would need a join
  table and would let one upload belong to two messages; copying keeps `uploads.message_id`
  single, so the old message keeps its uploads (never deletable, never attachable again) and the
  new message owns its copies. The old row stays as a record. Worker side the new send is an
  ordinary send; no server change was needed.
- **[Low] 409 `send_in_progress` in the reader.** The status is left alone (a toast explains);
  409 `send_status_unknown` switches the banner to the unknown state with "Send as a new
  message", whatever the browser's clock says.
- **[Low] REQUIREMENTS "Full end-to-end run, wall time"** now carries the same numbers as the
  scheduled tier row.
- **Ruling 14.** REQUIREMENTS lines 37 (tier) and 54 (end-to-end) say 30 s with "owner approval
  2026-11-16". No CI or test timeout encoded 26 s: the workflows use `timeout-minutes: 10` and
  bun a 20 s per-test timeout.
- **Hypothesis 3** (a rejection on a retry past 24 h released the uploads of mail that may have
  gone out): no longer reachable. A retry past the window is sent only for a row with
  `maybe_accepted = 0`, so no earlier attempt can have been accepted, and a 422 on it releases
  uploads of a message that never went out. A row that may have gone out is refused before any
  call and keeps its uploads. Tests: the reviewer's scenario asserts the upload still answers
  409 to a delete after the refusal; "a rejection past the window" shows a 5xx-then-422 row stays
  final without a call; the ownership test shows the old upload keeps its message.

Tests. Worker, new file `worker/test/send-window.spec.ts` (the two superseded window tests left
`send-resend.spec.ts`):

- the reviewer's scenario: accepted at T0 with the answer lost, a Retry at T0 + 23 h 50 min
  (byte-identical body) also lost, a Retry at T0 + 24 h 30 min answers 409
  `send_status_unknown`, two calls in total, the row unchanged, the upload not deletable;
- a retry one minute before the window ends sends a byte-identical body;
- a network failure, then a Retry two minutes before Resend's 24 h end (inside the margin):
  refused, no call, row unchanged; the message detail carries both fields;
- a 5xx then a 422, past the window: a repeat answers 422 `send_rejected` without a call;
- 429, 429 inside the window (same body), then past the stored `exp`: re-signed
  (`exp` = now + 24 h, written back to R2), sent, `first_attempt_at` moved;
- 429 then a network error, a network error then 429, and an attempt that never answered then
  429: each refused past the window;
- "send as new": the old row stuck past the window, its attachment downloaded and uploaded again,
  sent under a new key: a new row, Resend called with the new key, the old row unchanged;
- ownership: the old upload cannot be attached to the new send (400 `unknown_upload`) nor
  deleted (409), the copy belongs to the new message, the old one is still downloadable.

Browser (`compose.test.ts`, "offers Retry in the reader only where it may still send"): a
`sending` row claimed 2 minutes ago but first attempted 25 h ago and a `failed` row with
`maybeAccepted` past the window show "Status unknown, check Resend" with "Send as a new message"
and no Retry; a rejected row with `maybeAccepted` past the window stays "refused"; a stalled
row's Retry answered 409 `send_in_progress` keeps its banner, the next Retry sends; a failed row
inside the window whose Retry answers 409 `send_status_unknown` turns to the unknown state;
"Send as a new message" opens compose with the warning, To, Bcc, subject, text and the copied
attachment, and the request carries a new UUID key, no `sourceId`/`sourceKind` and the new
upload id.

Migration 0010: applied to a scratch D1 migrated to 0009 with outbound `sent`, `sending` and
`failed` rows and an inbound row: inbound untouched, `sent` got its `received_at`, the
unfinished ones `0` and `1`. Applied to the local D1 with `bun run db:migrate:local`; a second
run reported nothing to apply. A second manual run of the file fails on `ALTER TABLE ... ADD`,
as for 0006 and 0009; wrangler's migration table prevents it.

Ablation of the third round (one mutation at a time, the touched suites rerun, the file restored;
script in the session scratchpad, `ablate.ts`). Worker 13 hunks against the four send suites and
`mailbox.spec.ts`, all red: `first_attempt_at` set at insert, the route's window from
`first_attempt_at`, `maybe_accepted` on taking over a `sending` row, on `send_failed`, the 409
refusal, `maybe_accepted` in it, the rejection exempt from it, the fresh claim past the window,
the fresh claim moving `first_attempt_at`, no re-sign inside the window, re-sign past it, the
5-minute margin, the two detail fields. Web 13 hunks against a rebuild and `compose.test.ts`,
all red: the reader's window from `firstAttemptAt`, a failed row with `maybeAccepted` unknown, a
rejection not shown as unknown, the "Send as a new message" button, the unknown state on 409
`send_status_unknown`, the status kept on 409 `send_in_progress`, the Reader wiring, the route
kind `again`, no reply source for `again`, the prefill from the sent copy, the copied
attachments, the Bcc, the warning. First pass: the in-window claim's SQL window clause survived
(the route refuses before the claim); the clause was removed as redundant and the route's check
ablated instead (red). Not ablated: the fresh claim's `maybe_accepted = 0` in SQL (only a race
between the read and the claim reaches it), the from-address choice for `again` (the stand-in
has one address), the `send_status_unknown` entry in `web/src/errors.ts` (the reader does not
toast that code; compose would show it, see Deferred), and the migration's backfill (proved on
the scratch D1 above, not by a test).

Numbers after the third round: below, "Numbers after the third round".

Numbers after the third round (2026-11-16, dev workstation, Ryzen 9 9950X3D; one Bun script ran
the 9 runs in a row, `time.ts` in the session scratchpad, CPU load read before each run):

- `bun run check`: 9.86, 9.49, 9.34 s wall, CPU load 1–5% (limit 10 s); worker suite (vitest
  Duration) 8.55, 8.26, 8.09 s (limit 9 s); 335 worker tests (327 before). Green before each
  commit, run on that commit's exact tree.
- `bun run test:browser`: 21.67, 22.53, 21.77 s wall including the build (bun test 20.05–20.86 s),
  52 tests, CPU load 0–3% (limit 30 s by ruling 14).
- `bun run test:send`: 14.67, 13.96, 14.63 s wall including the build (bun test 12.37–13.05 s),
  9 tests, CPU load 0–1%: **over the 14 s limit in two of three runs** (open question 7). The
  reader test grew by the unknown state, the two 409 answers and the send-as-new flow.
- Bundle (`vite build`, gzip level 6, `bundle.ts` in the session scratchpad: entry plus the JS
  `index.html` references; first paint = `index.html` plus every JS and CSS file it references;
  total = every JS and CSS file under `assets`). The script run on the base `de4b1c5` gave 263.1,
  311.8, 715.9 and compose 51.4 kB (the recorded entry figure was 263.0 kB). Head, 3 builds
  identical: entry plus preloaded JS 263.1 kB, first paint 311.8 kB (7 assets), total 716.7 kB,
  compose chunk 51.5 kB.

### Owner rulings 15 to 17 (2026-11-16)

15. **`bun run test:send` limit** 14 s → 18 s (owner approval 2026-11-16; open question 7).
16. **`bun run check` limit** 10 s → 12 s (owner approval 2026-11-16). The gate runs before each
    commit and in CI ("Merge gate" row).
17. **"Slowest test package" limit** 9 s → 10.8 s (9.0 s plus 20%; owner approval 2026-11-16;
    open question 8).

REQUIREMENTS carries both in the "Commands" rows. No script enforces either limit:
`scripts/check.ts` prints `check passed in N s` and exits on the steps' results only, and no hook
or workflow encodes 10 s or 14 s (the workflows use `timeout-minutes: 10`, bun a 20 s per-test
timeout). The comment in `.github/workflows/browser.yml` that named the 10 s gate says 12 s.

### Fourth fix round (mechanical, no behaviour change)

Commits: `158845e` the upload-signature tamper, `3e9f59c` `send/retry.ts`, `bf04143`
`sent-status.test.ts`, `c5ffb7e` rulings 15 and 16, and the docs commit after them.

- **[Low] Flaky blob test** (`send-extras.spec.ts`, "opens the blob only with a valid, unexpired
  signature"). The test changed the last base64url character of the 43-character HMAC from `A`
  to `B`; that character carries 4 data bits and 2 padding bits, and `A` and `B` differ only in
  the padding, so a signature ending in `A` (1 run in 16) still verified. It now changes the
  first character. Checked with a Bun one-liner: a 32-byte value whose base64url ends in `A`
  decodes to the same bytes with `B` in its place. No other signature-tamper test in
  `worker/test` edits a trailing character (the webhook test signs with another secret; the
  session test uses a made-up cookie). The single test ran 20 times in a row after the fix and
  20 times on the final head, 0 failures each time.
- **`send.ts` 320 → 203 lines.** The retry window constants, `DONE`, `Existing`, `claimRetry`,
  the failed-row update and the existing-row branch moved unchanged to `send/retry.ts`
  (139 lines). `retryExisting` returns the answer or the stored copy; the route passes the copy
  to `deliver`, so `retry.ts` does not import `send.ts`. Three worker specs import the
  constants from `retry.ts`; the tests are otherwise unchanged and the 335 pass. The reader's
  comment naming the Worker's retry limits points to the new file.
- **`compose.test.ts` 348 → 231 lines.** "Offers Retry in the reader only where it may still
  send" moved unchanged to `web/test/sent-status.test.ts` (148 lines) with the same stub app
  setup. `bun run test:send` runs the three files after one build (9 tests in 3 files);
  `test:browser` ignores the new file (still 52 tests in 6 files); `send.yml` lists it in its
  path filter.
- **p90 file length.** Script `p90.ts` in the session scratchpad: every git-tracked .ts, .tsx
  and .py file except `.d.ts`, line count = newlines, sorted, nearest rank (the
  ceil(0.9 × n)-th). Head: **239 lines**, the 165th of 183 files. The same script gives 271 at
  `66d8f34` over 181 files; the review's 263 is the 162nd of those 181 (floor rank). The
  recorded 314 dated from 15 files. REQUIREMENTS now says 239.

Files above 239 lines at head, each with its reason (M5 growth against main `5cb6755` in
brackets):

| File | Lines | Reason, or split |
| --- | --- | --- |
| `web/test/reader.test.ts` | 451 | deferred since M4b: the rendering-security corpus could move to its own file |
| `worker/test/mailbox.spec.ts` | 435 (+3) | one suite for the mailbox routes over one seeded store; split by route group when it next grows |
| `worker/test/inbound.spec.ts` | 379 | inbound pipeline scenarios on one fixture set; unchanged in M5 |
| `worker/src/db/schema.ts` | 350 (+114) | the Drizzle schema, one table per block; M5 added `drafts`, `uploads`, `webhook_events`, `send_quota` and the message columns; one file keeps the migrations' source in one place |
| `scripts/test_check_requirements.py` | 346 | the requirements check's tests; unchanged in M5 |
| `web/test/pwa.test.ts` | 341 | the PWA suite with one persistent Chromium profile; unchanged in M5 |
| `worker/test/consumer.spec.ts` | 316 | queue consumer scenarios; unchanged in M5 |
| `scripts/check-requirements.py` | 314 | the merge gate's requirements check; unchanged in M5 |
| `worker/test/push.spec.ts` | 308 | Web Push scenarios; unchanged in M5 |
| `worker/src/mail/routes.ts` | 301 (+4) | the mailbox routes; M5 added the Sent folder filter and the sent-message fields |
| `worker/test/send.spec.ts` | 298 (new) | the M5 worker suite is already split by topic into four files (send, resend, window, extras) |
| `web/src/pages/MailboxPage.tsx` | 292 (+36) | the folder page wiring list, reader and compose panel; M5 added Sent, Drafts and the compose panel |
| `web/src/compose/useCompose.ts` | 289 (new) | the compose state hook (fields, autosave, attachments, send); the prefill already moved to `compose/start.ts` |
| `worker/test/send-window.spec.ts` | 284 (new) | see `send.spec.ts` |
| `worker/test/send-resend.spec.ts` | 279 (new) | see `send.spec.ts` |
| `web/src/pages/SecurityPage.tsx` | 274 | split once from 325 lines; unchanged in M5 |
| `worker/test/send-extras.spec.ts` | 271 (new) | see `send.spec.ts` |
| `web/src/compose/ComposeView.tsx` | 263 (new) | the compose screen; the hook and the prefill are already separate |

Numbers after the fourth round (2026-11-16, dev workstation, Ryzen 9 9950X3D; `time.ts` in the
session scratchpad ran the 11 runs in a row on `bf04143` with only STATE and a workflow comment
changed, CPU load read before each run):

- `bun run check`: 9.51, 9.40, 10.19, 9.83, 9.77 s wall, all green, CPU load 1–5% (limit 12 s
  by ruling 16); worker suite (vitest Duration) 8.25, 8.21, 9.03, 8.64, 8.60 s, 335 tests:
  **one run over the 9 s "Slowest test package" limit then** (open question 8, settled by ruling 17: 10.8 s). Green before each
  commit of this round (9.4–10.4 s).
- `bun run test:send`: 13.96, 13.86, 14.45 s wall including the build (bun test 12.34–12.91 s),
  9 tests in 3 files, CPU load 1–10% (limit 18 s by ruling 15).
- `bun run test:browser`: 25.07, 21.81, 20.60 s wall including the build (bun test
  19.05–23.57 s), 52 tests in 6 files, CPU load 1–3% (limit 30 s); the first run of the series
  was slow, as in the second round.
- Bundle not re-measured: the round changed no file under `web/src` except a comment.

### Deviations from the design (decisions taken, open to the owner)

1. **`uploads.message_id`.** The design's `uploads` has only `draft_id`; the cron could not tell
   an attachment of a sent message from a stale one. `message_id` is set when the message is
   inserted; the cron keeps such an upload while the message exists.
2. **Draft attachments** are linked by `uploads.draft_id` only; the draft row keeps no list of
   upload ids, so there is one source of truth.
3. **The sent copy is written before the Resend call** (the design writes it after the 200), so a
   retry sends exactly the stored request again, signed attachment URLs included (ruling 4); a
   retry ignores a changed request body and a Retry from the reader sends `{ idempotencyKey }`
   alone. After a final rejection (`send_rejected`) the compose session takes a new key and the
   corrected message is a new send with its own row (ruling 6); the rejected row stays in Sent as
   "Not sent" and hands its attachments back to the draft.
4. **`received_at` of an outbound row** is the time of its last send attempt; the 60-second
   staleness check reads it. The retry window reads `first_attempt_at` instead (ruling 13,
   migration 0010), with `maybe_accepted` beside it.
5. **`GET /api/uploads/:id`** (session): the owner's download of a sent message's attachment; it
   also lets a forward of a sent message carry its attachments. Not in the design's route list.
6. **Hub event `changed`.** A send or a status change notifies open pages without Web Push; the
   design's "as for new mail" would have pushed a new-mail notification for the owner's own mail.
7. **The webhook is exempt from the CSRF guard** (`signedWebhookRoute`): Resend's request has no
   matching `Origin`; the Svix signature authenticates it.
8. **Status in Sent:** only states that need attention (delayed, bounced, complained, failed,
   suppressed) get a badge; sending, sent and delivered are plain text (Astryx Badge guidance).
   `suppressed` joins the status set (the webhook design lists it).
9. **Markdown details:** images become their alt text (no remote image in sent mail), task list
   boxes ☑/☐, raw HTML shown as text.
10. **Quota in Settings** is a section on Settings > Domains, shown once a domain can send.
11. **Compose has a Close control** (the draft is kept), beside its heading in the panel and in
    the page's title row at phone width.
12. **Forward** uploads the source's attachments as soon as compose opens; the owner removes the
    ones not wanted.
13. **`RESEND_API_URL`** is a var (no hardcoded URL) and is passed to the SDK, so no
    `process.env.RESEND_BASE_URL` can redirect the call.
14. **Inbox lists inbound mail only**, and the unread Inbox count ignores outbound rows (they are
    stored read).

### Open questions for the owner

1. Settled by ruling 7 (vendor chunk rule, first paint 311.8 kB). **First paint grew 3.9 kB** (319.0 → 322.9 kB, limit 370) although marked is not in it. The
   compose chunk shares Astryx modules (Selector, Item, Stack) with the first paint, and the
   bundler re-split those shared modules into four more preloaded chunks; a probe build with the
   compose chunk replaced by an empty component measured 319.1 kB. Options: accept it, or add a
   manual chunk rule to the Vite config to keep the old split (more config to maintain).
2. Settled by ruling 8 (`bun run test:send`). **Browser tier 31–34 s against 26 s.** Proposed: split the sending suites into
   `bun run test:send` (compose and Markdown, about 11 s, limit 14 s) with its own workflow like
   the PWA suite, which brings `test:browser` back to about 21 s; or raise the limit to 42 s
   (35 s plus 20%).
3. Answered by the real Resend test (SES replaces a custom Message-ID; deferred). **Threading of replies to new outbound mail.** Resend sets the Message-ID and returns none, so
   a reply to a message started in MelodyMail threads by its In-Reply-To, which no stored row
   carries; it starts a new thread. Setting our own `Message-ID` header through Resend's `headers`
   is untested against the real API. Try it during the manual test?
4. Settled by ruling 9. **A Retry more than 24 hours after the first attempt** signs with the stored, expired `exp`
   (ruling 4), so Resend cannot fetch the attachments. Resend's idempotency key has expired by
   then too, so a fresh `exp` would not conflict. Keep the ruling as it is, or re-sign when the
   stored expiry has passed?
5. Settled by ruling 10. **A message stuck at `sending`** (a 409 idempotency conflict, or a Worker that died
   mid-send) shows "Sending" in the reader with no action; only a repeat from the same compose
   session claims it after 60 s. Offer Retry in the reader for a `sending` row older than 60 s?
6. Settled by ruling 11. **The rejected row after a correction** stays in Sent as "Not sent" with Retry, and its
   attachments now belong to the draft: Discard deletes them, and the rejected row's copy then
   names attachments that are gone. Remove the rejected row once the corrected message is sent,
   or keep it as a record?

7. Settled by ruling 15 (limit 18 s). **`bun run test:send` is over its 14 s limit** in two of three runs after the third round
   (13.96–14.67 s wall, CPU load 0–1%). Options: raise it to 18 s (14.7 s plus 20%, the method
   of "Commands"), or move the reader send states into their own suite with its own build.
8. Settled by ruling 17 (limit 10.8 s). **The worker suite reached 9.03 s** (vitest Duration) in one of five gate runs after the
   fourth round, against the 9 s "Slowest test package" limit (8.21–8.64 s in the other four,
   CPU load 1–5%). The round added no test; the third round measured 8.09–8.55 s. Options: raise
   the limit to 10.8 s (9.0 s plus 20%), or split the slowest worker specs across vitest pools.

### Deferred

- Cloudflare Email Sending as the transport: it would remove Resend and the signed attachment URLs,
  but it needs Workers Paid for arbitrary recipients and also refuses a custom `Message-ID`
  (`E_HEADER_NOT_ALLOWED`, platform-controlled). The owner keeps the Free plan (2026-11-16), so it
  is not pursued; whether its returned `messageId` equals the delivered Message-ID is untested.
- Compose still offers "Send again" when its own send answers 409 `send_status_unknown` (a draft
  reopened from Drafts more than a day after a lost send); the retry only gets the same 409, and
  the message tells the owner to check Resend or send it as a new message. Option: hide Retry
  for that code in compose and offer the reader's "Send as a new message". Source: third fix
  round.
- "Send as a new message" sends without the old message's thread headers (`In-Reply-To`,
  `References`): the sent copy keeps them, but compose kind `again` sends no reply source.
  Option: let the send carry the stored headers. Source: third fix round.
- `web/test/reader.test.ts` (451 lines) is still over the pass bar (M4b deferral).
- An address book for recipient suggestions (the Tokenizer takes a search source).
- Pushing flag changes and delivery statuses to other tabs beyond the `changed` event's list
  refresh (only the open list refetches its first page).
- Webhook events for an unknown email id answer 409 so that Resend retries them (hypothesis A).
  An id that is not ours is then retried on Resend's schedule until Resend gives up. Option:
  answer 200 for such an event once it is older than a few minutes (its `svix-timestamp`),
  when the send it could have overtaken has long finished. Source: re-review of `06e2c7b`.
- The `delivery_failed` badge variant in Sent was not ablated: the label reads the same as
  plain text and Astryx Badge exposes no attribute a test could assert. Source: ablation of the
  first review round.

### Not verified

- Real delivery through Resend was checked once by hand without attachments ("Real Resend test"); the webhook from Resend (it cannot reach localhost), Resend
  fetching a signed attachment URL from localhost, the quota headers and quota error names of the
  real API (taken from the design's Resend facts), production CPU of a send.
- Running sending under `wrangler dev`: the routes ran in workerd through the vitest pool; the
  manual Resend test is for the owner and the coordinator.
- Firefox and Safari; only Chromium was driven.
- WCAG contrast of the new screens was not measured.
- The browser tier and the new suites have not run in CI (nothing was pushed); `send.yml` has
  never run.
- Resend's idempotency window boundary: that Resend keeps a key 24 hours from the first stored
  request (the 5-minute margin covers skew) and how it treats a key whose first request got a
  429 come from Resend's documentation, not a real answer.
- The "Send as a new message" screens were not screenshotted at the three widths, two themes and
  three locales; only the browser test drove them (Chromium, 1280 px default, en).
- Resend's behaviour behind the review fixes: the 409 names come from Resend's error reference,
  not a real answer; that `email.*` can overtake the send's answer is shown only by the stubbed
  test; the size of real webhook payloads is not published.

### Screenshots

252 PNG files in the session scratchpad, folder `shots-m5` (outside the repository): compose new,
filled (chips, Cc/Bcc, Markdown with a table, an uploaded attachment and one refused over 25 MB),
preview, quota warning, quota used up, sending not set up, reply, send failed with Retry, Sent
with each status, a failed sent message with Retry, a delivered sent message, Drafts with drafts
and empty, Settings > Domains with the quota, each at 390, 1280 and 1920 px, light and dark,
en, zh-CN and ja-JP. `scrollWidth` equalled the viewport width in all 252. Taken with Playwright
against `web/dist` and the in-memory API stand-in. Found and fixed from them: the "Cc and Bcc"
button was cut off beside the To field (now under it), and the status badge in a Sent row shrank
to an ellipsis (it keeps its width now; the recipients are cut instead).

## M5b: Telegram notifications (done 2026-11-16, PR #7, merge `791ba73`)

Design: `docs/M5b-telegram.md`, with the owner's rulings of 2026-11-16 at its end. Risk class
High (a public webhook that changes flags, the bot token, a table linking the mailbox to a chat,
Worker requests to the Bot API carrying sender, subject and address). Both reviews passed, both
real-bot tunnel tests ran (see "Real-bot tunnel tests"), and screenshots were sent to the owner.
PR #7 CI passed (merge-gate 48 s, browser 52 s) after a CI fix: the runner now installs Python
3.13 before the widget size check. Merged on the owner's go.

Commits on `339d865`: `36cab01` migration 0011; `97e7c95` Worker: Connect, webhook, cards;
`952436d` recovery disconnects Telegram; `b07dc98` widget size check; `7dab8d5` benchmark;
`ab4813f` tests from the ablation; `a036bde` the card in Chromium; `827de0f` Settings >
Notifications > Telegram; and the docs commit after them.

### Telegram facts re-checked (2026-11-16)

Every fact the build relies on was read again from the live pages: `sendWidget`,
`answerWidgetQuery`, `editMessageWidgetData`, `setWebhook`, `deleteWebhook`, `sendMessage`,
`WidgetQuery`, `WidgetQueryType(Data)`, `Update`, `User`, `ResponseParameters` (machine-readable
pages `core.telegram.org/bots/api/methods/<name>.md` and `/bots/api/types/<name>.md`; the paths
without `.md` answer "Page not found"), the API page, the widgets guide (`/bots/widgets.md`),
Bot features ("Deep Linking") and the Bot FAQ. No fact differs from the design. Additions the
build used:

- `TelegramWidget.chatData` is `null` when there is no state; the card's `parse()` handles it.
- `request()` resolves with `{ result: string | null }` and rejects with a `WidgetRequestError`
  whose `code` is `NOT_ALLOWED`, `BUSY`, `RATE_LIMITED`, `TIMEOUT`, `FAILED` or `INVALID_ANSWER`;
  the card shows its own line for `RATE_LIMITED` and the generic line for the rest.
- The `WidgetQuery` type page itself states "at most 5 queries per 5 seconds"; whether a query
  over the limit reaches the bot is still not stated.
- `hidden`, `:disabled` on `<button>`, `overflow-wrap`, grid and `em` are in widget profile 1;
  the card uses nothing from the "Out" lists.

Fetching: TinyFish `fetch_content` returned the method and type pages in full, but cut the
widgets guide at its first inline `<style` in every format (markdown, html, json). The guide
was read through Exa `web_fetch_exa` (the next provider in the fetch order), 101 kB, and
grepped from the saved file.

### Library choices

- **Bot API client: none, as the design decided.** Re-checked: no grammY release with Bot API
  10.4 types was found; the six methods go through `worker/src/telegram/api.ts` (80 lines).
- **No new dependency** in the Worker or the web app. The card is a Text module
  (`card.html`); wrangler's default rules upload it as one (`wrangler deploy --dry-run` lists
  `<hash>-card.html` beside `index.js`), and the vitest pool imports it as a string too.

### Done

- Migration `0011_telegram.sql` (drizzle-kit, `IF NOT EXISTS`): `telegram` (one row) and
  `telegram_cards` (claim per message, cascade with the mail, unique `(chat_id,
  tg_message_id)`). `db:migrate:local` applied it to the local D1 holding 20 messages; a second
  run reported nothing to apply; the file run again by hand succeeded.
- Routes `GET /api/telegram`, `POST|DELETE /api/telegram/link`, `DELETE /api/telegram`,
  `POST /api/telegram/test` (Connect: fresh Passkey and `TELEGRAM_LIMITER`, 5 per 60 s per
  session; test card: the limiter) and the public `POST /api/webhooks/telegram`
  (`signedWebhookRoute`). `REQUIREMENTS.md`, "Exceptions", has its row.
- The Hub sends the card next to Web Push (`Promise.all`, each failure caught and logged).
- Recovery deletes the binding and its cards in its own batch.
- `bun run check:widget` (Python zlib) and its planted-violation test in `bun run test:scripts`.
- `bun run --cwd worker bench:telegram`.
- Settings > Notifications > Telegram in three locales; four error codes in `web/src/errors.ts`.
- README "Notifications" > "Telegram", `worker/.dev.vars.example`, `wrangler.jsonc`
  (`TELEGRAM_API_URL`, `TELEGRAM_LIMITER`).

Usability references: GitHub Settings > Notifications lists every delivery channel on one page;
Telegram's Bot features page names the deep-link `start` parameter as the way to connect a
Telegram account to another platform's account.

### Proof

Worker (`bun --bun vitest run`, 368 tests, 33 more than before M5b, in `telegram.spec.ts`,
`telegram-webhook.spec.ts` and `telegram-send.spec.ts`; `api.spec.ts` asserts the test token
and the `.invalid` API host). `fetch` is stubbed in every test and `TELEGRAM_API_URL` is
`https://api.telegram.invalid`, so no request can reach Telegram. `vitest.config.ts` binds
`TELEGRAM_BOT_TOKEN` itself: the vitest pool also loads `worker/.dev.vars` ("Using secrets
defined in .dev.vars"), and the explicit binding wins over a real token there.

- route walk: the webhook is the only new public route; the five others answer 401 without a
  session; Connect answers 403 `reauth_required` without fresh auth, before any Bot API call;
- status: `notConfigured` without a token, `off`, `httpsRequired` on `http:`, `pending` only
  until the code expires, `on` with the label and the last error;
- Connect: `getMe` then `setWebhook` with `<origin>/api/webhooks/telegram`, `allowed_updates`
  `["message","widget_query"]`, `drop_pending_updates`, a 43-character `secret_token` of the
  allowed alphabet whose SHA-256 is stored and accepted by the webhook, a 22-character code,
  the deep link, a 10-minute expiry; `http:`, port 8080 and an origin over 160 characters
  refused with 409 and no call; port 8443 accepted; 404 without a token; a failing `getMe` or
  `setWebhook` answers `{"error":"telegram_failed"}` without upstream text and stores nothing;
  both rate-limited routes answer 429 from the limiter;
- webhook auth: no row 404; wrong, missing and over-long secret 401; right secret 200 with an
  empty body; an update over 64 KB by declared length, by bytes read (a chunked body) and
  invalid JSON answer 200 with no effect;
- binding: a valid code binds once (a second chat with the same code gets the invalid reply,
  in Japanese for `language_code` `ja`); the reply in the chat's language (`zh-hans` →
  zh-CN); a wrong code, a bare `/start`, a group, another `from.id` and an expired code get the
  one fixed reply and bind nothing; other text gets an empty 200; a new chat's bind drops the
  old chat's cards; recovery removes binding and cards;
- sending: one card per message when `notify` runs twice; the request carries the template,
  `allow_queries`, `protect_content`, no `parse_mode`, the caption, a timeout signal, and
  `chat_data` with content, link and flags; a long CJK subject, a quoted Japanese sender and a
  318-character address stay within 1024 bytes (the address cut to its 200-byte budget), the
  link within 256 characters, the caption within 1024; "(no subject)" in the bound language;
  nothing without a bound chat or without a token, and no warning then; a card while a page is
  open; a 400 falls back to `sendMessage` with the caption and an Open button, the claim row
  keeping a null message id; 403, 429 and 502 record `blocked`, `rate_limited`, `failed` and
  send nothing else; a success clears it; a 200 without a Bot API answer and a network error
  record `failed`; `notify` resolves in every failure;
- actions: each of `read`, `arch`, `star` with 1 and 0 changes exactly that flag; the edit
  carries the full new `chat_data`; the response is `answerWidgetQuery` with all three flags;
  the page socket receives `{"type":"changed"}`; another chat, a group, another sender and an
  unbound row answer `unbound` and change nothing; unknown data answers `bad`; a deleted message
  answers `gone` and edits `chat_data` to `{"v":1,"g":1}`; `message is not modified` is logged
  as info and a 500 on the edit as a warning, and both still answer the true flags;
- disconnect: `deleteWebhook` with `drop_pending_updates`, binding and cards gone, a later
  webhook 404; a failing `deleteWebhook` still disconnects; the test card goes to the bound
  chat with `x:1` and the bound language, makes no card row, 409 without a chat;
- logs: across bind, invalid code, a failed send, a thrown fetch whose message holds the token,
  a tap and a wrong secret, no log line contains the token, its numeric id, the chat id, a
  code, the webhook secret, the subject, the sender, an address or Telegram's description.

Browser tier (`bun run test:browser`, 64 tests, 12 more):

- `telegram.test.ts` (against the API stand-in): not set up and needs-https banners without a
  Connect button; Connect through the Passkey prompt (a Chromium virtual authenticator, the
  stand-in's reauth routes; the request order is asserted), the deep link (`target=_blank`),
  the `/start` command and the expiry line, the 3-second poll (Playwright's fake clock) ending
  in "Connected to @owner since …" with a toast, and no poll afterwards; the code expiring back
  to Connect; a pending code after a reload offers a new code, Cancel sends DELETE; the test
  card's toast, a failed test card's error toast and warning banner; Disconnect only after the
  confirmation dialog.
- `telegram-card.test.ts` (the card with a stand-in `TelegramWidget`): `<img onerror>` and
  `<script>` in sender, subject and address written as text, nothing run, no `<img>`; `read:1`
  then `read:0` with the label following the answer, then `arch:1` and `star:1`; each answer
  and error code mapped to its line; `gone` drops the content and hides the buttons; a
  `chatDataChanged` redraw; Open calls `openLink` with the link, an invalid link shows its
  line; the test card answers without a request; a double tap sends one request; `zh-TW` →
  Simplified, `ja`, `fr-FR` and empty → their copy or English; the three locale blocks have the
  same keys.

Widget size: `bun run check:widget` passes the card (3,809 bytes, 1,989 compressed); its test
fails it, as planted, on the card padded with random text, 32,769 raw bytes, a NUL and invalid
UTF-8, and exits 2 on an empty and a missing file. Worst-case `chat_data` measured by the test:
within 1024 bytes.

### Ablation

Scripts in the session scratchpad (`ablate-m5b-worker.ts`, `ablate-m5b-web.ts`) apply one
mutation at a time, run the touched suites (Worker: the three Telegram specs, `authz`,
`recover`, `login`, `api`; web: a rebuild and `telegram.test.ts` for the panel, or
`telegram-card.test.ts` for the card), and restore the file.

Worker, 89 hunks: the failure classes (429, 403, not modified), the `ok` check, the logged
fields (no description, no fetch message), the timeout; the language mapping, the byte cuts and
their escaped-form measure, the three field cuts, the flags, the link, the test marker, the
no-subject copy, the caption cut; `allow_queries`, `protect_content`, the 400-only fallback,
the fallback itself and its Open button, the last-error mapping, the token, binding and claim
checks, recording and clearing the error, the stored message id; the origin's scheme, port and
length, each status branch, Connect's three guards and origin check, the `getMe` and
`setWebhook` failures, `allowed_updates`, `drop_pending_updates`, the two stored hashes, the
TTL, cancel, Disconnect's three parts, the test card's checks, outcome and data; the webhook's
404, secret, both size caps, invalid JSON, the `/start` match, the private, sender, expiry,
code and single-use conditions, the card drop on rebind, label, language and reply; the four
unbound conditions, the data pattern, the card lookup, the flag value and name, the gone edit,
the edit, the Hub event and the answer; the Hub call, `hashMatches`, the recovery deletes and
the public marker. First pass: 75 red, 14 survivors. Ten got tests (`ab4813f`; all red now):
the address cut, the Japanese reply, the `ok` check, the timeout signal, the origin length, the
read cap, the `setWebhook` failure, the test card on a row without a chat, the missing binding
in the Hub, the not-modified log level. One condition was removed as dead
(`config.chatId === null`: a null chat never equals the query's chat id). Three survive by
Telegram's own invariants and stay as stated in the design:

- `chat.id !== bound chat` in an action: in a private chat the chat id is the user's id, so the
  `from.id` check already refuses;
- `chat.type === "private"` at bind: a group's id is negative and never equals `from.id`;
- `chat_id` in the card lookup: rebinding deletes the old chat's cards, so no other chat's row
  exists; the condition keeps the lookup on the unique index.

Web, 38 hunks: the poll's refetch, stop, guard and expiry, the connected toast, Connect through
`withReauth`, keeping the link, the cancel, test and disconnect requests, the reload after a
test, the confirmation, both banners, the hidden-code branch, the last-error banner, the error
entry, the section on the page; in the card: `textContent`, the target value, the read toggle,
the label, applying the answer, gone, unbound, an error answer, the error-code line, the test
card, the busy guard, Open's catch, the `chatDataChanged` handler, the two-letter locale, the
English fallback, hiding the buttons and dropping the content when gone, "(no subject)", the
"To:" prefix, disabling the buttons while busy. First pass: 35 red, 3 survivors. The poll guard
and the disabled buttons got tests (red now); the card's `if (busy) return` was redundant with
the disabled buttons and was removed (`a036bde`). 37 of 37 red.

Not ablated: the README and copy, the Hub's `catch` around `telegramNewMail` (a throw there
needs D1 to fail inside the Durable Object), the `chat_not_found` and `widget_refused` classes
(logged only), `cutEscaped` on a surrogate pair at the budget edge.

### Numbers (2026-11-16, dev workstation, Ryzen 9 9950X3D, Bun 1.4.4)

Timed with the scratchpad's `time-m5b.ts` on `827de0f`, the runs in a row, CPU load read before
each:

- `bun run check`: 10.45, 10.28, 10.00 s wall, CPU load 11–24% (limit 12 s); worker suite
  (vitest Duration) 9.41, 9.19, 8.99 s, 368 tests (limit 10.8 s). Earlier in the session, with
  the host at 40–55% load from other work, the gate took 12.0–12.7 s and the suite 11.0–11.6 s;
  green before every commit.
- `bun run test:browser`: 29.52, 25.81, 26.11 s wall including the build (bun test
  28.32/24.57/24.95 s), 64 tests in 8 files, CPU load 15–25% (limit 30 s). Open question 1.
- `bun run test:send`: 14.33, 14.31, 14.23 s wall, 9 tests, CPU load 1–13% (limit 18 s).
- `bun run test:pwa`: 11.03, 11.69, 11.74 s wall, 11 tests, CPU load 0–4% (limit 15 s).
- Bundle (the scratchpad's `bundle2.ts`, the recorded `bundle.ts` with the dist path as an
  argument; vite build, gzip -6; 3 builds identical): entry plus
  preloaded JS 263.0 → 263.1 kB (limit 270), first paint 311.8 → 311.8 kB (limit 370), total
  716.5 → 720.3 kB (limit 770); the base `339d865` was built in a worktree with the same script.
  The Telegram section is in the lazy `NotificationsPage` chunk.
- Worker bundle (`wrangler deploy --dry-run`): 1285.33 KiB / 265.86 KiB gzip at the base,
  1303.21 KiB / 272.89 KiB after (wrangler's figures); `index.js` gzip -6 271.3 → 276.3 kB plus
  the card module, 3,809 bytes raw.
- Card: 3,809 bytes, **1,989 bytes after zlib level 9** (limit 4,096); 156–164 px tall in the
  320 and 430 px browser stand-in (cap 600).
- `bun worker/bench/telegram.ts`: 64 KB update p95 0.078–0.087 ms, a tap p95 ≤ 0.007 ms, the
  worst-case card p95 0.047–0.064 ms, 3 runs of 200 (limit 3 ms; `REQUIREMENTS.md` row).
- p90 file length: 242 lines over 199 files (the scratchpad's `p90.ts`); above it from M5b:
  `worker/test/telegram-webhook.spec.ts` 269 lines (webhook auth, binding and buttons over one
  fixture set; split by those three groups when it next grows) and `worker/src/db/schema.ts`
  389 (+39, the two tables; one file keeps the migrations' source in one place).

### Deviations from the design (decisions taken, open to the owner)

1. **`pending` carries no code.** The design's status returns `url` and `code`, but only the
  code's SHA-256 is stored. The panel shows the code from Connect's answer; after a reload a
  pending code shows "A code is waiting, but it is shown only once" with "Create a new code"
  and Cancel.
2. **The fallback keeps the claim row** with a null `tg_message_id` (the design says "without a
  card row"): deleting it would let a repeated `notify` send the message twice. A null id never
  matches a tap. A 200 without a Bot API answer is also kept this way.
3. **A fallback that went out clears `last_error`**: the notification arrived.
4. **The test card uses the same fallback** on a 400, so the owner sees something either way.
5. **Recovery makes no `deleteWebhook` call**: the recovery path stays free of a network call;
  without the row the webhook answers 404 and acts on nothing. Telegram may repeat updates it
  had in flight a few times, then gives up.
6. **A bare `/start`** (opening the bot without the link) gets the invalid-code reply.
7. **Audit entries** `telegram_link_created` and `telegram_connected` besides the design's
  `telegram_disconnected`.
8. **The size check runs inside `bun run test:scripts`** (in the merge gate) rather than as its
  own gate step: the test runs it on the card and on the planted files, so a second step would
  run the same check twice. `bun run check:widget` is the manual command.
9. **`card.html` is excluded from Biome** (`biome.json`): Biome's HTML formatter would expand
  the deliberately compact file.
10. **The card has no `if (busy) return`**: the disabled buttons cover a double tap (tested),
  and Telegram answers a second request with `BUSY`.

### Owner rulings on the open questions (2026-11-16)

1. Browser tier at 25.8–29.5 s: leave it. If a run goes over 30 s, move the two Telegram
   suites into `bun run test:telegram` with its own workflow.
2. Recovery keeps the webhook registered at Telegram (deviation 5 stands).
3. The real-bot tunnel test waits until the owner is ready. Planned setup: `wrangler dev
   --local-protocol https`, `cloudflared` quick tunnel to `https://localhost:8787` with
   `--no-tls-verify` and `--http-host-header <tunnel host>`; check that `GET /api/telegram`
   reports `off`, not `httpsRequired`, before connecting; close the tunnel after the test.

### Review (2026-11-16, fresh Opus reviewer, "PASS")

Three Lows. The cascade test gap is fixed in `b2573b5`, which also adds the concurrent bind
and concurrent notify tests the reviewer asked for as hypotheses (both green; not ablated,
test-only). The lost-send-result card and the simultaneous Connect race are deferred below
(`95fb198`), with a README note to run Connect again if the bot stops reacting.

### Buttons on the plain message (owner ruling 7, built 2026-11-16)

The real-bot tunnel test found every `sendWidget` refused with `INPUT_MEDIA_WIDGET_NOT_ALLOWED`
(design, "Addendum: widgets refused for general bots"). Commit `fe6c61b` gives the fallback
message the card's four actions; the widget path is unchanged. Risk class High (a public
webhook path that changes flags).

- The fallback `sendMessage` carries an inline keyboard: Open (`url`) and the read button, then
  archive and star. Labels toggle with the message's flags in the binding's language; callback
  data is `<action>:<target value>`, the widget's request format. The test card keeps Open only.
- The fallback stores its Telegram `message_id` in `telegram_cards.tg_message_id` (deviation 2
  above, the null id, now holds only for a 200 without a Bot API answer).
- `callback_query` passes the widget's checks in the same function (`perform` in the new
  `worker/src/telegram/actions.ts`, which also holds the widget handler moved from
  `webhook.ts`): bound chat, private chat, chat id and `from.id` equal to the bound chat. A query
  from an inline message has no `message`, so it fails the chat check. Then the card lookup by
  `(message.chat.id, message.message_id)` and `updateMessageFlags`.
- Answer: `answerCallbackQuery` in the webhook response with a notice; then
  `editMessageReplyMarkup` (5 s timeout) and `notifyHub` "changed". Bad data answers the card's
  failure line, a refused query its "no longer connected" line, a missing card its "deleted"
  line, and none of the three edits anything.
- `allowed_updates` is `["message", "widget_query", "callback_query"]`; README "Telegram" says to
  run Connect again after upgrading and that cards arrive as messages with buttons for now.

Bot API facts read again on 2026-11-16 (TinyFish `fetch_content` on the machine-readable pages
`answercallbackquery`, `editmessagereplymarkup`, `callbackquery`, `inlinekeyboardbutton`,
`maybeinaccessiblemessage`, `inaccessiblemessage`, `update`, `setwebhook`, `sendmessage`; the API
page's "Making requests when getting updates" through Exa `web_fetch_exa`, because TinyFish
returned only the changelog headings for it):

- `CallbackQuery`: `id`, `from`, optional `message` (a `MaybeInaccessibleMessage`; present when
  the button was on a message the bot sent), optional `inline_message_id`, `chat_instance`,
  optional `data`. Clients show a progress bar until `answerCallbackQuery` is called.
- `InaccessibleMessage` still carries `chat` and `message_id` (`date` is 0), so a tap on a
  message the bot can no longer read finds its card the same way.
- `answerCallbackQuery`: `callback_query_id` required, `text` 0–200 characters. The longest
  notice ("Telegram is no longer connected to MelodyMail.") is 46 characters.
- `editMessageReplyMarkup`: `chat_id` + `message_id` (or `inline_message_id`) and
  `reply_markup`.
- `InlineKeyboardButton`: exactly one of `url`, `callback_data` (1–64 bytes), …; the longest
  data here is 6 bytes.
- A webhook answer may carry one method call; its result cannot be known.
- `setWebhook` `allowed_updates` omitted keeps the previous list (unchanged from the design).

Copy: the button labels and the deleted, unbound and failure lines repeat `card.html` word for
word (a worker test compares them for all three locales). The six success notices are new:
"Marked as read" / "Marked as unread", "Archived" / "Moved to Inbox", "Starred" / "Star
removed", and in zh-CN and ja-JP in the panel's terms (已存档, アーカイブしました as in
`mail.done.archived`).

Proof (worker, 374 tests, 4 more; `fetch` stubbed, no request to Telegram):

- fallback: the keyboard with the row's flags (a starred mail shows "Remove star", `star:0`),
  `tg_message_id` stored; the test card refused as a widget: Open only, no card row;
- `allowed_updates` with `callback_query`;
- each of `read`, `arch`, `star` set and cleared from the plain message: exactly that flag,
  the notice, one `editMessageReplyMarkup` to `(chat, 42)` whose keyboard shows the new labels
  and target values, a `changed` event per tap; a 500 on the edit still sets the flag and
  answers;
- another chat, a group, another sender, an inline-message query and an unbound row: the
  "no longer connected" notice in the binding's language (ja-JP), no flag change, no Bot API
  call;
- bad data (`trash:1`, `read:2`, `read:1:m2`, empty) and a missing card (no row; a row with a
  null message id): their notices, no flag change, no Bot API call;
- the copy check above; the log test now also taps the plain message with a fetch that throws
  the token.

Ablation (the scratchpad's `ablate-m5b-buttons.ts`, the three Telegram specs per mutation): 43
hunks, 38 red, 5 survivors:

- `chat id equals bound` and `lookup by chat id`: survive as before, by Telegram's invariants
  (in a private chat the chat id is the user's id; rebinding deletes the old chat's cards).
- `typeof tgMessageId !== "number"`: every `Message` and `InaccessibleMessage` has a
  `message_id`, and an inline query fails the chat check first; the guard narrows the type for
  the D1 bind.
- `!card` in the gone condition: with no card no flag changes and `mail` is null, so `!mail`
  alone gives the same result; `!card` narrows the type for `card.id`.
- the 5 s timeout on `editMessageReplyMarkup`: a value only; observing it needs a stalled
  request and fake timers, as for the widget edit.

Not ablated: the README; the comment and type moves into `actions.ts`.

File length: p90 stays 242 lines over 200 files (the scratchpad's `p90.ts` on `fe6c61b`).
`worker/test/telegram-webhook.spec.ts` grows to 389 lines (deferred split below) and
`worker/test/telegram-send.spec.ts` to 275 (the copy check and the fallback keyboard; it keeps
the sending fixtures in one place). `actions.ts` is 162 lines and `webhook.ts` 103.

Numbers (`bun run check`, dev workstation, Ryzen 9 9950X3D; the scratchpad's `time-buttons.sh`,
CPU load averaged over each run by `typeperf`, the gate's own work included). The host carried
other load for most of the session, and the gate went over its 12 s limit with and without
this change:

- the base `9044c08` before any edit: 9.8 and 9.5 s, 370 tests, load 2–6% sampled before;
- interleaved pairs on the same host, head `fe6c61b` against the base: head 13.5, 12.7, 12.8 s
  (load 32–38%), base 13.2, 13.2, 13.0 s (load 31–33%); an earlier interleaved series with load
  sampled before each run: head 13.7 (50%), 12.1 (1%), 11.3 s (2%), base 12.4 (59%), 11.6 (5%),
  11.8 s (3%);
- head alone at the quietest point: 11.5 and 11.3 s (load 20% and 18%), worker suite 10.4 s;
  later runs 12.6–17.2 s at load 27–65%.

The change adds no measurable time (the pairs differ by −0.5 to +1.3 s in both directions). The
12 s limit and the 10.8 s worker-suite limit were not met on the loaded host by either side; no
limit was changed. Open question 1 below.

Two gate runs failed without a test failure. One (28 s) left no log. In the other, the worker
pool could not start 10 test files (`ENOENT … web\dist\sw.mjs`); the other 253 tests passed.
`scripts/check.ts` runs `build` and `test` at the same time, and the worker pool reads
`web/dist` (the `assets` directory in `wrangler.jsonc`) while `build` rewrites it. The race
predates this change; it was not reproduced on the base. Open question 2 below.

Deviations from the addendum:

1. The notices for a refused query and bad data reuse the card's "Telegram is no longer
   connected to MelodyMail." and "MelodyMail didn't answer. Try again.", so the plain message
   says what the widget would.
2. The widget handler moved to `actions.ts` with the shared checks, so the two paths cannot
   drift and `webhook.ts` stays under the p90; its behaviour is unchanged (the existing widget
   tests pass unmodified, and its hunks were ablated again).

Review (fresh Opus reviewer, 2026-11-16): "PASS", no findings. It accepted the five ablation
survivors. Its two hypotheses (Telegram accepting `answerCallbackQuery` as a webhook reply, and
taps on an `InaccessibleMessage`) wait for the tunnel test.

Owner rulings (2026-11-16):

1. The merge gate limit goes from 12 s to 15 s, as headroom for host load (REQUIREMENTS.md).
2. The `build`/`test` race on `web/dist` in `scripts/check.ts` is fixed in its own change after
   M5b merges, with a timing baseline taken first.

Not verified: a real tap on the plain message's buttons and the real `answerCallbackQuery` in a
webhook response (the real-bot tunnel test again, ruling 1); how each client draws the 2 × 2
keyboard at phone width.

### Real-bot tunnel tests (2026-11-16, owner's bot, local `wrangler dev`)

Allowed by ruling 1. Setup: a fresh `--persist-to` state in the scratchpad (the passkey's RP ID is
the request host, so the owner ran `/setup` on the tunnel host), `wrangler dev --local-protocol
https`, `cloudflared tunnel --url https://localhost:8787 --no-tls-verify`; mail posted to
`/cdn-cgi/local/email`. The tunnel and `wrangler dev` were stopped after each test.

1. **First test.** The tunnel origin read as `https`, Connect registered the webhook, the deep
   link bound the chat, and the webhook's `sendMessage` reply arrived. Every `sendWidget` answered
   `400 INPUT_MEDIA_WIDGET_NOT_ALLOWED`: Telegram stopped general bots from sending widgets on
   2026-11-13 (tdlib/telegram-bot-api issue 947). The plain fallback arrived and its Open button
   opened the mail. This led to ruling 7 and the plain-message buttons.
2. **Second test, after ruling 7.** The fallback carried the 2 x 2 keyboard. The owner tapped
   read, archive and star both ways: each answered a notice, the labels toggled, and the panel
   followed. So Telegram accepts `answerCallbackQuery` as a webhook reply.

Still unverified: a widget in a real Telegram client (Telegram refuses to send them), taps on an
`InaccessibleMessage`.

### Owner requests after the tunnel test (2026-11-16, for a change after M5b)

1. An in-page notice for new mail while a MelodyMail page is in the foreground (a toast with the
   sender, the subject and an Open button that hides after a few seconds).
2. While a page is in the foreground, send neither the system notification (Web Push) nor the
   Telegram message. This supersedes M5b ruling 3 ("a card is sent even while a page is open")
   once that change lands; M5b ships with ruling 3 as built. It needs the Hub to know which pages
   are visible (the page reports visibility over its WebSocket).
3. Fix the `build`/`test` race on `web/dist` in `scripts/check.ts` (ruling 2 above).

### Deferred

- Coalescing cards above one per second per chat (429 is recorded, the card is lost). Source:
  the design's limits.
- Deleting the Telegram message with the mail (ruling 5) and editing cards from panel actions
  (ruling 2).
- A Bot API client library once grammY ships Bot API 10.4 types. Source: the design.
- Splitting `worker/test/telegram-webhook.spec.ts` (389 lines after the plain-message buttons,
  over the 242-line p90) into a buttons file. Source: this build; test-only. Waits: a new spec
  file adds a workerd start to a merge gate already near its 12 s limit.
- A card whose sendWidget result was lost (timeout, but Telegram delivered it) has no stored
  message id; the first tap marks it "deleted in MelodyMail". No mail is affected. Source: M5b
  review. Waits: needs Telegram to deliver after our 10 s timeout; the fix would be to answer
  gone without editing the card. The plain message's buttons (ruling 7) already answer that
  way, so it no longer arises while Telegram refuses widgets.
- Two Connects at the same moment from two tabs can leave Telegram and D1 with different webhook
  secrets; every update then gets 401 until Connect runs again. Source: M5b review. Waits: needs
  two simultaneous owner Connects.

### Not verified

- A real bot, a real webhook from Telegram and real taps (owner ruling 1: the coordinator runs
  the tunnel test with the owner); the webhook response carrying `answerWidgetQuery` and
  `sendMessage`; the card's rendering on iOS, Android, Desktop and web clients (only a Chromium
  stand-in, which draws more than Telegram does); whether `navigator.language` in the widget is
  Telegram's interface language; the 1-message-per-second limit under a burst; production CPU.
- `wrangler dev`: the routes ran in workerd through the vitest pool; no token was put in
  `worker/.dev.vars`, which was not read.
- The Microsoft localization style guides are PDFs behind `aka.ms` links; only their index was
  read. The zh-CN and ja-JP copy follows the existing locale files' terms and the repository's
  rules (spacing between CJK and Latin, full-width punctuation in zh-CN).
- WCAG contrast of the new section was not measured; the browser tier and new suites have not
  run in CI (nothing was pushed).

### Screenshots

156 PNG files in the session scratchpad, folder `shots-m5b` (outside the repository): the
Telegram section not set up, needs the deployed address, off, pending with the code, pending
after a reload, connected, connected with a failed send, and the Disconnect dialog, at 390,
1280 and 1920 px, light and dark, en, zh-CN and ja-JP (144); the card at 320 and 430 px with a
light and a dark palette in the three locales (12). `scrollWidth` equalled the viewport width in
all 156. Taken with Playwright against `web/dist` and the in-memory API stand-in. No layout bug
was found; the page keeps the M4b layout (one column of sections; at 1280 and 1920 px the page is
two sections tall).

## M5c: in-page notice and quiet foreground (built 2026-11-16, branch `m5c-foreground`)

Plan: `docs/M5c-foreground.md`. Risk class Medium (when Web Push and Telegram go out, a notice on
the page; no login, secret or stored-data change). Not pushed; waits for review, the owner's look
at the screenshots and the owner's check on local `wrangler dev`.
Since the owner's ruling of 2026-11-16 quiet foreground is a switch, off by default; "Done"
below describes it switched on (see "Review fixes and the owner's switch").

Commits on `39a8302`: `f864d96` the test pool's own assets directory (gate race); `e6562c9` Hub
foreground reports and quiet notify; `051970d` the page's reports and the notice; and the docs
commit after them.

### Durable Objects facts checked (2026-11-16)

Read from `developers.cloudflare.com/durable-objects/best-practices/websockets/` and
`/durable-objects/api/state/` (TinyFish `fetch_content`, both pages in full):

- `serializeAttachment` keeps a structured-clone value with the socket "through hibernation as
  long as the WebSocket remains healthy", at most 16,384 bytes; `deserializeAttachment` returns
  the last value or `null`.
- "When a message arrives, the Durable Object wakes up automatically"; the constructor runs again
  and in-memory state is reset.
- `setWebSocketAutoResponse` answers a matching request "without waking WebSockets in hibernation
  and incurring billable duration charges", so `"ping"` stays free; `"fg"` and `"bg"` wake the Hub.

No fact differs from the plan.

### Done

- **Gate race.** The worker test pool serves `worker/test/assets` (one `index.html`) instead of
  `web/dist` (`miniflare.assets.directory` in `worker/vitest.config.ts`). No worker test reads the
  SPA; the binding, the SPA fallback and `run_worker_first` still come from `wrangler.jsonc`, and
  `wrangler dev` and deploy keep `web/dist`. `scripts/check.ts` is unchanged: its steps are now
  really independent, so they still run at the same time.
- **Hub.** `webSocketMessage` stores `"fg"` or `"bg"` as `{ foreground }` with
  `serializeAttachment` and ignores every other message. `notify` for new mail, when any socket
  reports foreground, sends `{ type, id, quiet: true }` to the pages and skips Web Push and
  Telegram. A socket that never reported counts as background, so a page from before this change
  keeps today's behaviour. `"changed"` events are unchanged.
- **Page.** `MailboxProvider` reports `"fg"` (visible and focused) or `"bg"` when a socket opens
  and on `visibilitychange`, `focus` and `blur`, once per change and again on each new socket.
  New mail in the foreground shows an Astryx toast (`useToast`): "New mail from {sender}:
  {subject}" and an Open button that opens the message; it hides after Astryx's 5 s default. The
  notices take turns in three `uniqueID` slots, so at most three are visible and a fourth replaces
  the oldest. A hidden page skips `notifyWhenHidden` for a quiet event. Copy in en, zh-CN and
  ja-JP (`notification.notice`, `notification.open`).
- README "Notifications" and "Telegram" describe the foreground rule.

Usability references: Outlook on the web shows "a notification at the top of the Outlook Web App
window when a new message arrives"
(https://support.microsoft.com/en-us/outlook/mail-settings), and Outlook.com notifications "pop up
automatically in the app" and "disappear automatically after a brief time"
(https://support.microsoft.com/en-us/outlook/mail-and-calendar-notifications-in-outlook-com).
Divergence: no message text, as everywhere else in MelodyMail.

### Proof

- Worker (`hub.spec.ts`, `push-hub.spec.ts`, `telegram-send.spec.ts`; shared `hub-helpers.ts`):
  the last `"fg"`/`"bg"` is kept, and `"FG"`, `"fg "`, `"\"bg\""`, `"foreground"` and a binary
  frame are ignored while `"ping"` is still auto-answered; a fresh `Hub` built on the same state
  (as after hibernation) marks new mail quiet and leaves `"changed"` alone; a page that reported
  `"bg"` again does not mark it quiet; no push to any device while another session's page is in
  the foreground, and a push once it reports `"bg"`; a Telegram card while the page is in the
  background, none (and no claim row) in the foreground.
- Web, browser tier (`notice.test.ts`): the report sequence over two visibility changes, blur,
  focus, blur, a hidden blurred page (no repeat) and focus, then a new `"fg"` after a reconnect;
  the notice names sender and subject and contains neither the snippet nor the body, is read out
  by a polite live region and not the assertive one, leaves focus on the focused checkbox, and
  Open navigates to `?m=` and removes the notice; no notice on a blurred page; the "(no subject)"
  fallback; four in a row leave three.
- Web, PWA tier (`pwa.test.ts`): a hidden page with push on shows nothing for a quiet event.
- Gate race: the scratchpad's `churn.ts` rewrites files in `web/dist` in a tight loop while the
  worker suite runs. Before `f864d96`: 3 of 3 runs failed with `ENOENT ... web\dist\churn-*.mjs`.
  After: 3 of 3 green (374 tests). The fix has one hunk; this is its failing-without-fix proof.

### Ablation

The scratchpad's `ablate-m5c.ts` applies one mutation at a time, runs the three worker specs or a
rebuild with `notice.test.ts` (`pwa.test.ts` for the quiet branch), and restores the file.
23 hunks, 23 red:

- Hub (7): storing the report, the `"fg"`/`"bg"` filter, the foreground check in `notify`, its
  new-mail-only condition, the `quiet` flag in the event, the early return before push and
  Telegram, `foreground === true`.
- Page reports (9): the report on open, the reset per socket, each of the three listeners, the
  once-per-change check, the send, the notice only in the foreground, the quiet check before
  `notifyWhenHidden`. First pass: the blur listener survived (the next `visibilitychange`
  reported the same `"bg"`); the test now blurs and refocuses without a visibility change.
- Notice (7): the visibility and the focus terms of `inForeground`, the three slots, the sender,
  the no-subject copy, Open's dismiss, Open's navigation.

Not ablated: the notice's `getMessage` failure branch (returns without a notice; no test fails a
fetch there), `worker/test/assets` and the stand-in's report recording (test infrastructure), the
copy.

### Numbers (2026-11-16, dev workstation, Ryzen 9 9950X3D, Bun 1.4.4)

Timed with the scratchpad's `time-gate.ts` and `time-cmd.ts`, CPU load read before each run.

- Gate baseline before touching the race, on `39a8302`: 13.32, 13.30, 13.14 s, CPU load 35–60%
  from other programs on the host. After the race fix, same busy host: 13.76, 16.10, 14.49 s
  (load 29–88%). On a quiet host after M5c: 9.48, 9.36, 9.34 s, CPU load 0–7%; the base
  `39a8302` on the same quiet host: 9.49, 9.75, 9.94 s. Worker suite 8.18 s, 378 tests (374
  before).
- `bun run test:browser`: 29.67, 29.74, 29.67 s at 2% load, 67 tests (64 before); the base
  `39a8302` 26.22, 25.34 s at 4–11% load. At 55–70% load: 30.86, 30.57, 29.85 s, against the same
  tier without `notice.test.ts` at 53–74% load: 27.63, 27.93, 28.77 s. The notice suite adds 3–4
  s, about 1 s of it the reconnect backoff. Open question 1.
- `bun run test:pwa`: 12.35, 12.30, 11.68 s, 11 tests, CPU load 0–1% (limit 15 s).
- Bundle (gzip -6, the scratchpad's `bundle-m5c.ts`, both sides built on this host): total JS +
  CSS 720.3 → 720.4 kB (limit 770); first paint 311.8 → 311.8 kB (limit 370).
- Files above the 242-line p90 after M5c: `worker/test/hub.spec.ts` 256 (was 205),
  `web/test/stub-app.ts` 246 (was 242), `worker/test/telegram-send.spec.ts` 283 (was 275) and
  `web/test/pwa.test.ts` 349 (was 341). Reason: a new worker spec file adds a workerd start to
  the merge gate, and the stand-in and PWA files grew by a few lines each. Test-only.

### Deviations from the plan (decisions taken, open to the owner)

1. **Hidden pages stay quiet too.** The plan skips Web Push and Telegram; the owner's request
   says "send neither the system notification ... nor the Telegram message". A hidden page shows
   the system notification itself (`notifyWhenHidden`), so the Hub marks the event `quiet` and
   hidden pages skip it. Without this, a second tab or a phone with the app open in the
   background would still notify while the owner reads mail elsewhere.
2. **The race fix is in `worker/vitest.config.ts`, not `scripts/check.ts`.** Running `build`
   first would add its 1.5–3 s to the 9–14 s worker step and break the 15 s limit under load; the
   worker suite never needed the SPA.
3. **Three slots instead of dismissing the oldest.** Dismissing the oldest toast by its handle
   lost the race when four notices arrived in one batch (four visible in one browser run at 63%
   load); a slot `uniqueID` lets the viewport replace it.
4. **The same message twice shows twice** (one per slot); the Hub sends each new message once, so
   this needs a repeated queue delivery.

### Open questions for the owner

1. **Browser tier at 29.7 s on a quiet host, 29.9–30.9 s under load (limit 30 s).** Settled by
   M5b owner ruling 1: the two Telegram suites moved into `bun run test:telegram` with
   `.github/workflows/telegram.yml` (nightly, by hand, and, after the review fix, on pull
   requests touching `web/`, the card or the dependencies, as `browser.yml`). Browser tier now 25.4–26.1 s (55 tests), Telegram tier
   6.5–7.0 s (12 tests), CPU load 0–10%. Its limit, 10 s, was approved by the owner on 2026-11-16.
2. **Stale foreground after a crash.** Settled by the review fix below: a report older than 75 s
   counts as background, so a crashed, sleeping or disconnected page stops holding back push and
   Telegram within 75 s.

### Not verified

- Real hibernation: the tests build a fresh `Hub` on the same state, which is what a wake does;
  workerd in the vitest pool was not made to evict the object.
- A real tab or window switch: headless Chromium reports every page visible and focused, so the
  tests override `visibilityState` and `hasFocus` and fire the events. The owner's check on local
  `wrangler dev` covers the real browser (no Telegram traffic needed).
- Real push services and Telegram (both stubbed).
- The browser and PWA tiers have not run in CI (nothing pushed). WCAG contrast of the toast is
  Astryx's own and was not measured.

### Screenshots

18 PNG files in the session scratchpad, folder `shots-m5c` (outside the repository): two notices
(a short and a long subject) over the inbox at 390, 1280 and 1920 px, light and dark, en, zh-CN
and ja-JP. `scrollWidth` equalled the viewport width in all 18. Taken with Playwright against
`web/dist` and the in-memory API stand-in. The long subject wraps inside the toast; Open and the
close button stay on its first line.

### Review fixes and the owner's switch (review "FIX FIRST", owner ruling 2026-11-16)

Commits on `d1cc7b2`: `ab658d8` the Hub forgets a report after 75 s; `89406da` the page re-checks
every second and refreshes `"fg"` every 30 s; `6a39ba1` the Telegram workflow filter; `9e6a927`
the quiet setting in the Worker (migration 0012); `35ca1f4` the switch in Settings >
Notifications; `4848d7b` the PWA check for the new switch and one reload less per notice test;
and the docs commit after them.

**[High] A page could stay "fg" at the Hub indefinitely.** Focus inside the sandboxed reader
frame hides the top window's blur when the owner then leaves the browser; a laptop that sleeps or
loses its network leaves a half-open socket. Fix, as asked:

- The page re-evaluates visibility and focus every second, locally, and sends only on a change;
  while it stays in the foreground it repeats `"fg"` every 30 s.
- The attachment carries the report time; a socket counts as foreground only while its last
  `"fg"` is younger than 75 s (`FOREGROUND_TTL_MS`). An attachment from before this change has no
  time and counts as background until the page reports again.

**[Low] Telegram workflow filter.** Now `web/**`, the card, `package.json`, `bun.lock` and the
workflow itself, as `browser.yml`.

**Owner ruling: a switch, default off.** "Quiet while MelodyMail is open" in Settings >
Notifications, stored in a one-row `settings` table (migration 0012, `CREATE TABLE IF NOT
EXISTS`; no row means off), `GET`/`PUT /api/settings/quiet` with a normal session. Off: the Hub
notifies exactly as in M5b and sends no `quiet`. On: the behaviour above. The in-page notice
shows in both modes. The page keeps reporting `"fg"`/`"bg"` with the switch off: it does not
know the setting, and the reports are cheap (below). `docs/M5c-foreground.md` has the ruling.

Durable Objects cost (developers.cloudflare.com/durable-objects/platform/pricing/, read
2026-11-16): Workers Free allows 100,000 requests and 13,000 GB-s a day; incoming WebSocket
messages are billed as requests at 20:1; an object that is idle and eligible for hibernation is
not billed for duration. A page in the foreground all day sends 2,880 refreshes, 144 billed
requests, plus one message per tab or window switch; each wakes the Hub for one
`serializeAttachment`. The setting costs one D1 row read per new mail, and only while a fresh
`"fg"` exists (Workers Free: 5 million row reads a day).

Proof:

- Worker: a report aged by 74 s still quiets new mail, one aged past 75 s does not, and a
  repeated `"fg"` makes it fresh again; with the setting off a foreground page changes nothing
  (`hub.spec.ts`); push goes out while a page reports `"fg"` with the setting off, not with it
  on, and again once the report is 75 s old (`push-hub.spec.ts`); the same for the Telegram card
  (`telegram-send.spec.ts`); the setting is off by default, changes with a session that has no
  fresh passkey, refuses anything but a boolean, and a failed read notifies as usual with a
  `quiet_setting_failed` warning (`quiet.spec.ts`); both routes are in the authz route walk.
- Browser: focus moves into the reader's frame, then `hasFocus()` turns false with no top-level
  event, and `"bg"` arrives; on Playwright's clock nothing is repeated at 29 s, `"fg"` is repeated
  at 30.5 s, and a background page repeats nothing; the switch starts off, stores the change and
  shows it after a reload. Tests that move the clock run in a context of their own (Playwright's
  clock is context-wide; the first try froze the later tests).
- Migration 0012 applied to the local D1 holding 20 messages; a second `db:migrate:local`
  reported nothing to apply; the file run again by hand succeeded.

Ablation (`ablate-m5c.ts` with `ablate-quiet-extra.ts`, scratchpad): 37 hunks, 37 red. New ones:
the 75 s check, the report time, the 1 s re-check, the refresh, refresh only in the foreground,
the refresh time, reading the setting, a failed read counting as off, the default off, the
boolean check, storing off, the page storing the switch; the reworked foreground condition and
its new-mail-only term again. Not ablated: the error banner of the switch section, the copy.

Numbers (dev workstation, Ryzen 9 9950X3D, Bun 1.4.4, CPU load read before each run):

- `bun run check`: 9.59, 9.62, 9.56 s at 0–2% load; 383 worker tests (378 before). Earlier the
  same day the host ran slower: 10.2–12.0 s, and `d1cc7b2` (before these fixes) measured 10.8 s
  for the worker suite alone then, against 10.3 s for these fixes, so that was the host.
- `bun run test:browser`: 26.22, 26.27, 26.25 s at 0–2% load, 58 tests. Before `4848d7b` it took
  29.0–30.9 s; the notice tests now install their stand-ins before the first navigation instead
  of loading the inbox twice.
- `bun run test:pwa`: 12.20, 12.37, 11.73 s at 1–5% load, 11 tests.
- `bun run test:telegram`: 6.05, 6.04, 6.03 s at 0–5% load, 12 tests.
- `bun run test:send`: 13.50 s at 2% load, 9 tests (one run).
- Bundle (gzip -6): total 720.4 → 720.9 kB (limit 770), first paint 311.8 kB unchanged.
- Files above the 242-line p90: `hub.spec.ts` 280, `push-hub.spec.ts` 245, `telegram-send.spec.ts`
  295, `stub-app.ts` 254, `pwa.test.ts` 349, `schema.ts` 402 (+13, the table). Same reasons as
  above; the setting's route tests went into a new `quiet.spec.ts` instead.

Screenshots: 18 more PNG files in `shots-m5c`, `quiet-<locale>-<mode>-<width>-<on|off>.png`:
Settings > Notifications at 390, 1280 and 1920 px, light and dark, en, zh-CN and ja-JP, the switch
on at 390 and 1920 px and off at 1280 px. `scrollWidth` equalled the viewport width in all 18.
The section keeps the page's two-column layout and stacks at 390 px.

Deferred (owner decides after release):

- The Hub's quiet decision can race a blur by milliseconds: mail that arrives as the owner
  leaves the page may be held back once. Source: M5c reviews. Waits: the window is up to 1 s
  (the local re-check, when focus leaves from inside the reader frame) plus a round trip; with
  the switch on, mail in it gets no notice, no push and no Telegram; the switch is off by
  default.
- A focused, visible, unattended desktop holds back remote notifications for as long as it stays
  so, by the owner's rule (the walk-away case). Source: M5c review. Waits: an idle timeout would
  change the rule; the owner decides.

Not verified: the real iframe case in a headed browser (the review's repro scripts were not
rerun; the browser test reproduces the missing top-level event with the focus stand-in); real
sleep or network loss; the switch against the deployed Worker; CI.

### Owner UI rulings after the re-review (2026-11-16)

Commits: `569d432` the mail card; `fa152b3` the Telegram tier limit; `bd3f2bf` the app's mark in
the header and on the sign-in page; `8114ff6` Figtree loaded from the app entry; and the docs
commit after them.

**The notice is a mail card.** The owner ruled that the new-mail notice must look different from
the ordinary toasts ("Setting saved." and errors stay inverted).

- The app now runs a local Astryx theme, `melody` (`web/src/themes/melody/melodyTheme.ts`), which
  extends neutral and adds one toast type, `mail`: `--color-background-card`, the primary text
  colour, a `--color-border-emphasized` border and `--shadow-high`. `astryx theme build`, `theme
  add melody`, `theme use melody` and `theme remove neutral` regenerated `astryx-themes.ts`. The
  toast measures its painted surface (MediaTheme auto), so the card's content takes the page's
  light or dark tokens. Every other token and component renders as with neutral: 324 custom
  properties and 80 sampled elements of the inbox compared equal in both palettes.
- `notice.tsx` passes `type: "mail"` and Toast's `renderContent`: an envelope icon, the sender in
  bold and the subject on one line (`maxLines={1}`, full value in its tooltip), then Open and a
  Close button that calls `dismiss`. The viewport keeps the bottom-right position, auto-hide,
  swipe and the polite announcement; with `renderContent` it announces the card's own text, so a
  visually hidden "New mail" names it ("New mail Sender Subject"). Three slots as before; no
  body; focus stays where it was.
- Toast's `type` is a closed union and `theme build` emits no augmentation for it, so the code
  casts `"mail"`. `isAutoHide: true` is redundant today (the viewport auto-hides every type but
  `"error"`, ToastViewport.tsx:294) and kept as a guard against a changed default.
- Deferred (M5c review hypothesis): with several cards on screen, their Open and Close buttons
  share accessible names; naming them with the sender would help screen-reader users. Waits: not
  checked with a screen reader.
- Generated theme files are excluded from Biome, as `astryx-themes.ts` already was.
- Found by the browser tier after the switch: the neutral module had been what imported Figtree
  (`fonts.css`, aliased to the self-hosted `src/fonts.css`). `src/main.tsx` now imports
  `src/fonts.css` itself; the alias stays as a guard. The token comparison above could not see
  this, because the computed font-family string does not change when the font is missing.

Contrast (WCAG 2.2, measured in Chromium from computed colours, 2026-11-16):

| Pair | Light | Dark | Needed |
| --- | --- | --- | --- |
| Sender on the card | 21.0 | 17.2 | 4.5 |
| Subject (supporting) on the card | 9.29 | 6.43 | 4.5 |
| Envelope icon on the card | 5.41 | 6.43 | 3 |
| Close icon on the card | 21.0 | 17.2 | 3 |
| Open label on its button | 18.4 | 12.9 | 4.5 |
| Card border against the page under it | 1.31 | 2.20 | see below |

The card's edge does not reach 3:1 against the page (card `#fff` on `#f1f1f1` in light, `#1b1b1b`
on `#1b1b1b` in dark; the border and the high shadow mark it). WCAG 1.4.11 asks 3:1 for what is
needed to identify a control; the card's controls (Open, Close) and its text each pass on their
own, so the edge is not counted as required. Listed for the owner below.

**Telegram tier limit.** The owner approved 10 s for `bun run test:telegram`
(`REQUIREMENTS.md`); open question 1 above records it.

**The header mark is the app's logo.** The header and the sign-in frame drew Astryx's generic
envelope since M0, while the favicon and the PWA icons come from `web/public/logo.svg` (M4b).
`AppLogo` renders that file as a decorative `img` (`alt=""`; the app name stands beside it) at
`--size-element-md` (32 px, the size the `NavIcon` took) in the header and `--size-element-lg`
(36 px) above the sign-in card. In dark mode the logo's own dark tile merges with the header and
the white mark stands alone, as the favicon does on a dark tab strip.

Proof: `notice.test.ts` checks the card's type and its two lines (sender, subject), the
announcement "New mail Sender Lunch on Friday?" in the polite region and nothing in the assertive
one, Open, the Close button, the three-slot cap, the "(no subject)" fallback, and that the mail
card is light while "Setting saved." beside it stays dark. The browser tier's existing font check
found the Figtree regression.

Ablation (`ablate-card.ts`, scratchpad): 9 hunks, 9 red: the theme rule for `mail`, the `mail`
type, Close's dismiss, the hidden "New mail", the sender, the no-subject copy, Open's dismiss,
Open's navigation, the three slots. Not ablated: `isAutoHide: true` (the 5 s auto-hide is not
waited for in the suite), the `StackItem` that keeps Open and Close from shrinking (checked in
the screenshots: the first try cut Open to "O.." beside a long subject), `AppLogo` (visual,
checked in the screenshots; no test asserts the mark), the Figtree import (one hunk; the existing
font check fails without it).

Numbers (dev workstation, Ryzen 9 9950X3D, Bun 1.4.4):

- Bundle (gzip -6, the scratchpad's `bundle-entry.ts`, each commit built on this host): entry plus
  preloaded JS 263.1 → 266.4 kB (limit 270), first paint 311.8 → 315.2 kB (limit 370), total 720.9
  → 724.7 kB (limit 770); `logo.svg` adds one 413-byte (gzip) request. The 3.3 kB on the entry
  is the generated theme module, which imports neutral for its icons and carries its own token
  map; the same build with the neutral module measured 263.0 kB. 3.6 kB of entry headroom is
  left.
- `bun run check`: 12.85, 12.26, 12.01 s at 6–17% load (limit 15 s). `bun run test:browser`: 28.28,
  26.31, 27.46 s at 3–24% load, 58 tests (limit 30 s). `test:pwa` 12.65 s, `test:telegram` 6.56 s,
  `test:send` 14.46 s, one run each at 0–2% load.

Screenshots (`shots-m5c`): `notice-<locale>-<mode>-<width>.png` replaced (18: 390, 1280 and 1920
px, light and dark, three locales; two mail cards, one with a long subject);
`notice-with-toast-en-<mode>-1280.png` (2: "Setting saved." above a mail card);
`header-en-<mode>-<width>.png` and `signin-en-<mode>-<width>.png` (8: 390 and 1280 px, light and
dark). `scrollWidth` equalled the viewport width in all of them. Every shot listed here was taken
after the Figtree fix.

Deferred (owner decides after release):

- The card's edge against the page is 1.31:1 (light) and 2.20:1 (dark), under 3:1; the text and
  the controls pass. A stronger border token (text-secondary) would pass at the cost of a heavier
  outline. Source: this round's measurement.
- The generated theme module duplicates neutral's token map (+3.3 kB gzip on the entry). Source:
  this round. Waits: an Astryx build option or a slimmer theme; within the limit today.
- The truncated subject shows its full value in the Text tooltip on hover only; the Open button
  gives the full message on touch. Source: web/AGENTS.md "Values never break". Waits: the notice
  is transient and Open covers it.

Not verified: the card with a screen reader (only the live region's text was read); the notice
in Safari and Firefox; the logo's 32 px rendering on a high-density display (headless at 1x).
