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

## M1: authentication (review fixes and owner rulings done, waiting for review)

Design: `docs/M1-auth.md`, updated 2026-11-15 to match the code and the owner rulings below. Work
is on branch `m1-auth`; it merges only after the owner reviews it. Not pushed; no pull request.

### Owner rulings (2026-11-15)

- A. Recovery lockout counts per client IP (5 failures / 15 min lock that IP) and globally (20
  failures / 15 min lock everyone). Both reservations are atomic and come before verification.
  The README `wrangler d1 execute` command clears both. Numbers as proposed; unchanged.
- B. Step-up re-authentication: adding or deleting a Passkey, signing out other sessions and
  regenerating the recovery key need a Passkey assertion on the current session within 5
  minutes (`sessions.reauth_at`); else 403 `reauth_required`. `POST /auth/reauth/options` and
  `/auth/reauth/verify` refresh it. Sessions created by setup, sign-in or recovery start fresh.
- C. A successful recovery signs out every other session.
- D. `POST /auth/recovery-key` regenerates the recovery key while signed in (needs B); Settings >
  Security has "Regenerate recovery key" with confirmation.
- E. Reduce size and time before any limit is raised; limits in `REQUIREMENTS.md` stay as they are.

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
- `bun --bun vitest run` in `worker/`: 88 tests against the D1 in workerd.
- Ablation (`AGENTS.md`, Tests), script removes or inverts one hunk per run:
  85 hunks, 84 turned at least one test red. Covered: every hunk listed in the first M1 report
  (origin check, authorization, rate limit, setup, challenges, sign-in, recovery, sessions,
  Passkeys, TOTP, input and error handling), plus the review fixes (atomic reservation, window
  prune, retryAfter, passkey_exists re-check, both log redactions) and the rulings (per-IP limit,
  global limit, global row only with the per-IP row, retryAfter per counter, clearing both
  counters, recovery ending other sessions, fresh-auth null and expiry checks, sessions starting
  fresh, reauth updating only the current session, regenerated key stored, and requireFreshAuth
  on each of its five routes). Survivor: the explicit `if (!passkey)` in `checkAssertion`;
  without it `verifyAuthentication` throws inside its own `try` and also answers 401. Kept as
  the explicit check. The counter-regression rule is enforced by `@simplewebauthn/server` and
  covered by a test. The web in-flight guard has no test (the web app has no test runner); it was
  checked by reading.
- `wrangler dev` (local, port 8788, before the rulings): state, setup token, login options,
  403 and 401 paths, SPA routes. `db:migrate:local` applies without `database_id` and reruns as
  a no-op on a database with rows.
- Benchmark: `bun worker/bench/auth.ts`, 3 runs (see `REQUIREMENTS.md`).

### Not verified

- No real browser or authenticator has run the flows; only the software authenticator in the
  tests. Screenshots (phone and desktop, light and dark, three locales) are for the orchestrator.
- The re-authentication prompt and the regenerate dialog in a browser.
- `vite dev` behind its `/api` proxy (Origin and RP ID come from the request URL).
- Rate Limiting binding on the real Free plan; production `cpuTime`.
- `cf-connecting-ip` is set by Cloudflare in production; in `wrangler dev` and tests it comes
  from the request, so the per-IP counter falls back to the key `unknown` when it is missing.
- Port 8787 on this machine is held by an older `wrangler dev` (not started in this work) with
  the M0 config; restart it before screenshots.

### Open questions for the owner

1. Limits after E (see the table): worker suite 2 s, merge gate 6.2 s and total bundle 460 kB
   are still exceeded; the options to get under are listed above.
2. The recovery lock is a sliding window: it lasts until the oldest counted attempt is 15
   minutes old, so at most 15 minutes, not exactly 15 minutes after the latest failure.
3. `/api/auth/state` is fetched on every route change (one small request); no cache.

Resolved by the owner rulings above: global lockout abuse (A), step-up re-authentication (B),
recovery ending other sessions (C, was OQ6), recovery-key regeneration (D). Earlier design
questions are now in `docs/M1-auth.md`: RP ID on `localhost`, recovery key of 160 bits, optional
`label` on Passkey registration, `setup_disabled` (503).
