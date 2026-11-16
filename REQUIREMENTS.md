# REQUIREMENTS.md: numbers, gates and exceptions

Commands, numbers, gates and exceptions for this repository. The rules themselves are in `AGENTS.md`,
`.github/AGENTS.md`, `web/AGENTS.md` and `worker/AGENTS.md` and are not repeated here. When another
file in this repository disagrees with this one on a command, a number, a gate or an exception, this
file wins.

`scripts/check-requirements.py` checks this file in the merge gate. It reads files and runs
nothing. Write a pipe inside a cell as `\|`. Write a command in backticks; the check confirms that
a script named in it exists.

## Rule files

Every `AGENTS.md` in this repository, by path. The check reads rule groups only from the files
marked `yes`, and fails on an `AGENTS.md` it finds that is not listed. It searches every directory
except `.git`, `node_modules`, `vendor`, `third_party` and hidden directories other than
`.github`. Mark a file `no`, with the reason in Note, when its rules are not this project's (a
vendored package, a generated tree).

| File | Checked | Note |
| --- | --- | --- |
| AGENTS.md | yes | |
| .github/AGENTS.md | yes | |
| web/AGENTS.md | yes | |
| worker/AGENTS.md | yes | |

## Commands

One row per tier in `.github/AGENTS.md`, "Tiers, jobs and gates". Write the exact command that a
person and CI both run. Fill in this order: the command; then three runs on the same host, recorded
as the baseline; then the limit, as the baseline plus a margin (start at 20%).

| Tier | Command | Runs (where, when) | Wall-time limit | Baseline (date, host, load) |
| --- | --- | --- | --- | --- |
| Pre-commit | `bun run lint` | locally, before each commit (no hook yet) | 1 s | 0.34 s, 3 runs 0.34–0.46 s (2026-11-15, dev workstation, Ryzen 9 9950X3D, CPU load ~80%) |
| Merge gate | `bun run check` | CI on every pull request and push to main; locally before push | 15 s (owner approval 2026-11-16, headroom for host load; 12 s before, 10 s before that) | 9.6 s after the M5c review fixes and the quiet switch, 3 runs 9.56–9.62 s (383 worker tests), CPU load 0–2% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 9.4 s after M5c, 3 runs 9.34–9.48 s (378 worker tests), CPU load 0–7%; the base `39a8302` ran 9.49–9.94 s under the same load; the worker pool no longer reads `web/dist` (2026-11-16, dev workstation, Ryzen 9 9950X3D); 13.7 s after the M5b plain-message buttons, 3 runs 13.3–14.3 s (374 worker tests), CPU load 22–25% (2026-11-16, dev workstation, Ryzen 9 9950X3D; the base 9044c08 ran 13.0–13.2 s under the same load); 10.2 s after M5b, 3 runs 10.00–10.45 s (368 worker tests), CPU load 11–24% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 9.8 s after the fourth M5 fix round, 5 runs 9.40–10.19 s (335 worker tests), CPU load 1–5% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 9.5 s after the third M5 fix round, 3 runs 9.34–9.86 s (335 worker tests), CPU load 1–5% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 9.3 s after the second M5 fix round, 3 runs 9.18–9.46 s (327 worker tests), CPU load 0–7% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 9.6 s after the M5 review fixes, 3 runs 9.05–10.01 s and 3 more 9.10–9.59 s (324 worker tests), CPU load 1–3% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 8.5 s after M5, 3 runs 8.3–8.6 s (315 worker tests), CPU load 1% (2026-11-16, dev workstation, Ryzen 9 9950X3D). Earlier: 7.2 s, 3 runs 6.5–7.8 s with the steps run concurrently by `scripts/check.ts`, CPU load 9–14% (2026-11-16, dev workstation, Ryzen 9 9950X3D); sequential before: 10.6–11.1 s |
| Scheduled run on main | `bun run test:browser` | CI nightly on main and on pull requests that touch `web/` (`.github/workflows/browser.yml`); locally before a web change is pushed | 30 s (owner approval 2026-11-16; 26 s before) | 26.2 s after the M5c review fixes and the quiet switch, 3 runs 26.22–26.27 s including the web build (58 tests), CPU load 0–2% (2026-11-16, dev workstation, Ryzen 9 9950X3D). 25.7 s after the Telegram suites moved to `bun run test:telegram` (M5b owner ruling 1), 3 runs 25.37–26.11 s including the web build (55 tests), CPU load 0–10% (2026-11-16, dev workstation, Ryzen 9 9950X3D). 29.7 s after M5c before that split, 3 runs 29.67–29.74 s including the web build (67 tests), CPU load 2%; the base `39a8302` ran 25.34–26.22 s, CPU load 4–11%; at 55–70% load the M5c tier took 29.85–30.86 s, over the limit in 2 of 3 runs (open question in `docs/STATE.md`, M5c) (2026-11-16, dev workstation, Ryzen 9 9950X3D). 27.1 s after M5b, 3 runs 25.81–29.52 s including the web build (64 tests; the first run of the series was slow), CPU load 15–25% (2026-11-16, dev workstation, Ryzen 9 9950X3D). 21.8 s after the fourth M5 fix round, 3 runs 20.60–25.07 s including the web build (52 tests; the first run of the series was slow), CPU load 1–3% (2026-11-16, dev workstation, Ryzen 9 9950X3D). 21.8 s after the third M5 fix round, 3 runs 21.67–22.53 s including the web build (52 tests), CPU load 0–3% (2026-11-16, dev workstation, Ryzen 9 9950X3D). 22.5 s after the second M5 fix round, 3 runs 20.73–25.14 s including the web build (52 tests; the first run of the series was slow, as in the re-review's single run of 25.2 s), CPU load 1–4% (2026-11-16, dev workstation, Ryzen 9 9950X3D). 21.7 s after the sending suites moved to `bun run test:send` (owner ruling 2026-11-16), 3 runs 21.45–21.90 s including the web build (52 tests), CPU load 1–10% (2026-11-16, dev workstation, Ryzen 9 9950X3D). Before the split, after M5: 34.1 s wall, 3 runs 32.5–35.3 s including the web build (60 tests; the 47 earlier ones alone 21.3 s on the same host), CPU load 0–2% (2026-11-16). 21.8 s after M4b, 3 runs 21.44–22.30 s including the web build (47 tests; the PWA suite is split out); main before M4b measured 19.9 s on the same host the same day (2026-11-16, dev workstation, Ryzen 9 9950X3D, CPU load 1–5%). Earlier: 17.4 s, 3 runs 16.81–17.62 s (35 tests, 2026-11-16) |
| Scheduled send run | `bun run test:send` | CI nightly on main, by hand, and on pull requests that touch compose, the send-related reader files or these tests (`.github/workflows/send.yml`); split out by owner ruling 2026-11-16 | 18 s (owner approval 2026-11-16; 14 s by owner ruling 2026-11-16 before) | 14.3 s after M5b, 3 runs 14.23–14.33 s including the web build (9 tests), CPU load 1–13% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 14.0 s after the fourth M5 fix round, 3 runs 13.86–14.45 s including the web build (9 tests in 3 files: the reader's send states moved to `sent-status.test.ts`), CPU load 1–10% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 14.6 s after the third M5 fix round, 3 runs 13.96–14.67 s including the web build (9 tests), over the 14 s limit then in two runs, CPU load 0–1% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 12.9 s after the second M5 fix round, 3 runs 12.67–13.13 s including the web build, CPU load 0–3% (2026-11-16); 12.7 s, 3 runs 12.37–13.20 s including the web build (9 tests: `compose.test.ts`, `markdown.test.ts`), CPU load 0–3% (2026-11-16, dev workstation, Ryzen 9 9950X3D) |
| Scheduled PWA run | `bun run test:pwa` | CI nightly on main, by hand, and on pull requests that touch the service worker or its build (`.github/workflows/pwa.yml`); split out by owner ruling 2026-11-16 | 15 s | 12.1 s after the M5c review fixes, 3 runs 11.73–12.37 s including the web build (11 tests), CPU load 1–5% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 12.1 s after M5c, 3 runs 11.68–12.35 s including the web build (11 tests), CPU load 0–1% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 11.5 s after M5b, 3 runs 11.03–11.74 s including the web build (11 tests), CPU load 0–4% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 12.3 s, 3 runs 11.89–13.25 s including the web build (11 tests, persistent Chromium profile), CPU load 1–5% (2026-11-16, dev workstation, Ryzen 9 9950X3D) |
| Scheduled Telegram run | `bun run test:telegram` | CI nightly on main, by hand, and on pull requests that touch `web/`, the card or the dependencies, as the browser tier (`.github/workflows/telegram.yml`); split out by M5b owner ruling 1 (2026-11-16) | 10 s (owner approval 2026-11-16) | 6.0 s after the M5c review fixes, 3 runs 6.03–6.05 s including the web build (12 tests), CPU load 0–5% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 6.8 s, 3 runs 6.51–6.95 s including the web build (12 tests), CPU load 0–10% (2026-11-16, dev workstation, Ryzen 9 9950X3D) |
| Release | | | | |

## Numbers

Every limit has a measured baseline next to it. Record the date, the host and its load for each
baseline. Leave the limit empty until it has been measured, and list it under "Not yet enforced"
meanwhile.

| Item | Limit | Baseline (date, host, load) | Enforced by |
| --- | --- | --- | --- |
| Type scale (role: size / line height) | Astryx theme-neutral type tokens only; no literal font size | a setting, not measured | design system |
| Spacing scale (section, card, inside card, label to field) | Astryx spacing tokens only; no literal pixel value | a setting, not measured | design system |
| Page frame width; readable column width | | | e2e page-width check |
| Supported widths (phone, laptop, wide) | phone 390 px, laptop 1280 px, wide 1920 px; tables stack below Astryx's sm breakpoint (640 px) | a setting, not measured (owner ruling 2026-11-16) | screenshots |
| Full end-to-end run, wall time | 30 s (owner approval 2026-11-16; 26 s before) | 29.7 s after M5c, the same 3 runs as the scheduled tier (29.67–29.74 s at 2% load; 29.85–30.86 s at 55–70% load); 27.1 s after M5b, the same 3 runs as the scheduled tier (25.81–29.52 s); 21.8 s after the fourth M5 fix round, the same 3 runs as the scheduled tier (20.60–25.07 s); the send suites run apart in 14.0 s; 21.8 s after the third M5 fix round, the same 3 runs as the scheduled tier (21.67–22.53 s); the send suites run apart in 14.6 s (`bun run test:send`); 22.5 s after the second M5 fix round (20.73–25.14 s); 21.7 s after the send split; 34.1 s after M5 before the split; 21.8 s after M4b, the same 3 runs as the scheduled tier (17.4 s before M4b); the mailbox API is an in-memory stand-in, the Worker is covered by its own suite (2026-11-16, dev workstation, Ryzen 9 9950X3D, CPU load 1–5%) | `bun run test:browser` in CI |
| Slowest test package | 10.8 s (owner approval 2026-11-16; 9 s before) | 8.2 s after M5c, worker suite (vitest Duration) run alone, 378 tests, CPU load 0–7% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 9.2 s after M5b, worker suite (vitest Duration) inside the concurrent gate, 3 runs 8.99–9.41 s, 368 tests, CPU load 11–24% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 8.6 s after the fourth M5 fix round, worker suite (vitest Duration) inside the concurrent gate, 5 runs 8.21–9.03 s, one run over the 9 s limit then, CPU load 1–5% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 8.3 s after the third M5 fix round, worker suite (vitest Duration) inside the concurrent gate, 3 runs 8.09–8.55 s, CPU load 1–5% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 8.1 s after the second M5 fix round, worker suite (vitest Duration) inside the concurrent gate, 3 runs 7.98–8.22 s, CPU load 0–7% (2026-11-16); 8.3 s after the M5 review fixes, worker suite (vitest Duration) inside the concurrent gate, 6 runs 7.82–8.83 s, CPU load 1–3% (2026-11-16, dev workstation, Ryzen 9 9950X3D); 7.6 s after M5, worker suite (vitest Duration) inside the concurrent gate, 3 runs 7.40–7.71 s, CPU load 1% (2026-11-16, dev workstation, Ryzen 9 9950X3D); earlier 6.1 s, worker suite (vitest Duration) inside the concurrent gate, 3 runs 5.48–6.62 s, CPU load 9–14% (2026-11-16, dev workstation, Ryzen 9 9950X3D); about 80% of it is transform | review |
| Frontend entry chunk and the JS it preloads statically, gzip | 270 kB (row redefined by owner ruling 2026-11-16) | 266.4 kB after the M5c mail card (263.1 kB at `83f0082`, same script): the local melody theme module, which imports neutral for its icons and carries its own token map (2026-11-16, vite build, gzip -6, each commit built on the dev workstation); 263.1 kB after M5b (263.0 kB at the base `339d865`, same script; 2026-11-16, vite build, gzip -6, 3 builds identical); 263.1 kB after the third M5 fix round, unchanged from the base `de4b1c5` measured with the same script, 5 files (2026-11-16, vite build, gzip -6, 3 builds identical); earlier 263.0 kB: the entry chunk 3.4 kB plus the 4 chunks `index.html` preloads, the vendor chunk 257.3 kB among them (2026-11-16, vite build, gzip -6, 3 builds identical). Earlier values measured the entry chunk alone: 3.4 kB after the M5 vendor chunk rule (`web/vite.config.ts`): the libraries the first paint loads moved into one 257.3 kB vendor chunk, also preloaded (2026-11-16, vite build, gzip -6, 3 builds identical); 16.5 kB after M5 (16.2 kB before), 2026-11-16, vite build, gzip -6; 16.2 kB after M4b (15.6 kB before), 2026-11-16, vite build, gzip -6; 15.6 kB after M4 (15.4 kB before), vite build, gzip -6; 14 kB on 2026-11-15 | review |
| Frontend first paint (sign-in page), JS + CSS gzip | 370 kB | 315.2 kB after the M5c mail card, the app logo and the Figtree import (311.8 kB at `83f0082`, same script; 2026-11-16, vite build, gzip -6); 311.8 kB after M5b, unchanged from the base `339d865` (2026-11-16, vite build, gzip -6, 3 builds identical); 311.8 kB after the third M5 fix round, unchanged (2026-11-16, vite build, gzip -6, 3 builds identical); 311.8 kB after the M5 vendor chunk rule (owner ruling 2026-11-16; 322.9 kB before it, 319.0 kB before M5, same script and host): 7 assets instead of 31; marked is only in the compose chunk (2026-11-16, vite build, gzip -6, 3 builds identical); 322.9 kB after M5 (319.0 kB before, same script and host): the compose chunk shares Astryx modules with the first paint and the bundler split them into four more preloaded chunks; marked is in none of them (open question in `docs/STATE.md`, M5; 2026-11-16, vite build, gzip -6); 319.0 kB after M4b (314.6 kB before, same script and host): the network store, the offline and update banners, the route-guard change; the service worker registration loads after the page load event from its own chunk (2026-11-16, vite build, gzip -6); 314.6 kB after M4 with Figtree self-hosted (313.5 kB before), index.html and every asset it references, 2026-11-16, vite build, gzip -6; postal-mime and DOMPurify are in none of them; font files are not counted: the Figtree latin woff2 for the 4 weights is 45.7 kB, all 16 woff2 files 70.5 kB; 309 kB on 2026-11-15 | review |
| Frontend total JS + CSS, gzip | 770 kB (owner approval 2026-11-16) | 724.7 kB after the M5c mail card, the app logo and the Figtree import (720.9 kB at `83f0082`, same script; 2026-11-16, vite build, gzip -6); 720.3 kB after M5b (716.5 kB at the base `339d865`, same script): Settings > Notifications > Telegram in the lazy notifications chunk (2026-11-16, vite build, gzip -6, 3 builds identical); 716.7 kB after the third M5 fix round (715.9 kB at the base `de4b1c5`, same script), compose chunk 51.5 kB (2026-11-16, vite build, gzip -6, 3 builds identical); 715.5 kB after the M5 vendor chunk rule, compose chunk 51.4 kB (2026-11-16, vite build, gzip -6, 3 builds identical); 736.4 kB after M5 (660.0 kB before, same script): the compose chunk with marked 51.8 kB, loaded only when compose opens, plus Sent, Drafts and the reader's sent view (2026-11-16, vite build, gzip -6); 660.0 kB after M4b (643.1 kB before, same script): Settings > Notifications, the registration chunk with workbox-window, the dark-reading toggle; the service worker itself is not part of the page and is 11.5 kB gzip (33.0 kB raw, `web/dist/sw.js`, 2026-11-16, vite build, gzip -6); 643.0 kB after M4 with Figtree self-hosted (568.4 kB before): the parse worker with postal-mime 30.6 kB and the reader chunk with DOMPurify 22.1 kB load only when a message is opened (2026-11-16, vite build, gzip -6); 508 kB on 2026-11-15 | review |
| Source file size, p90 of this repository (pass bar) | 242 lines | 242 lines: the 180th of 199 git-tracked .ts/.tsx/.py files after M5b, same method (2026-11-16); 2 files above it from M5b, each with a reason in `docs/STATE.md`, M5b; 239 lines: the 165th of 183 git-tracked .ts/.tsx/.py files sorted by line count (nearest rank, ceil(0.9 × n); `.d.ts` excluded), at the fourth M5 fix round (2026-11-16); 18 files above it, each with a reason in `docs/STATE.md`, M5; 271 lines at `66d8f34` by the same method (the review's 263 is the 162nd of 181, one rank lower); 314 lines over 15 .ts/.tsx/.py files (2026-11-15) | review |
| Telegram card HTML (`worker/src/telegram/card.html`), sendWidget limits | 4,096 bytes after zlib level 9; 32,768 bytes raw; no U+0000 (Bot API 10.4, `sendWidget`) | 1,989 bytes compressed, 3,809 raw (2026-11-16, Python 3.13 zlib, the counter the widgets guide names) | `bun run check:widget`; `bun run test:scripts` runs it on the card and on planted violations in the merge gate |
| Wait timeout before a stuck step is recorded and left | 30 min | a setting, not measured | agent |
| Context handoff limit (share of the model's window) | 60% | a setting, not measured | orchestrator |
| Status check interval while several jobs run | 10 min | a setting, not measured | orchestrator |
| Commit subject length | 72 characters | a setting, not measured | commit hook |
| CPU time per Worker invocation, production | | | Workers Logs cpuTime, review |
| Inbound header parse, JS time per message (Bun benchmark) | 3 ms p95 per input | one pass over the first 64 KB (owner ruling 2026-11-16): worst p95 1.23–1.35 ms over 38 inputs (15 fixtures, a 20 MiB message, text after 64 KB, 13 crafted MIME shapes, 8 adversarial HTML bodies including 60 KB dense with short tags; worst: an unclosed boundary with a long text part, and 499 base64 parts); all inputs together median 0.07–0.08 ms, p95 0.64–0.71 ms; 3 runs of 200 per input (2026-11-16, dev workstation, Ryzen 9 9950X3D, Bun 1.4.4, CPU load 1–10%) | `bun worker/bench/parse.ts` (exits 1 over the limit), review |
| Passkey assertion verification, JS time per login (Bun benchmark) | 3 ms p95 | median 0.19–0.20 ms, p95 0.44–0.70 ms, 3 runs of 200 (2026-11-15, dev workstation, Ryzen 9 9950X3D, Bun 1.4.4, CPU load ~68%) | `bun worker/bench/auth.ts`, review |
| Telegram webhook and card, JS time per input (Bun benchmark) | 3 ms p95 per input | a 64 KB update (the cap): median 0.047–0.048 ms, p95 0.078–0.087 ms; a tap: p95 0.006–0.007 ms; a worst-case card with its sendWidget body: median 0.034–0.035 ms, p95 0.047–0.064 ms; 3 runs of 200 per input (2026-11-16, dev workstation, Ryzen 9 9950X3D, Bun 1.4.4, CPU load 2%) | `bun worker/bench/telegram.ts` (exits 1 over the limit), review |
| TOTP check (3 HMAC-SHA-1 steps), JS time per recovery (Bun benchmark) | 3 ms p95 | median 0.07–0.08 ms, p95 0.17–0.32 ms, 3 runs of 200 (2026-11-15, dev workstation, Ryzen 9 9950X3D, Bun 1.4.4, CPU load ~68%) | `bun worker/bench/auth.ts`, review |

## Enforcement

One row per rule group of every file checked under "Rule files": each `###` heading, named
`path: heading`, and each rule tagged `[rule: <id>]`, named `path#id`. The check reports a group
with no row, and a row whose group no longer exists, so renaming a heading means renaming its row.

Fill one or both of:

- Gate command: the command, in backticks, that turns red on a violation, run by a tier in
  "Commands";
- Review criterion: the `REVIEW.md` section that checks it, with the file name in backticks.

Or fill only "Does not apply because" with what the project lacks (no admin panel, no i18n). A
tagged rule marked as not applying needs the owner's approval, quoted in the commit body.

| Rule group | Gate command | Review criterion | Does not apply because |
| --- | --- | --- | --- |
| AGENTS.md: Change risk |  | `REVIEW.md`, "Scope" |  |
| AGENTS.md: Workflow |  | `REVIEW.md`, "Pass bar" |  |
| AGENTS.md: When unsure |  | `REVIEW.md`, "Before you start" |  |
| AGENTS.md: Waiting |  |  | it governs how an agent spends a session and leaves nothing in the repository to check |
| AGENTS.md: Reporting |  | `REVIEW.md`, "Every finding has evidence" |  |
| AGENTS.md: Code quality | `bun run lint` | `REVIEW.md`, "Pass bar" |  |
| AGENTS.md: Impact and edge cases |  | `REVIEW.md`, "Scope" |  |
| AGENTS.md: Secrets |  | `REVIEW.md`, "Checking against the rules", Sensitive data |  |
| AGENTS.md: Performance baseline |  | `REVIEW.md`, "Checking against the rules" |  |
| AGENTS.md: Tests (if present) | `bun run test` | `REVIEW.md`, "Every finding has evidence" |  |
| AGENTS.md: Merging |  | `REVIEW.md`, "Report" |  |
| AGENTS.md: Model usage |  | `REVIEW.md`, "Before you start" |  |
| AGENTS.md: Documentation |  | `REVIEW.md`, "CI, docs and commits" |  |
| AGENTS.md: Writing (docs, comments, reports, PR and issue text) |  | `REVIEW.md`, "CI, docs and commits" |  |
| AGENTS.md: Commits and pull requests |  | `REVIEW.md`, "CI, docs and commits" |  |
| AGENTS.md: Frontend–backend mapping (when both exist) |  | `REVIEW.md`, "Checking against the rules", Authorization |  |
| .github/AGENTS.md: Tiers, jobs and gates |  | `REVIEW.md`, "CI, docs and commits" |  |
| web/AGENTS.md: Components and modularity |  | `REVIEW.md`, "Pass bar" |  |
| web/AGENTS.md: Consistency |  | `REVIEW.md`, "Checking against the rules", Layout, type and loading |  |
| web/AGENTS.md: Layout, type and loading |  | `REVIEW.md`, "Checking against the rules", Layout, type and loading |  |
| web/AGENTS.md: i18n (if present) | `bun scripts/check-i18n.ts` | `REVIEW.md`, "Checking against the rules", Copy and i18n |  |
| web/AGENTS.md: Usability |  | `REVIEW.md`, "Checking against the rules" |  |
| web/AGENTS.md: Accessibility |  | `REVIEW.md`, "Checking against the rules", Accessibility |  |
| web/AGENTS.md: Performance |  | `REVIEW.md`, "Pass bar" |  |
| worker/AGENTS.md: APIs and modularity |  | `REVIEW.md`, "Pass bar" |  |
| worker/AGENTS.md: Compatibility |  | `REVIEW.md`, "Checking against the rules", Migrations |  |
| worker/AGENTS.md: Logging |  | `REVIEW.md`, "Checking against the rules", Sensitive data |  |
| worker/AGENTS.md: Security (if present) |  | `REVIEW.md`, "Checking against the rules", Authorization |  |
| worker/AGENTS.md#authz | `bun run test` | `REVIEW.md`, "Checking against the rules", Authorization |  |
| worker/AGENTS.md#sensitive-values |  | `REVIEW.md`, "Checking against the rules", Sensitive data |  |
| worker/AGENTS.md: Retries and concurrency | `bun run test` | `REVIEW.md`, "Checking against the rules", Retries and concurrency |  |
| worker/AGENTS.md: Background work (if present) | `bun run test` | `REVIEW.md`, "Checking against the rules", Retries and concurrency |  |
| worker/AGENTS.md: Operations (if present) |  | `REVIEW.md`, "Checking against the rules" |  |
| worker/AGENTS.md: Admin panel (if present) |  | `REVIEW.md`, "Pass bar" |  |
| worker/AGENTS.md: Performance |  | `REVIEW.md`, "Pass bar" |  |
| worker/AGENTS.md: Verification | `bun run test` | `REVIEW.md`, "Checking against the rules" |  |

## Exceptions

Backend endpoints with no frontend caller:

| Endpoint | Caller | Reason |
| --- | --- | --- |
| GET /api/health | deploy and uptime checks; the app probes it while offline (`web/src/network.ts`) | liveness probe; carries no data |
| GET /api/uploads/:id/blob | Resend, fetching an attachment of a message being sent | public, opened only by an HMAC-signed URL valid for 24 hours (`worker/src/send/signed-url.ts`) |
| POST /api/webhooks/resend | Resend delivery events | public, authenticated by the Svix signature (`worker/src/send/webhook.ts`) |
| POST /api/webhooks/telegram | Telegram updates (the `/start` that binds the chat, card button taps) | public, authenticated by the secret token Connect registers; only its SHA-256 is stored (`worker/src/telegram/webhook.ts`) |

Intentional designs that look like defects:

| What | Why | Owner ruling (date, quote) |
| --- | --- | --- |

## Not yet enforced

A row of "Commands", "Numbers" or "Enforcement" that is not filled yet goes here, named
`Section: row`, for example `Numbers: Slowest test package`. The merge gate fails on:

- an unfilled row that is not listed here;
- a listed row that is already filled, or that does not exist;
- a Due date that has passed.

Due holds one date (YYYY-MM-DD). Moving it later needs the owner's approval, quoted in the commit
body.

| Row | Current state | Plan | Due |
| --- | --- | --- | --- |
| Commands: Release | no release flow yet | add with the deploy rehearsal in M7 | 2027-03-31 |
| Numbers: Page frame width; readable column width | the shell has no content pages yet | measure once the mail list and settings pages exist (M4) | 2027-01-31 |
| Numbers: CPU time per Worker invocation, production | not deployed yet; Workers Free caps it at 10 ms | read cpuTime from Workers Logs after the first deploy | 2027-02-28 |

## Example (illustrative values; measure your own)

| Tier | Command | Runs (where, when) | Wall-time limit | Baseline (date, host, load) |
| --- | --- | --- | --- | --- |
| Pre-commit | `scripts/check-all.sh --fast` | locally, every commit | 5 s | 3.8 s (2026-11-12, build host, load 0.4) |
| Merge gate | `scripts/check-all.sh --strict` | CI, every merge | 15 min | 11 min (2026-11-12, build host, load 1.2) |

| Rule group | Gate command | Review criterion | Does not apply because |
| --- | --- | --- | --- |
| web/AGENTS.md: i18n (if present) | `scripts/check-i18n.sh` | | |
| worker/AGENTS.md#authz | `scripts/check-authz.sh` | `REVIEW.md`, "Checking against the rules", Authorization | |
| worker/AGENTS.md: Admin panel (if present) | | | the project has no admin panel |
| AGENTS.md: Writing (docs, comments, reports, PR and issue text) | | `REVIEW.md`, "CI, docs and commits" | |

| Row | Current state | Plan | Due |
| --- | --- | --- | --- |
| Numbers: Slowest test package | not measured | measure after the race suite lands | 2027-01-31 |
