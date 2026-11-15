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
| Merge gate | `bun run check` | CI on every pull request and push to main; locally before push | 6.2 s | 5.1 s, 3 runs 4.6–5.9 s (2026-11-15, dev workstation, Ryzen 9 9950X3D, CPU load ~80%) |
| Scheduled run on main | | | | |
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
| Supported widths (phone, laptop, wide) | | | screenshots |
| Full end-to-end run, wall time | | | |
| Slowest test package | 2 s | 1.2 s, worker suite (2026-11-15, dev workstation, Ryzen 9 9950X3D, CPU load ~80%) | review |
| Frontend entry chunk, gzip | 270 kB | 224 kB (2026-11-15, vite build, gzip -6) | review |
| Frontend total JS + CSS, gzip | 460 kB | 381 kB (2026-11-15, vite build, gzip -6) | review |
| Source file size, p90 of this repository (pass bar) | 314 lines | 314 lines over 15 .ts/.tsx/.py files (2026-11-15) | review |
| Wait timeout before a stuck step is recorded and left | 30 min | a setting, not measured | agent |
| Context handoff limit (share of the model's window) | 60% | a setting, not measured | orchestrator |
| Status check interval while several jobs run | 10 min | a setting, not measured | orchestrator |
| Commit subject length | 72 characters | a setting, not measured | commit hook |
| CPU time per Worker invocation, production | | | Workers Logs cpuTime, review |
| Inbound header parse, JS time per message (Bun benchmark) | | | parse benchmark in the merge gate |
| Passkey assertion verification, JS time per login (Bun benchmark) | 3 ms p95 | median 0.19–0.20 ms, p95 0.44–0.70 ms, 3 runs of 200 (2026-11-15, dev workstation, Ryzen 9 9950X3D, Bun 1.4.4, CPU load ~68%) | `bun worker/bench/auth.ts`, review |
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
| worker/AGENTS.md: Background work (if present) |  |  | no background work yet; queue consumers and cron arrive in M3 and M7 |
| worker/AGENTS.md: Operations (if present) |  | `REVIEW.md`, "Checking against the rules" |  |
| worker/AGENTS.md: Admin panel (if present) |  | `REVIEW.md`, "Pass bar" |  |
| worker/AGENTS.md: Performance |  | `REVIEW.md`, "Pass bar" |  |
| worker/AGENTS.md: Verification | `bun run test` | `REVIEW.md`, "Checking against the rules" |  |

## Exceptions

Backend endpoints with no frontend caller:

| Endpoint | Caller | Reason |
| --- | --- | --- |
| GET /api/health | deploy and uptime checks | liveness probe; carries no data |

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
| Commands: Scheduled run on main | no heavy suites exist yet | add when the Playwright suite lands in M4 | 2027-01-31 |
| Commands: Release | no release flow yet | add with the deploy rehearsal in M7 | 2027-03-31 |
| Numbers: Page frame width; readable column width | the shell has no content pages yet | measure once the mail list and settings pages exist (M4) | 2027-01-31 |
| Numbers: Supported widths (phone, laptop, wide) | not chosen | choose with the first screenshots in M4 | 2027-01-31 |
| Numbers: Full end-to-end run, wall time | no end-to-end suite | measure when Playwright lands in M4 | 2027-01-31 |
| Numbers: CPU time per Worker invocation, production | not deployed yet; Workers Free caps it at 10 ms | read cpuTime from Workers Logs after the first deploy | 2027-02-28 |
| Numbers: Inbound header parse, JS time per message (Bun benchmark) | parser not written yet; planned budget 3 ms | add the benchmark with the M3 parser | 2027-01-31 |

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
