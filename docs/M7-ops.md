# M7: backups, restore, deployment and the three-language README

Risk class: High. M7 adds the first production deploy, a job that reads every table of production
data, a restore procedure that overwrites a database, and a migration (0015). Read `AGENTS.md`,
`worker/AGENTS.md` ("Operations", "Background work", "Sensitive values"), `.github/AGENTS.md`,
`web/AGENTS.md` (i18n), `REQUIREMENTS.md`, `docs/PLAN.md` (sections 2, 7, 8, 9), `docs/STATE.md`
(every milestone's "Not verified" and "Deferred" lists, and "M7 constraint: backups and
messages_fts" under M3) and `docs/M3-inbound.md` ("The cron trigger") first. This file decides the
M7 design. Record deviations under "Open questions" in `docs/STATE.md`, M7.

Cloudflare facts below were read on 2026-11-17 from the pages listed in "Cloudflare facts checked".
A fact marked "Unverified" was not found in those pages and must be checked before it is relied on.

## Decisions

1. Two backup layers. D1 Time Travel (always on, 7 days on Workers Free) is the first restore
   path. A daily export of D1 to R2, written by the Worker's existing cron, is the second. The
   export covers what Time Travel cannot: a deleted database, damage found after 7 days, and a
   move to another account.
2. The Worker writes the export itself, page by page, with plain `SELECT` statements through the
   D1 binding. It does not call the D1 export REST API. The REST export blocks the database while
   it runs, so `email()` would fail and senders would get bounces; it needs an account API token
   stored as a Worker secret; and it refuses databases with an FTS5 table.
3. The export format is SQL: one `INSERT INTO <table> (<columns>) VALUES (...);` per row, the same
   kind of file `wrangler d1 export` writes and `wrangler d1 execute --file` reads. A restore needs
   no converter. Column names are explicit, so an export loads into a database migrated to the same
   or a later schema.
4. The SQL text is built by D1 (`quote()` and `||` in the `SELECT`), not by JavaScript. The Worker
   joins the returned lines and streams them to R2. JS work per page is bounded by a byte cap.
5. The export never contains a credential. The tables that hold login state, secrets or
   per-device keys are left out (see "What is exported"). A restore from an export therefore resets
   every credential: the owner runs first-run setup again. A Time Travel restore keeps everything.
6. R2 mail objects get no second copy inside the account. R2 is the system of record for raw mail.
   A copy in the same account shares every failure that matters (account loss, a wrong bucket
   delete) and would double storage against the 10 GB free allowance. The off-account copy is the
   owner's periodic sync to their own disk (open question 2).
7. From M7 on, `email()` writes four small custom metadata fields on each raw object (address id,
   envelope sender, envelope recipient, received time). A restore can then rebuild rows for mail
   that arrived after the restore point. This is the "recover what happened after the last backup"
   step that `worker/AGENTS.md`, "Operations", requires.
8. Account-specific values (the D1 database id, the custom domain) never enter the repository.
   The tracked `worker/wrangler.jsonc` stays account-free and serves local development and tests.
   Production deploys use a generated, untracked config built from it plus an untracked
   `worker/deploy.local.jsonc` (see "Production config"). The generator refuses to run unless
   HEAD is merged `main` with a clean tree.
9. Migrations run before the code deploy, not after it. Every migration in this repository is
   additive (`worker/AGENTS.md`, "Compatibility"), so the running code keeps working on the new
   schema, and the window in which new code meets an old schema (the 500s that the README warns
   about today) disappears.
10. The README becomes three files with identical structure and identical code blocks:
    `README.md` (English), `README.zh-CN.md`, `README.ja-JP.md`. They hold what the project is,
    the from-zero deploy and the shortest successful use. The feature reference and the runbook
    move to English-only files under `docs/`. A merge-gate check keeps the three READMEs in sync.
11. The coordinator never holds Cloudflare, Resend or Telegram credentials. The owner runs every
    command that touches the account, after an explicit go for each production step.

## Scope

In scope:

- the export job on the cron, its state table (migration 0015), retention and pruning, its
  alerts, and the owner-side restore script;
- custom metadata on new raw mail objects, and the owner-side tool that rebuilds rows from it;
- the production config generator with the merged-main check, and `deploy:prod` /
  `migrate:prod` scripts;
- the restore runbook, the deployment procedure, the operations runbook;
- the three READMEs and their sync check;
- the first production deploy on the owner's account, run by the owner, and the production
  verification checklist below;
- `REQUIREMENTS.md`: fill "Commands: Release" and "Numbers: CPU time per Worker invocation,
  production"; add the new numbers and the README check.

Not in scope:

- the R2 orphan sweep that `worker/wrangler.jsonc` and `docs/M3-inbound.md` assign to M7 (owner
  ruling 3: deferred, because it would delete objects the post-restore rebuild needs);
- a backup status page in Settings (the alert and the routine check cover it);
- Workers Paid features, the D1 REST export, Workflows, Logpush;
- a second copy of R2 objects inside the account, R2 object versioning;
- any change to how mail is received, parsed, sent or shown, beyond the R2 metadata in decision 7.

## Cloudflare facts checked (2026-11-17)

| Fact | Source |
| --- | --- |
| Time Travel is always on; restore to any minute in the window; 7 days on Workers Free, 30 on Paid; no extra cost | https://developers.cloudflare.com/d1/reference/time-travel/ , https://developers.cloudflare.com/d1/platform/limits/ |
| `wrangler d1 time-travel info <db> [--timestamp=...]` returns a bookmark; `wrangler d1 time-travel restore <db> --timestamp=<unix or RFC3339>` or `--bookmark=...` overwrites the database and cancels in-flight queries; a restore keeps the newer bookmarks, so it can be undone | https://developers.cloudflare.com/d1/reference/time-travel/ |
| At most 10 Time Travel restores per 10 minutes per database | https://developers.cloudflare.com/d1/platform/limits/ |
| D1 Free: 500 MB per database, 5 GB per account, 50 queries per Worker invocation, 2,000,000 bytes per string, BLOB or row, 100,000 bytes per SQL statement | https://developers.cloudflare.com/d1/platform/limits/ |
| `wrangler d1 export` and the REST export do not support virtual tables or databases that contain one (FTS5); a running export blocks other database requests | https://developers.cloudflare.com/d1/best-practices/import-export-data/ |
| The REST export (`POST /accounts/{account_id}/d1/database/{database_id}/export`) needs an API token, must be polled, makes the database "unavailable to serve queries" while it runs, and accepts `dump_options.tables` | https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/ , https://developers.cloudflare.com/workflows/examples/backup-d1/ |
| Workers Free: 10 ms CPU per HTTP request and per Cron Trigger; waiting on D1, R2 or `fetch` does not count; 100,000 requests a day | https://developers.cloudflare.com/workers/platform/limits/ |
| Subrequests include calls to R2, KV and D1; Workers Free: 50 per invocation, and "Subrequests to internal services: 1,000". Which of the two counts binding calls is not stated; this design assumes the stricter 50 | https://developers.cloudflare.com/workers/platform/limits/ |
| Automatic provisioning creates a missing D1, R2 or queue on `wrangler deploy` and writes the new ids back into the config file; for R2 it applies when the binding has no bucket name | https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning |
| R2 free tier per month: 10 GB-month storage, 1 million Class A, 10 million Class B operations | https://developers.cloudflare.com/r2/pricing/ |
| R2 bucket locks: a rule by prefix and retention period stops deletion and overwrite; set with `wrangler r2 bucket lock add`; lock rules win over lifecycle rules. Unverified: whether bucket locks are available on the Free plan | https://developers.cloudflare.com/r2/buckets/bucket-locks/ |
| Queues on Workers Free: 10,000 operations a day, about 3 per delivered message; retention 24 hours, not configurable | https://developers.cloudflare.com/queues/platform/pricing/ |
| Durable Objects on Workers Free: SQLite backend only; 100,000 requests and 13,000 GB-s a day; an object eligible for hibernation is not billed for duration | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| Rate Limiting binding: counts per Cloudflare location, approximate, eventually consistent | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ |
| Workers Logs on Free: 200,000 log events a day, 3 days retention; each invocation writes an invocation log with request and response details; `observability.logs.invocation_logs: false` turns those off; the invocation message of a fetch is `<method> <URL>` | https://developers.cloudflare.com/workers/observability/logs/workers-logs/ |
| `wrangler rollback` and the dashboard roll back to one of the 100 most recent versions; not across a Durable Object class change or to a version whose R2 bucket, KV namespace or queue no longer exists; pages loaded before the rollback can still request the newer version's assets | https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/ |
| Custom Domains: added in the dashboard (Workers & Pages > Worker > Settings > Domains & Routes) or with `routes: [{ "pattern": "...", "custom_domain": true }]` and `wrangler deploy`; Cloudflare creates the DNS record and certificate | https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ |
| Email Routing onboarding (Compute > Email Service > Email Routing > Onboard Domain) adds MX, SPF and DKIM records on the root domain; DMARC is added only by Email Sending onboarding; "Before you can create a routing rule, you must add and verify at least one destination address" | https://developers.cloudflare.com/email-service/configuration/domains/ , https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/ |
| Resend domain records on Cloudflare: MX and SPF TXT on `send`, DKIM TXT on `resend._domainkey`, DNS only (not proxied) | https://resend.com/docs/guides/dns/cloudflare |
| Cloudflare Access self-hosted public application: Zero Trust > Access controls > Applications > Self-hosted and private; needs an active zone. Unverified: the Free plan seat count | https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/ |

Not found in these pages, so treated as unverified: whether deleting a D1 database also deletes its
Time Travel history (assume it does); whether R2 has object versioning (assume it does not);
whether `wrangler secret put` deploys a new version at once; whether `preview_urls` and
`workers_dev: false` are both needed to close every non-custom hostname; whether Workers Logs
invocation logs record request headers.

## Backups

### Failure cases and the layer that covers each

| Failure | Time Travel | R2 export | Off-account copy |
| --- | --- | --- | --- |
| Bad migration, bad `UPDATE`/`DELETE`, bug that corrupts rows, found within 7 days | yes, to the minute | yes, to the last export | yes |
| The same, found after 7 days | no | yes, back to the oldest kept export | yes |
| D1 database deleted | no (unverified, assumed) | yes | yes |
| R2 objects deleted by mistake (a bucket emptied, a wrong prefix) | no | no (exports hold D1 only) | yes, to the last sync |
| Account lost or locked | no | no | yes |

The table drives decision 6: only an off-account copy covers raw mail, and only the owner can hold
the credentials it needs.

### What is exported

An explicit list in code, not a scan of `sqlite_schema`. A test fails when the schema holds a table
that is in neither list, so every later migration has to decide.

Exported (table: why):

- `domains`, `addresses`, `forward_targets`, `address_forwards`, `rules`, `rule_forwards`,
  `settings`: configuration;
- `messages`: every inbound and outbound row, flags included;
- `messages_fts`: read with `SELECT rowid, message_id, subject, sender, body FROM messages_fts` and
  written back as `INSERT INTO messages_fts (rowid, message_id, subject, sender, body)`. The
  search text lives only here (`docs/M3-inbound.md`, "Data"). Rebuilding it by re-parsing costs 3
  queue operations per message against 10,000 a day, so 20,000 messages would take 6 days of the
  whole queue budget; exporting it is cheaper. Its shadow tables (`messages_fts_data`, `_idx`,
  `_content`, `_docsize`, `_config`) are not exported;
- `drafts`, `uploads`: unsent work and the R2 keys of its attachments;
- `send_quota`: the last quota Resend reported;
- `telegram_cards`: maps cards to messages so old buttons keep working after a reconnect;
- `audit_log`: history; its `detail` column holds no secret by rule (`worker/AGENTS.md`,
  "Sensitive values").

Left out (table: why):

- `owner`: holds `totp_secret` in clear, a secret;
- `passkeys`: useless without `owner`; a restore re-registers;
- `sessions`, `auth_challenges` (holds a TOTP secret during setup), `login_attempts`: login state;
  restoring sessions would revive old sign-ins;
- `api_keys`: hashes only, but restoring them would revive keys after what is in effect a
  recovery; a recovery revokes every key today (README, "REST API");
- `push_subscriptions`: each row holds a device's `auth` secret; devices subscribe again;
- `telegram`: the binding must be renewed with Connect on the restored origin anyway;
- `webhook_events`: a 7-day replay guard;
- `d1_migrations`, `sqlite_sequence`, `_cf_*`: written by D1 and migrations on the target.

The Hub Durable Object keeps nothing in storage, so it has nothing to back up.

### Layout in R2

All exports live in the existing bucket `melodymail-mail`, under a prefix the mail code never
writes:

```text
backups/d1/{exportId}/part-{table}-{seq:05}.sql
backups/d1/{exportId}/manifest.json
```

`exportId` is the UTC start time, for example `2026-11-18T0300Z`. A separate bucket was considered
and rejected: it adds a binding and a create step and protects against nothing the same account
does not already share.

`manifest.json` is written last and only when every part is written. It holds: the export id, start
and end times, the latest applied migration name (read from `d1_migrations`), and, per table, the
part keys in order, each part's byte size and R2 MD5 (`R2Object.checksums.md5`, computed by R2, so
the Worker hashes nothing), the number of rows written and the highest rowid exported. An export
without a manifest is incomplete and is never restored.

### Paging within the Free limits

Each cron run (every 15 minutes, `*/15 * * * *`) runs the existing three jobs first and the export
step last. The export step:

1. Starts a new export when the latest export started before today's 03:00 UTC and none is running.
   An export still running at the next day's start is marked failed and replaced.
2. Reads its state row (one query).
3. Writes pages until the run's byte budget or page budget is spent. A page is one query and one
   R2 `put`:

   ```sql
   SELECT rowid AS r, 'INSERT INTO "messages" ("id", ...) VALUES (' || quote("id") || ',' || ... || ');' AS s
   FROM messages WHERE rowid > ?1 ORDER BY rowid LIMIT ?2
   ```

   The page size is capped in bytes with a window sum over `length(s)`, so one page stays under
   512 KB except a single oversized row, which goes alone.
4. Updates the state row after each page (table, last rowid, part sequence, counts). A run killed
   at the CPU limit repeats at most its last page, and the part key is derived from table and
   sequence, so the repeat overwrites the same object.
5. When the last table is done, writes the manifest and marks the export complete.

Budget per run (starting values; the implementation measures and sets them in `REQUIREMENTS.md`):

| Resource | Limit (Free) | Existing jobs | Export step |
| --- | --- | --- | --- |
| D1 queries | 50 | about 6 | 1 state read + 2 per page; at most 8 pages: 17 |
| Subrequests (D1 + R2 counted together, the stricter reading) | 50 | about 8 | 17 D1 + 8 R2 puts + 1 manifest put: 26 |
| CPU | 10 ms | measured in production | 2 MB of SQL text per run at most, until the Bun benchmark and production `cpuTime` say otherwise |

At 2 MB per run and 96 runs a day, an export of up to about 190 MB of SQL finishes in one day. A
larger database finishes in more than one day; the next export then starts the day after it
completes, and the alert in "Failure and alerting" reports the stale export. D1 caps a database at
500 MB on Free.

`performance.now()` does not advance during computation in production, so the Worker cannot
measure its own CPU at run time. The byte budget is the control.

Daily usage at 20,000 messages (an estimate): rows read about 60,000 of 5 million; rows written
under 200 of 100,000; R2 Class A under 100 a day of about 33,000 a day (1 million a month).

The queue was considered for paging (one consumer invocation per page, each with its own 10 ms). It
is rejected: it shares the 10,000 daily operations with inbound mail, and a daily backup does not
need the speed.

### Consistency

Pages are separate queries, possibly in separate runs, so an export is not one snapshot. A row
changed between two pages appears in its old or new state. A child row inserted after its parent
table was exported can reference a parent the export lacks. The restore handles this: it loads
with `PRAGMA defer_foreign_keys = on`, then deletes child rows whose parent is missing, then
requires `PRAGMA foreign_key_check` to return nothing. Unverified: that D1's import path honours
`defer_foreign_keys` in a `--file` import; the local drill checks it.

Tables are exported in parent-before-child order, so the common case (a new message after
`addresses` was exported, for an address that already existed) needs no clean-up.

### Statement length

D1 refuses a statement over 100,000 bytes. A draft body may reach 512 K characters (`TEXT_MAX`,
`worker/src/send/validate.ts`). A row whose `INSERT` would exceed 90,000 bytes is written as an
`INSERT` with the long text values empty, followed by `UPDATE ... SET col = col || '<chunk>'`
statements of at most 64 KB each. The Worker splits only such rows; the rest is D1's text as
returned. Unverified: whether `wrangler d1 execute --file` applies the 100 KB statement limit; the
split is cheap insurance and the local drill tests it.

### Retention and pruning

- Keep the 14 most recent complete exports, plus the export of the first day of each month for 6
  months.
- Remove an incomplete export 2 days after it started.
- Pruning runs once a day after an export completes: one R2 `list` of `backups/d1/` and one `delete`
  of up to 1,000 keys.
- With a bucket lock on `backups/` (open question 4), the lock period must be shorter than the
  shortest retention (14 days), or pruning fails. The prune logs and skips a locked object; it
  does not throw.

Storage estimate: about 20 kept exports times the database's SQL size. At 20,000 messages with up
to 8 KB of search text each, one export is roughly 100 MB (an estimate, measured in the drill),
so about 2 GB of the 10 GB free storage. The routine checks watch it.

### Integrity

- At export: the manifest lists each part's size and R2 MD5; the manifest exists only for a
  complete export.
- At restore: the restore script checks that every part in the manifest exists, has the listed
  size and MD5, and that sequences have no gap; after the import it compares each table's row count
  with the manifest.
- Monthly: the owner restores the latest export into a local D1 (the drill below).

### Secrets

The export holds no secret value: the tables that hold one are left out, the Worker secrets are
never in D1, and no log line of the export names a value (only table names, counts, bytes and the
export id). The R2 export holds mail metadata and the search text, which are mail content; it has
the same protection as the raw mail beside it.

### Mail after the restore point

From M7 on, `env.MAIL.put(key, readable, { customMetadata })` in `email()` stores `addressId`,
`envelopeFrom`, `envelopeTo` and `receivedAt`. Outbound copies (`sent/...` JSON) already carry
their recipients. After a restore to time T, the owner runs the gap tool: it lists `raw/` and
`sent/` objects uploaded after T − 10 minutes, skips keys that already have a row, and writes
`stored` rows for inbound mail; the cron re-enqueues them, 100 per run, and the consumer parses
them. `sent/` copies without a row are only reported, never rebuilt (owner ruling 5): the copy
is written before the Resend call, so its outcome is unknown, and the owner checks Resend's
dashboard. The tool runs on the owner's machine with `wrangler`, prints the SQL, and
the owner applies it. Objects written before M7 have no metadata; they matter only if a restore
point predates the first M7 export, which cannot happen.

### Failure and alerting

- Each failed page logs `backup_export_failed` (level error, with export id, table, sequence) and
  the cron's existing `cron_job_failed`.
- When the newest complete export is older than 48 hours, every run logs `backup_stale` (level
  error) once per day.
- When Telegram is connected, the same two events send one plain message per day to the owner's
  chat (no mail content). This is the alert `worker/AGENTS.md`, "Background work", asks for, and
  it costs nothing extra. Without Telegram, the alert is the log line and the routine check.
- The export never throws past its own step: the other cron jobs and mail handling keep running.

### Data (migration 0015)

`backup_exports`: `id` (export id, text, primary key), `status` (`running`, `complete`, `failed`),
`table_index`, `last_rowid`, `part_seq`, `rows_json` (per-table counts so far), `bytes`,
`started_at`, `finished_at`, `error`. Additive; the export job ignores the table until it exists,
so code and migration order do not matter for it.

## Restore runbook

The runbook text moves to `docs/RUNBOOK.md` in the change; this section is its design. Every
command runs from `worker/` on the owner's machine with the owner's `wrangler login`. `--config
.wrangler-production.jsonc` is written as `$PROD` below (see "Production config").

### Before any restore

1. Decide the restore point (a time, or an export id) from the logs and the audit log.
2. Record the current bookmark, so the restore can be undone:
   `bun run wrangler d1 time-travel info melodymail --config $PROD`.
3. Optional: pause inbound mail by setting the Email Routing catch-all to "Drop" in the dashboard.
   Mail sent meanwhile is refused at the SMTP level, and senders retry. Without the pause, mail that
   arrives during the restore is stored in R2 and recovered by the gap tool.

### A. Time Travel (damage within 7 days, database still exists)

```sh
bun run wrangler d1 time-travel info melodymail --timestamp=2026-11-20T08:00:00Z --config $PROD
bun run wrangler d1 time-travel restore melodymail --timestamp=2026-11-20T08:00:00Z --config $PROD
```

Then run the gap tool from the restore time, and "Verify a restore". To undo, restore to the
bookmark recorded in "Before any restore". Credentials, sessions and push subscriptions come back
as they were at that time.

### B. From an R2 export into a fresh D1

Always into a new database, so the old one stays until the restore is verified.

1. `bun scripts/backup-restore.ts fetch <exportId> <dir>`: downloads the manifest and parts with
   `wrangler r2 object get --remote`, checks sizes, MD5s and sequences, and writes
   `<dir>/restore.sql` (the parts in order, wrapped in `PRAGMA defer_foreign_keys = on`, followed by
   the dangling-row clean-up).
2. `bun run wrangler d1 create melodymail-restore`; put its id into `deploy.local.jsonc` under a
   second name only for the import (or pass it on the command line).
3. Check out the commit whose last migration is the manifest's migration, or a later one, and apply
   migrations to the new database:
   `bun run wrangler d1 migrations apply melodymail-restore --remote --config $PROD`.
4. `bun run wrangler d1 execute melodymail-restore --remote --file <dir>/restore.sql --config $PROD`.
5. `bun scripts/backup-restore.ts verify <dir> melodymail-restore`: row counts against the manifest,
   `PRAGMA foreign_key_check` empty, a sample of 20 `r2_key` values present in R2.
6. Switch `database_id` in `deploy.local.jsonc` to the new database and run `bun run deploy:prod`.
7. Put a new `SETUP_TOKEN` and run `/setup` (decision 5). Connect Telegram again, turn on push on
   each device, create API keys again.
8. Run the gap tool from the export's start time.
9. Keep the old database until the owner has used the restored one for a week; then delete it.

### C. Disaster recovery onto a new account

Needs the off-account copy (raw mail and exports). Without it, only what the owner synced survives.

1. Deploy from zero on the new account ("From a blank account"), up to and including migrations,
   but do not run `/setup` yet.
2. Upload the R2 copy into the new `melodymail-mail` bucket, keys unchanged (`rclone copy` with the
   new account's R2 S3 credentials, or Super Slurper when the old bucket is still reachable).
3. Restore the latest export as in B, steps 1, 4 and 5, into the new database.
4. Continue the deploy: secrets, Email Routing, DNS, `/setup`. If the domain moved too, Passkeys
   bound to the old host do not work; setup registers a new one.

No secret value has to survive the disaster: every Worker secret can be issued again (a new
`SETUP_TOKEN`, a new VAPID pair, a new Resend API key and webhook secret, a new `UPLOAD_URL_KEY`,
the bot token from BotFather). What must survive is access to the Cloudflare, Resend and domain
registrar accounts, and the off-account copy.

### Verify a restore

- `bun scripts/backup-restore.ts verify` passes (counts, foreign keys, R2 sample).
- Sign in; the Inbox shows the newest message from before the restore point; search finds a word
  from a message body; opening a message renders it (the raw object is reachable).
- `GET /api/health` answers `{ "ok": true }`.
- Send a test mail from an outside account; it arrives and is parsed within a minute.

### Local drill (run before the first deploy, then monthly)

1. `bun run --cwd worker dev --test-scheduled`, then `bun scripts/seed-mail.ts`.
2. Trigger the cron until the export completes: `curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"`.
   Unverified: the `--test-scheduled` route under the installed wrangler 4.162.
3. `bun scripts/backup-restore.ts fetch <exportId> <dir> --local`, then apply migrations and
   `restore.sql` to a second local database (`--persist-to <dir>/drill-state`), then `verify`.
4. Record the run in `docs/STATE.md`: export id, sizes, counts, time taken.

After the first deploy, the monthly drill uses the newest production export with `--remote` for
the download and `--local` for the import, so production is never written.

### Key material and where it lives

- Recovery key and TOTP seed: the owner's password manager or paper, never the repository.
- `deploy.local.jsonc`: the owner's machine; it holds ids, not secrets.
- Worker secret values: may be kept in the owner's password manager; none is needed to recover
  (see C). `wrangler secret list` shows names only.
- The R2 API token for the off-account sync: the owner's machine only, read-only, scoped to the
  bucket.

## Deployment

### Production config

`worker/wrangler.jsonc` stays as it is: no `database_id`, no routes, usable by `wrangler dev` and
the tests. Production uses:

- `worker/deploy.local.jsonc` (untracked, added to `.gitignore`; a tracked
  `worker/deploy.example.jsonc` shows its shape): `database_id`, the custom domain, and
  `workers_dev: false`.
- `worker/scripts/prod-config.ts`: refuses unless the branch is `main`, the tree is clean and HEAD
  equals `origin/main` (`worker/AGENTS.md`, "Operations": no override may reach production); then
  writes `worker/.wrangler-production.jsonc` (untracked) as `wrangler.jsonc` merged with
  `deploy.local.jsonc`. It writes beside `wrangler.jsonc`, so relative paths (`main`,
  `assets.directory`, `migrations_dir`) stay valid.
- Scripts in `worker/package.json`: `migrate:prod` (generate, then `wrangler d1 migrations apply
  melodymail --remote --config .wrangler-production.jsonc`) and `deploy:prod` (generate, build the
  web app, `wrangler deploy --config .wrangler-production.jsonc`). The existing `deploy` and
  `db:migrate:remote` stay for anyone who deploys without the generator, and the README names
  `deploy:prod`.

Why not rely on automatic provisioning: it writes ids back into the tracked file, and a later
deploy from a clean checkout without the id could provision a second, empty database. Explicit
`create` commands and an explicit id remove that risk. Why not commit the ids: the README is a
from-zero procedure for any account, and another account's id in the tracked file breaks it.

### From a blank account

The owner runs each step. Prerequisites: a domain on Cloudflare DNS (zone active), Bun 1.4.4,
Node.js for wrangler, git, a Resend account if sending is wanted, Telegram if cards are wanted.

Choose the final hostname first, for example `mail.example.com`. Passkeys are bound to the host
the page is opened on (`worker/src/auth/webauthn.ts`, RP ID from the request URL), so a Passkey
registered on `*.workers.dev` does not work on the custom domain.

1. Install and check:

   ```sh
   git clone https://github.com/JohnsonRan/MelodyMail.git && cd MelodyMail
   bun install --frozen-lockfile
   bun run check
   ```

2. Sign in to Cloudflare (opens a browser), from `worker/`:

   ```sh
   bun run wrangler login
   bun run wrangler whoami
   ```

   With several accounts, set `CLOUDFLARE_ACCOUNT_ID` in the shell for the following steps.

3. Create the resources:

   ```sh
   bun run wrangler d1 create melodymail
   bun run wrangler r2 bucket create melodymail-mail
   bun run wrangler queues create melodymail-inbound
   ```

   `d1 create` prints the `database_id`. The Durable Object `Hub` is created by the deploy (its
   `migrations` entry). The rate limiters need nothing created: their `namespace_id` values are
   chosen in `wrangler.jsonc`. Unverified: whether `d1 create` offers to edit the config; answer no.

4. Write `worker/deploy.local.jsonc` from `worker/deploy.example.jsonc`: the `database_id`, the
   custom domain route (`{ "pattern": "mail.example.com", "custom_domain": true }`) and
   `"workers_dev": false`.

5. Apply the migrations, then deploy:

   ```sh
   bun run migrate:prod
   bun run deploy:prod
   ```

   Check: `curl https://mail.example.com/api/health` answers `{"ok":true}`.

6. Set the setup token (at least 32 characters):

   ```sh
   openssl rand -base64 32
   bun run wrangler secret put SETUP_TOKEN --config .wrangler-production.jsonc
   ```

7. Email Routing: in the dashboard, Compute > Email Service > Email Routing > Onboard Domain, and
   accept the MX, SPF and DKIM records it adds. Add and verify one destination address if the
   dashboard asks for it before a rule (the docs say a routing rule needs one). Then set the
   catch-all to "Send to a Worker", `melodymail`.

8. DMARC: add `TXT _dmarc "v=DMARC1; p=none; rua=mailto:<an address you read>"`. Email Routing
   does not add it. Move to `p=quarantine` once the reports show only expected senders.

9. First-run setup: open `https://mail.example.com/setup`, enter the token, register a Passkey,
   and store the recovery key and the TOTP seed outside the computer. Then
   `bun run wrangler secret delete SETUP_TOKEN --config .wrangler-production.jsonc` (setup refuses
   after the first run anyway; deleting it removes a value nobody needs).

10. In Settings > Domains, add the domain and run "Check DNS"; in Settings > Addresses, add an
    address. Send a mail to it from an outside account. It appears in the Inbox. This is the
    shortest successful use.

Optional features, each switched on by its secrets (names from `worker/src/global-props.d.ts`):

| Feature | Secrets | Other steps |
| --- | --- | --- |
| Sending | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `UPLOAD_URL_KEY` (`bun run upload-key`) | Resend: add the domain and its records (`send` MX and SPF TXT, `resend._domainkey` TXT, DNS only), tracking off; API key with sending access; webhook to `https://<host>/api/webhooks/resend` with the seven `email.*` events; Settings > Domains: turn on sending |
| Web Push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (`bun run vapid`), `VAPID_SUBJECT` (`https://<host>`) | Settings > Notifications on each device |
| Telegram | `TELEGRAM_BOT_TOKEN` (from BotFather) | Settings > Notifications > Connect Telegram on the deployed host |
| Cloudflare Access | none | see below |

`VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` are not secret; they are set as secrets today because the
README says so and changing that is not in scope. Vars that stay in `wrangler.jsonc`: `DOH_URL`,
`RESEND_API_URL`, `RESEND_DAILY_LIMIT`, `RESEND_MONTHLY_LIMIT`, `TELEGRAM_API_URL`.

Backups after the first deploy: the first export runs at the first cron run after 03:00 UTC.
Check it the next day ("Routine checks"). Then set the bucket lock if open question 4 is accepted:
`bun run wrangler r2 bucket lock add melodymail-mail ...` with prefix `backups/` and the agreed
age. Then set up the off-account sync (open question 2).

Cloudflare Access (optional, PLAN section 8): one self-hosted application on the custom domain
with an Allow policy for the owner's identity, and Bypass applications for the paths that outside
callers use: `/api/webhooks/*` (Resend, Telegram), `/api/uploads/*` (signed attachment URLs),
`/api/v1/*` (API key clients), `/api/health`. Unverified: how the service worker, the WebSocket
(`/api/events`) and push notification clicks behave when the Access session expires; test before
relying on it. Access is not part of the acceptance run.

### Updates and redeploys

1. `git pull` on `main`; `bun install --frozen-lockfile`; `bun run check`.
2. Record the bookmark: `bun run wrangler d1 time-travel info melodymail --config .wrangler-production.jsonc`.
3. `bun run migrate:prod` (nothing to do when there is no new migration).
4. `bun run deploy:prod`.
5. `curl https://<host>/api/health`; open the app; open pages show "A new version is available".

### Rollback and forward-only migrations

- Code: `bun run wrangler rollback --config .wrangler-production.jsonc` (or to a named version from
  `wrangler deployments list`). It changes the code and assets, not D1.
- Migrations only move forward. There is no down migration, and a rollback never undoes a schema
  change. This is safe because migrations are additive: the older code ignores new tables and
  columns. A migration that older code cannot run against must say so in its pull request and be
  split into an additive step and a later clean-up step.
- When a migration damaged data, restore with Time Travel to the bookmark from "Updates and
  redeploys", step 2, then run the gap tool from that time.
- A rollback across the Hub's Durable Object migration entry is refused by Cloudflare. No M7
  change touches that entry.

## Observability and operations

### Logs

- Workers Logs (`observability.enabled: true` is already set): dashboard > Workers & Pages >
  `melodymail` > Observability; 3 days of retention and 200,000 events a day on Free.
- Live: `bun run wrangler tail --config .wrangler-production.jsonc --format json`.
- Events that need action: `unhandled`, `cron_job_failed`, `backup_export_failed`, `backup_stale`,
  `rules_load_failed`, `rules_eval_failed`, `mail_store_failed`, `mail_audit_failed`,
  `mail_forward_record_failed` (errors); `mail_parse_gave_up`, `mail_raw_missing`,
  `mail_forward_failed`, `mail_enqueue_failed`, `send_failed`, `push_failed`,
  `telegram_call_failed` (warnings worth a look when they repeat).
- `cpuTime` per invocation comes from the invocation logs. Unverified: the exact field name.

### Quotas to watch on Free

| Resource | Free limit | Where to read it | MelodyMail's main user |
| --- | --- | --- | --- |
| Worker requests | 100,000 a day | Worker > Metrics | the app, the API, webhooks |
| Worker CPU | 10 ms per invocation | invocation logs | `email()`, the consumer, the cron, the webhooks |
| D1 rows read / written | 5 million / 100,000 a day | D1 > Metrics, `wrangler d1 info` | mailbox lists, the export |
| D1 storage | 500 MB per database | `wrangler d1 info` | `messages`, `messages_fts` |
| R2 storage, Class A, Class B | 10 GB-month, 1 million, 10 million a month | R2 > bucket > Metrics | raw mail, exports |
| Queues operations | 10,000 a day | Queues > `melodymail-inbound` | about 3 per inbound message |
| Durable Objects | 100,000 requests, 13,000 GB-s a day | Durable Objects > Metrics | the Hub |
| Workers Logs | 200,000 events a day | Observability | every invocation log and log line |
| Resend | 100 a day, 3,000 a month | compose, Resend dashboard | sending |

Over a Free limit, the operation fails; nothing is charged (PLAN section 2).

### Alerting that stays free

- The Worker's own Telegram message for backup failure or staleness (when connected).
- An external uptime check on `https://<host>/api/health` from a free monitoring service of the
  owner's choice (the endpoint carries no data).
- Unverified: which Cloudflare Notifications are available on the Free plan for Workers errors; not
  relied on.

### Routine checks

Weekly (10 minutes):

1. `bun run wrangler r2 object get melodymail-mail/backups/d1/<latest>/manifest.json --remote --pipe`
   (or the dashboard): an export from the last 24 hours is complete.
2. Workers Logs: filter level error for the past 3 days; every event has a cause.
3. D1 and R2 storage against their limits.

Monthly: the local drill with the newest production export; the off-account sync; Resend domain
status.

## Production verification checklist

Every item below was left "Not verified" in `docs/STATE.md` because it needs a deployment. The owner
runs them in this order after the from-zero deploy; the coordinator records each result in
`docs/STATE.md`, M7. "Expected" is the pass condition.

1. Deploy check (M3): `wrangler deploy` with the explicit resources succeeds; `/api/health` answers.
   Expected: 200 `{"ok":true}`.
2. Setup and sign-in on the custom domain with a real Passkey (M1). Expected: setup once, then 409
   `already_initialized`; sign-in works.
3. `cf-connecting-ip` and `request.cf` (M1 rulings): Settings > Security lists the session with the
   owner's IP and city. Expected: not "this device or local network".
4. Rate limiter on Free (M1, M6): 12 failed recovery attempts within a minute from one IP. Expected:
   429 within the first dozen (approximate, per location); `API_LIMITER` checked the same way with
   130 requests to `/api/v1/messages` with an invalid key. Then clear `login_attempts` (README).
5. Real Email Routing delivery (M3, M4): mail from an outside account to an added address. Expected:
   stored, parsed within a minute, shown in the Inbox, live update on an open page.
6. Refusal (M3): mail to an address not added. Expected: the sender gets a bounce; no R2 object.
7. Forwarding (M2, M3, M6): forward to a verified destination, including one verified in mixed
   case against the lowercase target; a rule with a forward action; a forward-only address.
   Expected: each target receives one copy with `X-MelodyMail-Forwarded: 1`; forward-only keeps no
   R2 object; whether `forward()` counts as a subrequest shows in the invocation log.
8. Production `cpuTime` (M1, M3, M5, M5b, M6, M7): read from invocation logs for `email()` with 50
   rules, the consumer, the cron run with an export, the Resend webhook, the Telegram webhook, a
   send, a v1 request, a passkey sign-in. Expected: every one under 10 ms; record the highest in
   `REQUIREMENTS.md`, "Numbers: CPU time per Worker invocation, production".
9. Queue retry and 24-hour retention (M3): not forced in production; the cron's re-enqueue covers
   it. Expected: no message stays `stored` longer than 30 minutes in a week of use.
10. Sending through Resend from the deployed origin (M5): a send with an attachment. Expected:
    Resend fetches the signed URL (`GET /api/uploads/:id/blob` in the logs, 200); the recipient
    receives the attachment; the webhook moves the row to "Delivered". The quota shown matches
    Resend's dashboard (M4 deferred item: may read one low).
11. Resend webhook signature (M5): the Resend dashboard's "send test event" or a real event.
    Expected: 200 and a `webhook_events` row. A wrongly signed request cannot be produced from the
    dashboard; that case stays covered by the tests only, and is recorded so.
12. Web Push on real browsers (M4b): stable Chrome (`fcm.googleapis.com`), Firefox, Safari on macOS,
    iOS from the Home Screen. Expected: the test notification and a new-mail notification arrive;
    clicking opens the message.
13. Telegram on the deployed origin (M5b): Connect, a new mail card, each button. Expected: the
    card arrives as a plain message (widgets are refused today); every button changes the message
    and answers the tap.
14. Hub hibernation (M4, M5c): leave one page open and idle for an hour. Expected: Durable Objects
    duration in the dashboard stays near zero for that hour; a new mail still updates the page.
15. Quiet while open (M5c): switch on, keep a page in the foreground, send a mail. Expected: no push,
    no Telegram; the in-page notice shows. Put the page in the background for 75 seconds. Expected:
    push and Telegram resume.
16. Logs and secrets (M6): create a temporary API key, call `/api/v1/messages` with it, then search
    Workers Logs and `wrangler tail --format json` for the key's prefix. Expected: the
    `Authorization` header does not appear. If it does: set
    `observability.logs.invocation_logs: false` (this also removes the invocation logs that carry
    `cpuTime`, so do item 8 first), and revoke the key either way. Also note whether the signed
    attachment URL's `sig` appears in the invocation message (`GET <URL>`); it is valid for 24
    hours. Record the finding; a fix is a separate change.
17. The first production export (M7): the next day, the manifest exists, sizes and MD5s match, and
    the monthly drill restores it locally.
18. PWA install on the custom domain (M4b): Chrome or Edge offers Install; offline shows the shell.

Items not covered by a deployment and left as they are: Firefox and Safari rendering of the reader,
screen reader checks, WCAG contrast measurements, CJK fonts on macOS, iOS and Android.

## README in three languages

Structure of each file, in this order (`AGENTS.md`, "Writing", README):

1. What MelodyMail is (two sentences) and a line linking the other two languages.
2. Requirements (Cloudflare account and zone, Bun, Node.js for wrangler; Resend and Telegram
   optional).
3. Deploy (the "From a blank account" steps, with the optional-features table).
4. First use (setup, add a domain and an address, receive the first mail).
5. Update and roll back (short; links to `docs/RUNBOOK.md`).
6. Backups (one paragraph; links to `docs/RUNBOOK.md`).
7. Develop locally (`bun run check`, `wrangler dev`, `localhost` not `127.0.0.1`).
8. More (links to `docs/REFERENCE.md`, the OpenAPI document and the runbook).

The current README's feature sections (Rules, Mailbox, Notifications, Telegram, Sending, REST API,
lockout clearing) move unchanged in substance to `docs/REFERENCE.md` (English, reference type).
The per-migration "apply migration 00xx after deploying this version" paragraphs are dropped: the
update procedure applies every migration first. The runbook (restore, rollback, routine checks)
goes to `docs/RUNBOOK.md` (English, how-to type). Only the three READMEs are translated.

Translation rules: zh-CN in Simplified Chinese only, ja-JP in Japanese, both following the
repository's Chinese rules and the Microsoft localization style guides
(https://learn.microsoft.com/zh-cn/globalization/reference/microsoft-style-guides); terms for
dashboard items stay in English where the Cloudflare dashboard has no localized label (unverified
which labels it localizes; the English label is always given).

Sync check: `scripts/check-readme.ts`, run by `bun run check`. It fails (exit 1) when:

- the three files differ in the sequence of heading levels;
- their fenced code blocks differ in count or in content (commands are never translated; code
  blocks hold no prose comments);
- their link targets differ in count or order;
- a file is missing or empty (exit 2 when it cannot read them).

It has a test with a planted violation for each case (`scripts/check-readme.test.ts`, in
`bun run test:scripts`). A row "AGENTS.md: Documentation" in "Enforcement" gains the gate command.

## Acceptance: the from-zero deploy

PLAN's acceptance for M7: deploy from zero on a blank Cloudflare account following the README.

- Who: the owner runs every command and every dashboard step, on an account and zone of the
  owner's choice (a blank account, or the production account before anything is created). The
  coordinator prepares the merged `main`, reads the README aloud step by step if asked, and records
  results. The coordinator never holds credentials and never runs `wrangler` against the account.
- Go: the owner's explicit go before step 5 (migrations and deploy), before step 7 (Email Routing,
  which changes the zone's MX), and before any restore.
- Rule: the owner follows the README as written. Every deviation (a step that failed, was unclear,
  or needed an extra command) is recorded, and the README is fixed in a follow-up pull request
  before M7 closes.
- Recorded in `docs/STATE.md`, M7: date, wrangler version, each step's result, the time each took,
  every deviation, the production verification checklist results, the first export's manifest
  summary (sizes and counts, never content), and the measured production `cpuTime` values. Account
  ids, hostnames and secrets are not recorded.

## Proof the change needs (High risk)

- Worker tests in workerd with real D1 and R2 (vitest pool, as the existing suites):
  - an export over several simulated cron runs completes and writes a manifest with the right
    counts, sizes and MD5s;
  - round trip: seed every exported table (including CJK search text, a 512 K draft, NULLs,
    integers above 2^31), export, load the parts into a second D1 binding migrated from scratch,
    compare every exported table row for row; the left-out tables are absent from every part;
  - a page killed mid-run (simulated by throwing after the R2 `put`) repeats without duplicate rows;
  - the schema-coverage test: a table in neither list fails;
  - no part contains a value from `owner.totp_secret`, `push_subscriptions.auth` or a session
    hash (search the parts for planted values);
  - pruning keeps the 14 newest, the month-firsts for 6 months, removes incomplete exports after 2
    days, and survives a locked object;
  - a failing export does not stop the other cron jobs; `backup_stale` fires after 48 hours;
  - `email()` writes the four metadata fields;
  - the gap tool's SQL rebuilds `stored` rows that the consumer then parses.
- Ablation of every behaviour hunk (High risk).
- Bun benchmark `worker/bench/backup.ts`: the Worker-side JS per page (join, oversized-row split,
  manifest) for a 512 KB page and for a page with one 512 K-character draft; it exits 1 over its
  limit. Proposed limit: 1 ms p95 per page, so 4 pages plus the other jobs stay under 10 ms with the
  3 times production margin PLAN uses. The run budget in "Paging" is set from it.
- The local restore drill, run once by the coordinator before review and recorded.
- Production `cpuTime` of a cron run with an export (checklist item 8).
- The README check shown red on each planted violation.
- `bun run check` green; timings recorded against the 18 s merge-gate limit.
- An independent review by a different model family; when only one family is available, the owner
  reviews (`AGENTS.md`, "Model usage").

## REQUIREMENTS.md changes

- "Commands: Release": the owner-run release command, `bun run release`: `bun run check`, the
  scheduled suites, then the local drill on the newest production export with migrations applied
  to the restored copy (".github/AGENTS.md": migrations on a copy of production data, a deploy
  rehearsal). Its baseline is measured at the first run.
- "Numbers": export JS per page (Bun benchmark), export bytes per run, the export's daily size;
  "CPU time per Worker invocation, production" filled from checklist item 8.
- "Enforcement": the README check as the gate for "AGENTS.md: Documentation".
- "Not yet enforced": remove the two rows M7 fills.

## Owner rulings (2026-11-17)

1. The R2 export carries no credential; a restore from it means running `/setup` again. Time
   Travel restores keep every credential (open question 1, accepted).
2. Off-account copy: a monthly `rclone sync` of the bucket to the owner's own disk with a
   read-only R2 token, run by the owner; `docs/RUNBOOK.md` gives the steps (open question 2).
3. Automatic Trash clean-up is in M7 scope; the R2 orphan sweep stays deferred.
   - A message in Trash for 30 days is deleted permanently by the existing cron, through the same
     path as the owner's manual permanent delete (M4: the R2 object, the row and the FTS row).
   - It runs in bounded batches per cron run within the Workers Free limits, and logs a count.
   - The Trash folder says that mail is deleted after 30 days, in three locales.
   - The clock starts when the message entered Trash. If the schema has no such time, a column is
     added in the M7 migration and set when a message is moved to Trash; messages already in
     Trash at deploy time count from the deploy.
   - Deleted mail is still recoverable by Time Travel for 7 days (D1 rows only; the R2 object is
     gone), which the runbook states.
4. A 7-day bucket lock on the `backups/` prefix if the Free plan allows it; never on `raw/`. If
   it is not available on Free, record that and go on without it.

5. Mail sent after the restore point is listed in the gap tool's report, not rebuilt (asked
   2026-11-17 during phase A review). Writing each send's outcome to R2 is a later option.

## Open questions for the owner (asked 2026-11-17, answered above)

1. Credential reset on an export restore. The export leaves out `owner`, `passkeys`, sessions, API
   keys, push subscriptions and the Telegram binding, so a restore from R2 means running `/setup`
   again and reconnecting. The alternative is to encrypt those tables with a key held only as a
   Worker secret and on paper, which adds key handling to every restore. Recommended: accept the
   reset; Time Travel, the common path, keeps every credential.
2. Off-account copy. Only a copy outside Cloudflare survives account loss or a wrong bucket delete.
   Recommended: the owner syncs `melodymail-mail` (raw mail and exports) to their own disk monthly
   with `rclone sync` and a read-only R2 API token kept on that machine; the runbook gives the
   commands. The alternative is accepting that risk.
3. R2 orphan sweep and automatic Trash clean-up. `worker/wrangler.jsonc` and `docs/M3-inbound.md`
   say M7 adds them; PLAN's M7 row does not. The sweep would delete raw objects that the gap tool
   needs after a restore, and automatic Trash removal deletes mail, a behaviour change of its own.
   Recommended: defer both to after release, record them in the deferred list, and fix the two
   comments that promise them.
4. Bucket lock on `backups/`. A lock stops a buggy or compromised Worker from deleting recent
   exports. Recommended: a 7-day lock on `backups/` if the Free plan offers bucket locks (unverified),
   with the prune skipping locked objects. Not on `raw/`: permanent delete and forward-only
   addresses must be able to remove mail.

## Not verified in this design

- Every item marked "Unverified" above: Time Travel after a database delete; R2 versioning;
  bucket locks on Free; `wrangler secret put` deploying at once; `preview_urls`; the invocation
  log's header contents and `cpuTime` field name; `--test-scheduled`; `defer_foreign_keys` and the
  100 KB statement limit in `wrangler d1 execute --file`; Cloudflare Notifications on Free; Access
  seats on Free and its effect on the service worker and WebSocket; whether a routing rule to a
  Worker needs a verified destination address first.
- The export's CPU per page and its daily size: estimates until the benchmark and the drill run.
- Whether D1 and R2 binding calls count against the 50-subrequest limit or the 1,000 internal one;
  the budget assumes 50.
- No Cloudflare account, API or dashboard was used for this design; only documentation pages were
  read.
