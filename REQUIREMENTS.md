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
| Pre-commit | | | | |
| Merge gate | | | | |
| Scheduled run on main | | | | |
| Release | | | | |

## Numbers

Every limit has a measured baseline next to it. Record the date, the host and its load for each
baseline. Leave the limit empty until it has been measured, and list it under "Not yet enforced"
meanwhile.

| Item | Limit | Baseline (date, host, load) | Enforced by |
| --- | --- | --- | --- |
| Type scale (role: size / line height) | | | design system |
| Spacing scale (section, card, inside card, label to field) | | | design system |
| Page frame width; readable column width | | | e2e page-width check |
| Supported widths (phone, laptop, wide) | | | screenshots |
| Full end-to-end run, wall time | | | |
| Slowest test package | | | |
| Frontend entry chunk, gzip | | | |
| Frontend total JS + CSS, gzip | | | |
| Source file size, p90 of this repository (pass bar) | | | review |
| Wait timeout before a stuck step is recorded and left | | a setting, not measured | agent |
| Context handoff limit (share of the model's window) | | a setting, not measured | orchestrator |
| Status check interval while several jobs run | | a setting, not measured | orchestrator |
| Commit subject length | 72 characters | a setting, not measured | commit hook |

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
| AGENTS.md: Change risk | | | |
| AGENTS.md: Workflow | | | |
| AGENTS.md: When unsure | | | |
| AGENTS.md: Waiting | | | |
| AGENTS.md: Reporting | | | |
| AGENTS.md: Code quality | | | |
| AGENTS.md: Impact and edge cases | | | |
| AGENTS.md: Secrets | | | |
| AGENTS.md: Performance baseline | | | |
| AGENTS.md: Tests (if present) | | | |
| AGENTS.md: Merging | | | |
| AGENTS.md: Model usage | | | |
| AGENTS.md: Documentation | | | |
| AGENTS.md: Writing (docs, comments, reports, PR and issue text) | | | |
| AGENTS.md: Commits and pull requests | | | |
| AGENTS.md: Frontend–backend mapping (when both exist) | | | |
| .github/AGENTS.md: Tiers, jobs and gates | | | |
| web/AGENTS.md: Components and modularity | | | |
| web/AGENTS.md: Consistency | | | |
| web/AGENTS.md: Layout, type and loading | | | |
| web/AGENTS.md: i18n (if present) | | | |
| web/AGENTS.md: Usability | | | |
| web/AGENTS.md: Accessibility | | | |
| web/AGENTS.md: Performance | | | |
| worker/AGENTS.md: APIs and modularity | | | |
| worker/AGENTS.md: Compatibility | | | |
| worker/AGENTS.md: Logging | | | |
| worker/AGENTS.md: Security (if present) | | | |
| worker/AGENTS.md#authz | | | |
| worker/AGENTS.md#sensitive-values | | | |
| worker/AGENTS.md: Money and state (if present) | | | |
| worker/AGENTS.md#money-idempotent | | | |
| worker/AGENTS.md#ledger | | | |
| worker/AGENTS.md: Background work (if present) | | | |
| worker/AGENTS.md: Operations (if present) | | | |
| worker/AGENTS.md: Admin panel (if present) | | | |
| worker/AGENTS.md: Performance | | | |
| worker/AGENTS.md: Verification | | | |

## Exceptions

Backend endpoints with no frontend caller:

| Endpoint | Caller | Reason |
| --- | --- | --- |

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
