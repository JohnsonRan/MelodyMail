# MelodyMail runbook

How to deploy, update, back up, restore and watch a MelodyMail production Worker on the Workers
Free plan. The feature reference is in `docs/REFERENCE.md`.

Every command runs from the `worker/` directory unless a step says otherwise. Commands that touch
the Cloudflare account need `bun run wrangler login` first. Each such command is a production step:
read it before you run it.

## Production config

The tracked `worker/wrangler.jsonc` holds no account values. Production commands use a generated,
untracked file, `worker/.wrangler-production.jsonc`: `wrangler.jsonc` merged with the untracked
`worker/deploy.local.jsonc` (database id, custom domain route, `workers_dev: false`).

```sh
bun run prod-config
```

- `bun run prod-config` writes `.wrangler-production.jsonc`. `migrate:prod` and `deploy:prod` run it
  first.
- It refuses (exit 1) unless git runs, the branch is `main`, the working tree is clean and HEAD
  equals the local `origin/main`. Run `git pull` first; it fetches nothing itself.
- It refuses (exit 1) a `deploy.local.jsonc` with an unknown key, a malformed `database_id`, no
  route, or `workers_dev` on. It exits 2 when `deploy.local.jsonc` is missing.
- `bun run deploy` and `bun run db:migrate:remote` refuse with exit 1. Use `deploy:prod` and
  `migrate:prod`.

Keep every scratch file (downloaded exports, gap SQL, drill state) outside the repository. A file
inside it makes the tree unclean, and `prod-config` then refuses.

## Deploy from a blank account

Prerequisites: a domain whose DNS is on Cloudflare (zone active), Bun 1.4.4, Node.js (wrangler
runs on Node), git. Resend and Telegram are optional.

### 1. Choose the hostname

Choose the final hostname before anything else, for example `mail.example.com`. Passkeys are bound
to the host the page is opened on (the relying party ID is the request's host). A Passkey
registered on another host, such as `*.workers.dev`, does not work on the final one. Moving later
means running setup again on the new host.

### 2. Install and check

From any directory:

```sh
git clone https://github.com/JohnsonRan/MelodyMail.git
cd MelodyMail
bun install --frozen-lockfile
bun run check
```

`bun run check` must pass.

### 3. Sign in to Cloudflare

From `worker/`:

```sh
bun run wrangler login
bun run wrangler whoami
```

`login` opens a browser. With several accounts, set `CLOUDFLARE_ACCOUNT_ID` in the shell for the
following steps, or add `"account_id"` to `deploy.local.jsonc` in step 5.

### 4. Create the resources

```sh
bun run wrangler d1 create melodymail --no-update-config
bun run wrangler r2 bucket create melodymail-mail --no-update-config
bun run wrangler queues create melodymail-inbound
```

- `d1 create` prints the `database_id`. Keep it for step 5.
- `--no-update-config` stops wrangler from writing the new resource into the tracked
  `wrangler.jsonc`. Without it wrangler asks; answer no.
- The `Hub` Durable Object is created by the first deploy. The rate limiters need nothing created.

### 5. Write deploy.local.jsonc

```sh
cp deploy.example.jsonc deploy.local.jsonc
```

Edit `worker/deploy.local.jsonc`:

- `database_id`: the id from step 4;
- `routes`: `[{ "pattern": "mail.example.com", "custom_domain": true }]` with your hostname;
- `workers_dev`: `false`.

The file holds ids, not secrets. Git ignores it.

### 6. Apply the migrations and deploy

```sh
git pull
bun run migrate:prod
bun run deploy:prod
curl https://mail.example.com/api/health
```

- Migrations always run before the code deploy. Every migration is additive, so the running code
  keeps working on the new schema.
- `migrate:prod` asks for confirmation before it applies migrations.
- `deploy:prod` builds the web app and deploys. Cloudflare creates the custom domain's DNS record
  and certificate.
- Expected: `curl` prints `{"ok":true}`.

### 7. Set the setup token

```sh
openssl rand -base64 32
bun run wrangler secret put SETUP_TOKEN --config .wrangler-production.jsonc
```

Paste the generated value when wrangler asks. Setup refuses a token shorter than 32 characters.

### 8. Turn on Email Routing

In the Cloudflare dashboard (labels as read on 2026-11-17):

1. Open Compute > Email Service > Email Routing > Onboard Domain and choose the domain.
2. Accept the MX, SPF and DKIM records it adds on the root domain.
3. If the dashboard asks for a destination address before a routing rule, add and verify one.
4. Open Routing rules and set the catch-all address to "Send to a Worker", `melodymail`.

Unverified: whether a rule that sends to a Worker needs a verified destination address first.

### 9. Add DMARC

Email Routing does not add DMARC. Add one TXT record on the root domain in the zone's DNS:

| Type | Name | Content |
| --- | --- | --- |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:<an address you read>` |

Move to `p=quarantine` once the reports show only expected senders.

### 10. Run first-run setup

1. Open `https://mail.example.com/setup`.
2. Enter the setup token, create a Passkey, scan the TOTP seed into an authenticator app, and store
   the recovery key. Keep the recovery key and the TOTP seed outside the computer (a password
   manager or paper).
3. Delete the token. Setup refuses after the first run anyway.

```sh
bun run wrangler secret delete SETUP_TOKEN --config .wrangler-production.jsonc
```

### 11. Receive the first mail

1. Settings > Domains: add the domain, open it and choose "Check DNS". Every Email Routing record
   shows as found.
2. Settings > Addresses: add an address, for example `you@example.com`.
3. Send a mail to it from an outside account. It appears in the Inbox within a minute.

## Optional features

Each feature switches on when its secrets exist. Set every secret with
`bun run wrangler secret put <NAME> --config .wrangler-production.jsonc`. Unverified: whether
`secret put` deploys a new version at once; when a feature stays off, run `bun run deploy:prod`.

### Secrets

| Secret | Feature | How to get the value |
| --- | --- | --- |
| `SETUP_TOKEN` | first-run setup | `openssl rand -base64 32`; delete after setup |
| `RESEND_API_KEY` | sending | Resend API key with sending access |
| `RESEND_WEBHOOK_SECRET` | delivery status | the Resend webhook's signing secret (`whsec_...`) |
| `UPLOAD_URL_KEY` | attachments | `bun run upload-key` |
| `VAPID_PUBLIC_KEY` | Web Push | `bun run vapid` |
| `VAPID_PRIVATE_KEY` | Web Push | `bun run vapid` |
| `VAPID_SUBJECT` | Web Push | `https://mail.example.com` (your origin) |
| `TELEGRAM_BOT_TOKEN` | Telegram cards | BotFather |

`VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` are not secret. They are set as secrets because the Worker
reads them that way. The vars in `wrangler.jsonc` (`DOH_URL`, `RESEND_API_URL`,
`RESEND_DAILY_LIMIT`, `RESEND_MONTHLY_LIMIT`, `TELEGRAM_API_URL`) need no change on the Resend Free
plan.

### Sending through Resend

1. In Resend, add the domain (Domains > Add domain). Add the records it shows in Cloudflare DNS:
   MX and SPF TXT on `send`, DKIM TXT on `resend._domainkey`, each DNS only (not proxied).
2. In the domain's settings, turn open and click tracking off.
3. Create an API key with sending access.
4. Add a webhook (Webhooks > Add endpoint) for `https://mail.example.com/api/webhooks/resend` with
   the events `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`,
   `email.complained`, `email.failed` and `email.suppressed`. Copy its signing secret.
5. Set the secrets:

```sh
bun run wrangler secret put RESEND_API_KEY --config .wrangler-production.jsonc
bun run wrangler secret put RESEND_WEBHOOK_SECRET --config .wrangler-production.jsonc
bun run upload-key
bun run wrangler secret put UPLOAD_URL_KEY --config .wrangler-production.jsonc
```

6. In Settings > Domains, turn on sending for the domain.

### Web Push

```sh
bun run vapid
bun run wrangler secret put VAPID_PUBLIC_KEY --config .wrangler-production.jsonc
bun run wrangler secret put VAPID_PRIVATE_KEY --config .wrangler-production.jsonc
bun run wrangler secret put VAPID_SUBJECT --config .wrangler-production.jsonc
```

Then turn on notifications in Settings > Notifications on each device. A new key pair ends every
subscription; `docs/REFERENCE.md`, "Notifications", has the clean-up command.

### Telegram

1. In Telegram, send `/newbot` to @BotFather and follow the steps. Copy the token.
2. Set the token:

```sh
bun run wrangler secret put TELEGRAM_BOT_TOKEN --config .wrangler-production.jsonc
```

3. On the deployed host, open Settings > Notifications and choose Connect Telegram.

Telegram cannot reach `localhost`. Connect registers the webhook on the host the page is open on.

### Cloudflare Access

Optional. Access puts a sign-in in front of the app, in addition to the Passkey.

1. In Zero Trust > Access controls > Applications, add a self-hosted application for
   `mail.example.com` with an Allow policy for your identity.
2. Add Bypass applications for the paths that outside callers use:
   - `mail.example.com/api/webhooks/*` (Resend, Telegram);
   - `mail.example.com/api/uploads/*` (signed attachment URLs that Resend fetches);
   - `mail.example.com/api/v1/*` (API key clients);
   - `mail.example.com/api/health` (uptime checks).

Unverified: the Free plan's seat count; how the service worker, the live-update WebSocket
(`/api/events`) and notification clicks behave when the Access session expires. Test them before
relying on Access.

## Update

From the repository root, then `worker/`:

```sh
git pull
bun install --frozen-lockfile
bun run check
cd worker
bun run wrangler d1 time-travel info melodymail --config .wrangler-production.jsonc
bun run migrate:prod
bun run deploy:prod
curl https://mail.example.com/api/health
```

- Record the bookmark that `time-travel info` prints. It is the undo point if a migration damages
  data.
- `migrate:prod` reports that nothing is to be done when there is no new migration.
- Open pages show "A new version is available" with a Reload action.

## Roll back

### Code

```sh
bun run wrangler deployments list --config .wrangler-production.jsonc
bun run wrangler rollback --config .wrangler-production.jsonc
```

- `rollback` without an id goes back to the previous version; `rollback <version-id>` to a named
  one. It changes code and assets, not D1.
- Cloudflare refuses a rollback across a Durable Object class change, or to a version whose R2
  bucket or queue no longer exists.
- Pages loaded before the rollback can still request the newer version's assets until reloaded.

### Migrations only move forward

There is no down migration, and a rollback never undoes a schema change. Older code ignores newer
tables and columns, because every migration is additive. A migration that older code cannot run
against must say so in its pull request and be split into an additive step and a later clean-up.

When a migration damaged data, restore with Time Travel to the bookmark recorded in "Update", then
recover later mail with the gap tool ("Backups").

### Trash clocks after a rollback across M7

Code from before M7 does not maintain `messages.trashed_at`. A message moved out of Trash and back
by that code keeps its old time, so after rolling forward it can be deleted before its 30 days. After
rolling forward again, restart every Trash clock:

```sh
bun run wrangler d1 execute melodymail --remote --config .wrangler-production.jsonc --command "UPDATE messages SET trashed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE trashed = 1"
```

Every message in Trash then gets a full 30 days from now.

## Backups

### What is backed up

| Layer | Holds | Kept | Covers |
| --- | --- | --- | --- |
| D1 Time Travel | the whole database, every credential included | 7 days on Workers Free, restorable to the minute | bad migration, bad query, corrupt rows found within 7 days |
| Daily export to R2 | every table except credentials and login state, as SQL | the 14 newest, plus each month's first for 6 months | damage found after 7 days, a deleted database, a move to another account |
| Off-account copy (rclone) | the whole bucket: raw mail, sent copies, exports | as long as you keep it | R2 objects deleted by mistake, a lost account |

- The export runs in the 15-minute cron, starting at the first run after 03:00 UTC, at most 1 MiB
  of SQL per run. It lives in the mail bucket under `backups/d1/<exportId>/`. `exportId` is the UTC
  start time to the minute, for example `2026-11-18T0300Z`.
- `manifest.json` is written last. An export without it is incomplete and is never restored.
  Incomplete exports are removed after 2 days; an export still running after 48 hours is marked
  failed and replaced.
- The export leaves out `owner`, `passkeys`, `sessions`, `auth_challenges`, `login_attempts`,
  `api_keys`, `push_subscriptions`, `telegram` and `webhook_events`. A restore from an export
  therefore means running `/setup` again, reconnecting Telegram, turning on push on each device and
  creating API keys again. A Time Travel restore keeps all of them.
- Raw mail in R2 has no second copy inside the account. Only the off-account copy covers it.
- Mail that Trash expiry deletes after 30 days can come back from Time Travel for 7 days, as rows
  only: its raw object in R2 is gone, so it cannot be opened.

### Before any restore

1. Choose the restore point (a time, or an export id) from the logs and Settings > Security.
2. Record the current bookmark, so the restore can be undone:

```sh
bun run wrangler d1 time-travel info melodymail --config .wrangler-production.jsonc
```

3. Optional: pause inbound mail by setting the Email Routing catch-all to "Drop" in the dashboard.
   Without the pause, mail that arrives during the restore is stored in R2 and recovered by the gap
   tool afterwards.

### Restore with Time Travel

Use this when the damage is less than 7 days old and the database still exists. Give the time
with an explicit zone (`Z` or an offset).

```sh
bun run wrangler d1 time-travel info melodymail --timestamp=2026-11-20T08:00:00Z --config .wrangler-production.jsonc
bun run wrangler d1 time-travel restore melodymail --timestamp=2026-11-20T08:00:00Z --config .wrangler-production.jsonc
```

- `restore` overwrites the database and cancels running queries. At most 10 restores run per 10
  minutes.
- To undo it, restore to the bookmark from "Before any restore" with `--bookmark=<bookmark>`.
- Credentials, sessions and push subscriptions come back as they were at that time.
- Then run the gap tool from the restore time, and "Verify a restore".

### Restore from an R2 export

Use this when Time Travel cannot help. The export goes into a new database, so the old one stays
until the restore is verified. The restore script `bun run backup-restore` downloads and checks an
export and writes `restore.sql`; it writes nothing to a database or bucket. Its exit codes: 0
passed, 1 a check failed, 2 could not run.

1. Find the newest complete export (a `backups/d1/<exportId>/manifest.json` in the R2 bucket, in
   the dashboard), then download and check it into a directory outside the repository:

```sh
bun run backup-restore fetch 2026-11-18T0300Z ~/melodymail-restore --remote --config .wrangler-production.jsonc
```

   It checks every part's size, MD5 and sequence against the manifest. It writes
   `~/melodymail-restore/restore.sql`: the parts in order with foreign keys deferred, then the
   removal of rows whose parent the export lacks.

2. Create the new database and note its id:

```sh
bun run wrangler d1 create melodymail-restore --no-update-config
```

3. In `deploy.local.jsonc`, write the old `database_id` down in a comment, then set `database_id` to
   the new id. From here on, every command with `.wrangler-production.jsonc` acts on the new
   database. The deployed Worker keeps using the old one until step 6.

4. Apply the migrations to the new database, then import the export:

```sh
bun run migrate:prod
bun run wrangler d1 execute melodymail --remote --file ~/melodymail-restore/restore.sql --config .wrangler-production.jsonc
```

   `main` always holds the export's migration or a later one, so the import fits the schema.

5. Verify the import: row counts against the manifest, an empty `PRAGMA foreign_key_check`, and 20
   sampled raw objects present in R2.

```sh
bun run backup-restore verify ~/melodymail-restore melodymail --remote --r2-remote --config .wrangler-production.jsonc
```

6. Deploy, so the Worker uses the new database:

```sh
bun run deploy:prod
```

7. Run first-run setup again: set a new `SETUP_TOKEN` (Deploy, step 7), open `/setup`, then delete
   the token. Connect Telegram again, turn on push on each device, and create API keys again.
8. Run the gap tool from the export id ("Recover mail after the restore point").
9. Keep the old database until you have used the restored one for a week. Then delete it in the
   dashboard's D1 page, after checking that its id is the old id from step 3. Do
   not use `wrangler d1 delete melodymail`: the config now maps that name to the new database.

Exports already in R2 have no row in the new database, so the cron never prunes them. Remove the
old exports you no longer need from the R2 dashboard.

Unverified: whether the 100,000-byte statement limit and `defer_foreign_keys` behave in a
`--remote` import as they did in the local drill.

### Recover onto a new account

Needs the off-account copy. Without it, only what you synced survives.

1. Deploy from zero on the new account up to and including Deploy, step 6. Do not run setup yet.
2. Upload the copy into the new `melodymail-mail` bucket with keys unchanged. Create an R2 token
   with "Object Read & Write" on the new bucket, configure an rclone remote for it as in "Monthly
   off-account copy" (add `no_check_bucket = true`), and run from the directory that holds the
   copy:

```sh
rclone copy ./melodymail-mail melodymail-new:melodymail-mail --progress
```

3. Restore the newest export from the copy: run "Restore from an R2 export" steps 1, 4 and 5 on
   the new account (the new database is the one from step 1, so skip steps 2 and 3).
4. Continue the deploy from step 7: setup token, Email Routing, DNS, setup. If the domain moved too,
   Passkeys bound to the old host do not work; setup registers a new one.

No secret value has to survive: every Worker secret can be issued again. What must survive is
access to the Cloudflare, Resend and domain registrar accounts, and the off-account copy.

### Verify a restore

| Check | Expected |
| --- | --- |
| `bun run backup-restore verify ...` (export restores only) | exit 0: counts match, no foreign key problem |
| Sign in, open the Inbox | the newest message from before the restore point is there |
| Search for a word from a message body | the message is found |
| Open a message | it renders, so its raw object is reachable |
| `curl https://mail.example.com/api/health` | `{"ok":true}` |
| Send a mail from an outside account | it arrives and is parsed within a minute |

### Recover mail after the restore point

The gap tool finds raw mail stored after the restore point that has no row, and writes SQL that
stores it again. It reads the metadata `email()` writes on each raw object. It writes nothing to D1
or R2 itself.

```sh
bun run backup-gap 2026-11-20T08:00:00Z ~/melodymail-gap.sql --remote --config .wrangler-production.jsonc --dry-run
bun run backup-gap 2026-11-20T08:00:00Z ~/melodymail-gap.sql --remote --config .wrangler-production.jsonc
bun run wrangler d1 execute melodymail --remote --file ~/melodymail-gap.sql --config .wrangler-production.jsonc
```

- The restore point is an export id (`2026-11-18T0300Z`), an ISO time with `Z` or an offset
  (`2026-11-20T09:00:00+01:00`), or 13 digits of milliseconds. A time without a zone is refused,
  and so is a date that does not exist (`2026-02-30`). The report prints the point in UTC.
- An export id is read to the minute. Objects stored in the export's first minute are listed too,
  and skipped when they have a row. Listing starts 10 minutes before the point for the same reason.
- `--dry-run` prints the report and writes no file. Exit codes: 0 done, 2 could not run.
- `--remote` makes wrangler upload a temporary preview Worker (its own proxy code) to the account
  for the session; it needs `wrangler login`. For local state use
  `--local --persist-to <dir>` instead.
- After the SQL is applied, the cron re-enqueues the rows within 15 minutes and the queue consumer
  parses them.

Rebuilt rows differ from what `email()` stored:

- rules are not applied again: read, starred, archived and Trash flags and `trashed_at` are lost,
  and rule forwards already happened;
- `forward_failed` is 0 and the address's last-received time is not updated;
- the address row must exist in the restored database;
- objects left by a fallback forward (mail forwarded or bounced while storage failed) come back as
  messages;
- objects stored before M7 have no metadata; they are reported and skipped.

Mail sent after the restore point is reported, not rebuilt. Its `sent/` copy is written before the
Resend call and holds no outcome. Check the Resend dashboard for what went out.

### Local restore drill

Run it before the first deploy and then monthly. It exercises the export and the restore on local
state only. Set these in the shell first, so nothing is sent to Cloudflare:

```sh
export WRANGLER_SEND_METRICS=false CLOUDFLARE_CF_FETCH_ENABLED=false
```

1. Build the app, migrate a scratch database outside the repository, and start the Worker on it
   (first terminal):

```sh
bun run --cwd ../web build
bun run wrangler d1 migrations apply melodymail --local --persist-to ~/melodymail-drill/source
bun run wrangler dev --test-scheduled --persist-to ~/melodymail-drill/source --port 8799
```

2. In a second terminal, from `worker/`, fill the mailbox and run the cron until the export is
   complete (about 25 runs for the fixtures):

```sh
bun ../scripts/seed-mail.ts http://localhost:8799 --persist-to ~/melodymail-drill/source
for i in $(seq 1 40); do curl -s "http://localhost:8799/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*" > /dev/null; done
bun run wrangler d1 execute melodymail --local --persist-to ~/melodymail-drill/source --command "SELECT id, status, bytes FROM backup_exports"
```

   The cron route is `/cdn-cgi/handler/scheduled`. `/__scheduled` returns the app instead, because
   the assets layer answers requests that look like page navigations.

3. Stop `wrangler dev` (Ctrl+C). Fetch the export, restore it into a second database, and verify,
   with the export id from step 2:

```sh
bun run backup-restore fetch 2026-11-18T0300Z ~/melodymail-drill/export --local --persist-to ~/melodymail-drill/source
bun run wrangler d1 migrations apply melodymail --local --persist-to ~/melodymail-drill/restored
bun run wrangler d1 execute melodymail --local --persist-to ~/melodymail-drill/restored --file ~/melodymail-drill/export/restore.sql
bun run backup-restore verify ~/melodymail-drill/export melodymail --local --persist-to ~/melodymail-drill/restored --r2-local --r2-persist-to ~/melodymail-drill/source
```

4. Record the export id, its size, the counts and the time taken in `docs/STATE.md`.

After the first deploy, the monthly drill uses the newest production export instead: download it
with `--remote`, import it locally, and production is never written:

```sh
bun run backup-restore fetch 2026-11-18T0300Z ~/melodymail-drill/prod --remote --config .wrangler-production.jsonc
bun run wrangler d1 migrations apply melodymail --local --persist-to ~/melodymail-drill/prod-restored
bun run wrangler d1 execute melodymail --local --persist-to ~/melodymail-drill/prod-restored --file ~/melodymail-drill/prod/restore.sql
bun run backup-restore verify ~/melodymail-drill/prod melodymail --local --persist-to ~/melodymail-drill/prod-restored --r2-remote --config .wrangler-production.jsonc
```

Delete `~/melodymail-drill` afterwards; it holds mail content.

### Release check

Before each production deploy, run the release tier on `main`, signed in with `wrangler login`,
from the repository root:

```sh
bun run release 2026-11-18T0300Z
```

It runs `bun run check`, the four scheduled browser suites, then the drill on that production
export (read only) with this checkout's newer migrations applied to the restored copy. Exit codes:
0 passed, 1 a step failed, 2 could not run.

### Monthly off-account copy

Copy the whole bucket to your own disk once a month with rclone and a read-only R2 token. The token
stays on that machine.

1. In the dashboard, open R2 object storage > Overview > Manage API Tokens. Create an Account API
   token with the permission "Object Read only", scoped to `melodymail-mail`. Copy the Access Key ID
   and the Secret Access Key.
2. Run `rclone config` and create a remote named `melodymail-r2`: type "Amazon S3 Compliant
   Storage Providers", provider "Cloudflare R2 storage", the two keys, and the endpoint
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. The result in `rclone.conf`:

```ini
[melodymail-r2]
type = s3
provider = Cloudflare
access_key_id = <Access Key ID>
secret_access_key = <Secret Access Key>
endpoint = https://<ACCOUNT_ID>.r2.cloudflarestorage.com
acl = private
```

   `rclone config` can encrypt the file with a password ("Set configuration password").
3. Each month, from the directory that holds the copy, look at what would change, then sync:

```sh
rclone sync melodymail-r2:melodymail-mail ./melodymail-mail --dry-run
rclone sync melodymail-r2:melodymail-mail ./melodymail-mail --backup-dir ./melodymail-mail-removed/$(date +%Y-%m) --progress
```

- Read the dry run first. Many deletions mean objects were removed in R2; stop and find out why
  before syncing.
- `--backup-dir` moves every file the sync would delete or overwrite into a dated directory instead
  of deleting it. Remove old dated directories when you no longer need them.
- The copy holds mail content. Keep it on an encrypted disk.

The rclone commands follow the Cloudflare and rclone documentation; they were not run for this
runbook.

### Optional: lock recent exports

A bucket lock on `backups/` stops anything, including a faulty Worker, from deleting or overwriting
an export for 7 days. Never lock `raw/`: permanent delete and forward-only addresses must be able to
remove mail. Unverified: whether bucket locks are available on the Free plan. If the command is
refused, go on without it.

Set it once, after the first export is complete:

```sh
bun run wrangler r2 bucket lock add melodymail-mail backups-7d backups/ --retention-days 7 --config .wrangler-production.jsonc
bun run wrangler r2 bucket lock list melodymail-mail --config .wrangler-production.jsonc
```

Consequences:

- An incomplete export younger than 7 days cannot be removed. The prune logs
  `backup_prune_failed`, skips it and retries after the next completed export.
- A page written again after an interrupted cron run cannot overwrite its part. That export then
  fails and is replaced after 48 hours. This follows from the code and the lock rules; it was not
  tested against a real lock.
- A bucket cannot be emptied while any lock rule exists. Remove the rule first:
  `bun run wrangler r2 bucket lock remove melodymail-mail --id backups-7d --config .wrangler-production.jsonc`.

## Observability

### Logs

- Workers Logs: dashboard > Workers & Pages > `melodymail` > Observability. Free keeps 3 days and
  200,000 events a day.
- Live: `bun run wrangler tail --config .wrangler-production.jsonc --format json`.
- Each invocation log carries its CPU time. Unverified: the exact field name (`cpuTime` is
  expected).

### Events to act on

Errors (each needs a cause):

| Event | Meaning |
| --- | --- |
| `unhandled` | a request failed with an unexpected exception |
| `cron_job_failed` | one cron job threw; the others still ran |
| `backup_export_failed` | an export page failed, or an export timed out after 48 hours |
| `backup_stale` | no export completed in 48 hours (logged once a day) |
| `rules_load_failed`, `rules_eval_failed` | rules did not run; mail was handled as if none matched |
| `mail_audit_failed`, `mail_forward_record_failed` | an audit or forward record was not written |

Warnings (look when they repeat): `mail_store_failed`, `mail_parse_gave_up`, `mail_raw_missing`,
`mail_forward_failed`, `mail_enqueue_failed`, `mail_raw_delete_failed`, `send_failed`,
`push_failed`, `push_new_mail_failed`, `telegram_call_failed`, `telegram_new_mail_failed`,
`backup_prune_failed`, `upload_delete_failed`, `hub_notify_failed`.

Information worth knowing: `backup_export_started`, `backup_export_complete`, `backup_pruned`,
`trash_expired` (with a count), `mail_requeued`, `uploads_removed`.

### Free quotas

| Resource | Free limit | Where to read it | Main user |
| --- | --- | --- | --- |
| Worker requests | 100,000 a day | Worker > Metrics | the app, the API, webhooks |
| Worker CPU | 10 ms per invocation | invocation logs | `email()`, the consumer, the cron, webhooks |
| D1 rows read / written | 5 million / 100,000 a day | D1 > Metrics | mailbox lists, the export |
| D1 storage | 500 MB per database | `bun run wrangler d1 info melodymail --config .wrangler-production.jsonc` | messages and search text |
| R2 storage, Class A, Class B | 10 GB-month, 1 million, 10 million a month | R2 > bucket > Metrics | raw mail, exports |
| Queues operations | 10,000 a day | Queues > `melodymail-inbound` | about 3 per inbound message |
| Durable Objects | 100,000 requests, 13,000 GB-s a day | Durable Objects > Metrics | the live-update hub |
| Workers Logs | 200,000 events a day | Observability | every invocation and log line |
| Resend | 100 a day, 3,000 a month | compose, Resend dashboard | sending |

Over a Free limit the operation fails. Nothing is charged.

### Free alerting

- With Telegram connected, the Worker sends one plain message a day at most when an export fails
  ("MelodyMail: the daily backup failed. Check the Worker logs for backup_export_failed.") or no
  export completed in 48 hours ("MelodyMail: no backup has completed in the last 48 hours. Check the
  Worker logs."). The text follows the chat's language.
- Point a free external uptime monitor at `https://mail.example.com/api/health`. It carries no data.
- Unverified: which Cloudflare Notifications for Workers errors exist on the Free plan. They are
  not relied on.

### Routine checks

Weekly, about 10 minutes:

1. The newest export is complete and less than 24 hours old. Open R2 > `melodymail-mail` >
   `backups/d1/` in the dashboard, or read its manifest:

```sh
bun run wrangler r2 object get melodymail-mail/backups/d1/2026-11-18T0300Z/manifest.json --remote --pipe --config .wrangler-production.jsonc
```

2. Workers Logs, level error, past 3 days: every event has a known cause.
3. D1 and R2 storage are well under their limits.

Monthly: the local drill with the newest production export, the off-account copy, and the Resend
domain status.

## Production verification checklist

Run these once after the first deploy, in order, and record each result in `docs/STATE.md`, M7.
Record no account id, hostname or secret.

| # | Check | How | Expected |
| --- | --- | --- | --- |
| 1 | Deploy | `bun run deploy:prod` with the explicit resources, then `curl https://mail.example.com/api/health` | the deploy succeeds; 200 `{"ok":true}` |
| 2 | Setup and sign-in | run `/setup` on the custom domain with a real Passkey, then open `/setup` again; sign out and in | setup once, then 409 `already_initialized`; sign-in works |
| 3 | Client IP and location | Settings > Security | your session shows your IP and city, not "this device or local network" |
| 4 | Rate limiters | 12 failed recovery attempts within a minute from one IP; 130 requests to `/api/v1/messages` with an invalid key; then clear the lockout (`docs/REFERENCE.md`, "Clear a recovery lockout") | 429 within the first dozen recovery attempts and after about 120 API requests (approximate, per location) |
| 5 | Inbound delivery | mail from an outside account to an added address, with a page open | stored, parsed within a minute, shown in the Inbox, the open page updates |
| 6 | Refusal | mail to an address that is not added | the sender gets a bounce; no R2 object is written |
| 7 | Forwarding | forward to a verified destination (one verified in mixed case too); a rule with a forward action; a forward-only address | each target gets one copy with `X-MelodyMail-Forwarded: 1`; forward-only keeps no R2 object; note whether `forward()` counts as a subrequest in the invocation log |
| 8 | Production CPU time | invocation logs for `email()` with 50 rules, the consumer, a cron run with an export, the Resend webhook, the Telegram webhook, a send, a v1 request, a Passkey sign-in | every one under 10 ms; record the highest in `REQUIREMENTS.md`, "Numbers" |
| 9 | Queue retry | a week of normal use | no message stays `stored` longer than 30 minutes |
| 10 | Sending | a send with an attachment | the logs show `GET /api/uploads/:id/blob` with 200; the recipient gets the attachment; the message shows "Delivered"; the quota matches Resend's dashboard (it may read one low) |
| 11 | Resend webhook signature | "send test event" in Resend, or a real event | 200 and a `webhook_events` row; a wrongly signed request stays covered by tests only |
| 12 | Web Push | Chrome, Firefox, Safari on macOS, iOS from the Home Screen | the test and a new-mail notification arrive; a click opens the message |
| 13 | Telegram | Connect, a new mail, each button | the card arrives as a plain message; every button changes it and answers the tap |
| 14 | Hub hibernation | one page open and idle for an hour | Durable Objects duration stays near zero; a new mail still updates the page |
| 15 | Quiet while open | switch on, page in the foreground, send a mail; then the page in the background for 75 seconds | first no push and no Telegram, the in-page notice shows; then both resume |
| 16 | Logs and secrets | do item 8 first; create a temporary API key, call `/api/v1/messages`, search Workers Logs and `wrangler tail --format json` for the key's prefix; note whether a signed attachment URL's `sig` appears | the `Authorization` header does not appear; if it does, set `observability.logs.invocation_logs: false` (this also removes CPU time); revoke the key either way; record the `sig` finding |
| 17 | First export | the day after the deploy, read the manifest; run the monthly drill on it | the manifest exists, sizes and MD5s match, the drill passes |
| 18 | Install | Chrome or Edge on the custom domain; then go offline | Install is offered; offline shows the app shell |

Not covered by a deployment: Firefox and Safari rendering of the reader, screen reader checks,
WCAG contrast measurements, CJK fonts on macOS, iOS and Android.

## Key material

- Recovery key and TOTP seed: a password manager or paper, never the repository.
- `deploy.local.jsonc`: your machine; ids, not secrets.
- Worker secret values: optional in a password manager; none is needed to recover.
  `bun run wrangler secret list --config .wrangler-production.jsonc` shows names only.
- The read-only R2 token for the off-account copy: the machine that holds the copy only.
