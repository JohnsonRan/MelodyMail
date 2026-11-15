# STATE

Working state for the current milestone. The plan is in `docs/PLAN.md`.

## M0: repository skeleton (in progress)

Updated 2026-11-15.

Done:

- Bun workspaces `worker` and `web`; `bun.lock` committed; Bun pinned to 1.4.4 in `package.json`.
- Worker: Hono app with `GET /api/health` and a JSON 404 for unknown API routes; `email()` rejects
  every recipient until the address list exists (M2/M3). Static assets from `web/dist`, with
  `/api/*` always reaching the Worker.
- Worker tests: `@cloudflare/vitest-plugin` under `bun --bun vitest`, 3 tests pass.
- Web: React 19, Vite, Astryx 0.7.16 with the neutral theme, `AppShell` with top bar, folder
  navigation and an empty inbox state; language selector (zh-CN, en, ja-JP) and theme selector
  (system, light, dark), both remembered in `localStorage`.
- Gates: `bun run check` runs lint (Biome), typecheck, worker tests, script tests, the i18n check,
  the build and the requirements check. CI runs the same command (`.github/workflows/ci.yml`).
- `scripts/check-i18n.ts` with tests; shown to fail on a planted missing key (exit 1) and on an
  empty locale set (exit 2).
- `REQUIREMENTS.md` filled: Commands, Numbers, Enforcement, Exceptions, Not yet enforced.

Blocked or unverified:

- wrangler refuses the Bun runtime. Needs the owner's decision (see open questions).
- `scripts/check-requirements.py` and its tests have never run: the local permission policy
  denied running them. `REQUIREMENTS.md` was filled by reading the check's rules, not by running it.
- No screenshots: the browser extension was not connected. The build was served with
  `vite preview` and returned the page (HTTP 200, SPA fallback works), but nothing was looked at.
- CI has not run: the repository has no remote yet.
- Free-plan availability of Queues, Durable Objects and Rate Limiting is not checked yet.

Open questions for the owner:

1. wrangler under Bun: allow wrangler (only wrangler) to run on Node, or another way?
2. Approve marking `worker/AGENTS.md#money-idempotent` and `#ledger` as not applying (no money
   moves in this service)?
3. Allow running `scripts/check-requirements.py` and its tests locally.

Next:

- CJK font fallback in the theme (Astryx's Figtree has no CJK glyphs); do it with the theme editor.
- Astryx catalogs for zh-CN and ja-JP are imported statically; load them per locale to shrink the
  entry chunk (224 kB gzip baseline).
