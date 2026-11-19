# MelodyMail feature reference

What each MelodyMail feature does and how it behaves. Deployment, backups and operations are in
`docs/RUNBOOK.md`.

Commands below run from `worker/`. Commands against production use the generated
`.wrangler-production.jsonc` (`bun run prod-config`, see `docs/RUNBOOK.md`, "Production config").
For the `wrangler dev` database, replace `--remote --config .wrangler-production.jsonc` with
`--local`.

## Authentication

The owner signs in with a Passkey; there is no password. The fallback is a recovery key plus a code
from an authenticator app (TOTP). Both are created during first-run setup.

- First-run setup at `/setup` needs the `SETUP_TOKEN` Worker secret. The Worker refuses setup while
  the secret is missing or shorter than 32 characters.
- Setup runs once. After it succeeds, `/setup` answers 409 `already_initialized` and the token opens
  nothing. For `wrangler dev`, put the token in `worker/.dev.vars`.
- A Passkey is bound to the host the page is opened on. Use `localhost`, not `127.0.0.1`, in local
  development: browsers do not accept an IP address as a Passkey relying party.
- Settings > Security lists the signed-in sessions with their IP address and city, and revokes
  them.

### Clear a recovery lockout

Recovery counts failed attempts in two ways. One IP address gets at most five in any 15 minutes;
all addresses together get at most 20. A lock lasts until the oldest counted attempt is 15 minutes
old (at most 15 minutes). The global ceiling locks recovery for everyone, the owner included. To
open both at once, delete the counted failures:

```sh
bun run wrangler d1 execute melodymail --remote --config .wrangler-production.jsonc --command "DELETE FROM login_attempts"
```

The command deletes only the failure counts; it does not change any credential.

## Domains and addresses

1. The domain must use Cloudflare DNS with Email Routing turned on.
2. In Settings > Domains, add the domain. Its "DNS records" page lists the Email Routing MX, SPF,
   DKIM and DMARC records; "Check DNS" asks Cloudflare's DNS-over-HTTPS resolver
   (`DOH_URL` in `worker/wrangler.jsonc`) and marks each record found, missing or different.
3. In Settings > Addresses, add each address that may receive mail. A prefix holds a-z, 0-9,
   `.`, `_` and `-`; `+` is reserved for tags such as `shop+news`.
4. In Settings > Forwarding, add the addresses mail may be forwarded to. Each must first be a
   verified destination address in the Cloudflare dashboard (Email Routing > Destination
   addresses, at most 200 per account).

## Inbound mail

The Email Routing catch-all sends every message for the domain to the Worker (`docs/RUNBOOK.md`,
"Turn on Email Routing").

1. Only addresses added in Settings > Addresses receive mail. Mail to any other address, to a
   disabled address, or to a domain with receiving switched off is refused before anything is
   stored. `shop+news@` is delivered to `shop@` with the tag `news` kept on the message.
2. Each received message is stored in R2 and parsed by the queue consumer. A Cron Trigger every
   15 minutes re-queues messages that are still unparsed after 15 minutes. After five failed
   parse tries a message is marked as not parsed; its raw copy stays in R2.
3. An address with forwarding targets forwards every message to each of them, with the header
   `X-MelodyMail-Forwarded: 1`; a message that already carries it is kept and not forwarded
   again. A forward-only address keeps no copy, unless every forward fails.
4. If a message cannot be stored, an address with forwarding targets forwards it to them instead
   (recorded in the audit log); an address without targets refuses it, and the sender gets a
   bounce.
5. Each raw object in R2 carries the address id, the envelope sender and recipient, and the
   received time as metadata. The gap tool uses them after a restore (`docs/RUNBOOK.md`, "Recover
   mail after the restore point").

## Rules

Settings > Rules holds up to 50 rules. Each rule has 1 to 10 conditions and at least one action.
The enabled rules can name at most 20 different headers in their header conditions.

- **Conditions** read the envelope and the headers, never the body: From (each address and its
  display name; the envelope sender when there is no `From` header), To or Cc (the first 50
  addresses of each of From, To and Cc are read), the recipient
  address without its `+tag`, the sub-address tag, the subject, or any named header such as
  `List-Id`. Operators: contains, doesn't contain, is, starts with, ends with. Case does not
  matter and runs of white space count as one space. To match a domain, use "ends with"
  `@example.com`: `example.com` alone also matches `notexample.com`. There are no regular
  expressions.
- **Actions**: forward to up to 5 addresses from Settings > Forwarding, mark as read, star,
  archive, move to Trash, move to Spam, and stop processing more rules.
- **Order**: rules run top to bottom; every matching rule adds its actions, and a matching rule
  with "Stop processing more rules" ends the run. Trash wins over Spam, and Spam over archive.
  Move up and Move down change the order.
- **Forwarding**: a message goes to the address's own forwarding addresses first, then to the
  rule targets, each once and at most 10 in all; over 10, the audit log records
  `mail_forward_capped`. A message that already carries `X-MelodyMail-Forwarded` is not
  forwarded by a rule either. A forward-only address forwards to the rule targets as well.
- **New mail only**: a rule applies to mail that arrives after it is saved. Creating, editing,
  reordering or deleting a rule never changes stored mail.
- **Notifications**: mail that a rule marks as read, archives, or moves to Trash or Spam sends
  no push and no Telegram card; open pages still refresh. Starred mail notifies as usual.
- **Test**: in the rule dialog, "Test rule" checks the rule against one of the 20 newest Inbox
  messages and shows which conditions match and what would happen. A test changes nothing.

Removing a forwarding address that a rule uses asks for confirmation. A rule left without any
action is then turned off.

If the rules cannot be read, `email()` logs `rules_load_failed` and handles mail as if no rule
matched.

## Mailbox

Messages are parsed in the browser. Sender HTML is shown in a sandboxed frame without scripts,
which has a fixed height and scrolls inside: auto height would need scripts or same origin in the
frame, and was declined to keep it isolated. In a frame up to 640 px wide, mail laid out for a
wider screen reflows to the frame width. Remote images stay blocked until "Show remote images"
is chosen for that message, and attachments are always downloaded, never opened in the app. In
the dark theme, "Dark reading" in the reader shows one HTML message inverted; it is off for every
message you open.

When every loaded message of a folder is selected and the folder holds more, the list offers
"Select all N in" the folder. In that mode an action applies to every message that was in the
folder when the offer appeared; mail that arrives later is shown but left out. Unchecking a row,
another folder, address or search, or a reload leaves the mode. A change over the whole folder
shows its progress and can be stopped; what was changed stays changed. Search results have no
"select all".

While Delete forever, Empty or a whole-folder change runs, the list loads nothing else and
reloads once at the end. If a request gets no answer, the run stops, the list and counts reload,
and a message says the result of the last request is unknown.

The language and theme buttons open menus of their choices: in the app bar, and on a phone at the
end of the navigation drawer. The theme button's
icon shows the current mode: system, light or dark.

On a phone (narrower than 768 px):

- the reader shows Back, Reply, Archive and Move to Trash as icons (in Spam: Not spam), and the
  other actions, Report spam and Dark reading included, under "More actions";
- the list title row holds Refresh and Select, and Compose floats at the bottom right; the
  actions on selected messages (Archive and Move to Trash, with star, read state and Report spam
  under "More actions") show in selection mode, which Select or a long press on a row starts and
  Done ends; the "Message / Date" header row shows only in selection mode;
- with a finger, a row swipes right to Archive (Move to Inbox in Archive, Restore in Trash, Not
  spam in Spam) and left to Move to Trash; Trash and Spam have no left swipe;
- Trash and Spam show their 30-day note and Empty above the list;
- Settings opens a list of its sections; wider screens open Domains.

Compose opened as a page (narrower than 1280 px) keeps Close and Send in its title row, so both
stay on screen while the fields scroll. Where the primary pointer is a finger, every control is
at least 44 x 44 CSS px.

Open pages receive new-mail events from the `Hub` Durable Object (SQLite-backed, as Workers Free
requires), which the deploy creates.

### Trash

- Mail in Trash for 30 days is deleted for good: its raw object in R2, its row and its search text.
  The Trash folder says so.
- The 30 days start when the message entered Trash. Moving it out stops the clock; moving it back
  starts a new 30 days. A rule that moves mail to Trash starts the clock on arrival. Messages
  already in Trash when migration 0015 ran count from that migration.
- The cron deletes at most 100 expired messages per run, oldest first, through the same path as a
  manual permanent delete. It logs `trash_expired` with a count and writes one audit row per run.
- An open Trash list keeps showing an expired message until it refreshes.
- Time Travel can bring back the rows of deleted mail for 7 days, but not the raw object, so such a
  message cannot be opened (`docs/RUNBOOK.md`, "Backups").
- Delete forever removes the selected messages that are still in Trash; a message moved out
  meanwhile is kept. Empty Trash deletes, 100 per request, exactly what was in Trash when the
  confirmation opened: mail that arrives or is moved to Trash after that stays. Each request
  writes one audit row (`messages_deleted` or `trash_emptied`, with the count).
- Both ask for confirmation with the count, show progress while they run, and can be stopped
  between requests; what was deleted stays deleted. On a desktop, Empty Trash sits at the end of
  the action bar next to the 30-day note; on a phone, in the row above the list.

### Spam

- Report spam moves a message to Spam and remembers its sender: the address in its `From`
  header, lowercased. Later mail from a remembered sender is moved to Spam when it is parsed,
  shortly after it arrives, unless a rule archived it or moved it to Trash. Only received messages
  that enter Spam add a sender; mail you sent never does.
- Report spam is in the action bar (on a phone under "More actions") and in the reader of every
  folder except Sent, Trash and Spam. Spam lists Not spam, Delete forever, star and read state.
- Not spam moves a message back to the Inbox and forgets its sender. Moving a whole folder to Spam
  ("select all") remembers no sender, so the action is labelled Move to Spam there.
- Settings > Spam senders lists the remembered senders with Remove. Removing one stops filing its
  later mail; mail already in Spam stays there.
- The reader loads no remote images for a message in Spam, even one you allowed before it was
  moved there. A message the consumer files into Spam leaves an open list at once, and an open
  reader switches to the Spam actions.
- A forged `From` can make Report spam remember a real sender. Their later mail then lands in
  Spam, not lost: Not spam on it forgets the sender again.
- Mail in Spam is in no other folder, not in search, not in recipient suggestions, and counts as
  unread only in Spam. It sends no push and no Telegram card. A message with both Trash and Spam
  set (written by older code after a rollback) shows in Trash.
- Moving a message to Trash or Archive takes it out of Spam. Mail you sent never enters Spam.
- Mail in Spam for 30 days is deleted for good, as in Trash: the 30 days start when it entered
  Spam, and the cron logs `spam_expired` with a count. Delete forever and Empty Spam work as in
  Trash (audit `messages_deleted`, `spam_emptied`).
- There is no content scoring: only reported senders and rules file mail into Spam. The rule
  editor's "Move to Spam" action sits beside "Move to Trash".

## Install and offline

MelodyMail is an installable web app. In Chrome or Edge, choose Install in the address bar; on
iPhone and iPad, choose Share, then Add to Home Screen; installed there, the app bar draws under
the status bar. Its service worker caches only the app
itself, never mail or API answers, so the app opens without a network and says it is offline;
reading mail needs the network. After a deploy, open pages show "A new version is available"
with a Reload action.

The icons in `web/public` are generated from `web/public/logo.svg`. After changing the logo,
run `bun run --cwd web icons` and commit the PNG files.

## Notifications

While a MelodyMail page is in the foreground (visible and focused), new mail shows a notice in
that page with the sender, the subject and an Open button; it hides after a few seconds, and at
most three show at once.

Settings > Notifications > "Quiet while MelodyMail is open" (off by default) holds every other
notification back while any page is in the foreground: no Web Push, no Telegram message, and
hidden pages stay quiet, on every device. A page that sleeps or loses its network stops counting
as in the foreground within 75 seconds. If the setting cannot be read, notifications go out as
with it off.

Otherwise MelodyMail sends a Web Push notification for new mail to each device that has no
MelodyMail page open; an open page that is hidden shows the notification itself. The
notification shows the sender and the subject, never the message text. Push stays off until the
Worker has a VAPID key pair and subject (`docs/RUNBOOK.md`, "Web Push"); Settings > Notifications
then says push is not set up.

`VAPID_SUBJECT` must be an `https://` URL, the app's own origin. Push services use it to contact
the sender, so no e-mail address is sent to them. For `wrangler dev`, put the three values in
`worker/.dev.vars`.

Changing the key pair ends every subscription: push services refuse messages signed with a key the
browser did not subscribe with. Delete the old rows, then turn notifications on again in
Settings > Notifications on each device:

```sh
bun run wrangler d1 execute melodymail --remote --config .wrangler-production.jsonc --command "DELETE FROM push_subscriptions"
```

Signing a device out, or revoking its session, also ends its notifications until that device
signs in again.

### Telegram

MelodyMail can also send a card to one private Telegram chat for each new mail: the sender, the
subject and the address it arrived at, never the message text. The card's buttons open the
message, mark it read or unread, archive it or move it back to the Inbox, and star it or remove
the star. Telegram can read these fields, because bot messages are not end-to-end encrypted.
A card is sent even while a MelodyMail page is open, unless "Quiet while MelodyMail is open" is
on and a page is in the foreground (see "Notifications"). Mute the chat in Telegram to silence it.

Telegram currently refuses widgets from general bots (`INPUT_MEDIA_WIDGET_NOT_ALLOWED`), so cards
arrive as plain messages: the sender and the subject, with the same four buttons below them. The
arrival address is shown only on a widget card. Once Telegram allows widgets again, new cards
arrive as widgets without any change.

Telegram needs the deployed `https://` address: it cannot reach `localhost`, and it delivers
updates only to ports 443, 80, 88 and 8443 (MelodyMail accepts 443, 88 and 8443, all `https:`).

To connect, set `TELEGRAM_BOT_TOKEN` (`docs/RUNBOOK.md`, "Telegram"), open Settings >
Notifications on the deployed address and choose Connect Telegram. Confirm with your Passkey, then
choose Open Telegram and press Start in the chat with the bot (or send the `/start` command the
page shows). The code is valid for 10 minutes and works once.

Connect registers the webhook (`/api/webhooks/telegram`) on the address the page is open on, with
a new secret each time; run it again after moving to another domain or changing the token. After
upgrading from a version without buttons on plain messages, run Connect again: it registers the
webhook for button taps (`callback_query`), and until then those buttons do nothing.
Disconnect removes the webhook and the binding; buttons on old cards then stop working. A
recovery (`POST /api/auth/recover`) also disconnects Telegram; connect again afterwards. Deleting
a mail for good does not delete its card in Telegram; its buttons then say the mail was deleted.
If the bot stops reacting, run Connect again.

The same chat receives the backup alerts (see "Backups").

## Sending

MelodyMail sends mail through [Resend](https://resend.com). You write in Markdown; the browser
renders it, and the mail carries both the Markdown source (plain text) and the HTML. Sending stays
off until the Worker has a Resend API key; compose then says sending is not set up. The Resend
set-up is in `docs/RUNBOOK.md`, "Sending through Resend".

While you type in To, Cc or Bcc, compose suggests addresses you sent to or received mail from,
newest first, matching the address or the display name (`GET /api/contacts`). It reads the newest
1,000 sent and 1,000 received messages; mail in Trash or Spam does not count, and your own
addresses are left out. Text that is already a complete address gets no suggestions, and Enter adds it as typed.

Each secret switches on one part: without `UPLOAD_URL_KEY` compose sends without attachments, and
without `RESEND_WEBHOOK_SECRET` sent mail stays at "Sent" instead of showing delivery. Resend
fetches attachments from a signed URL on your origin that is valid for 24 hours; it cannot reach
`wrangler dev` on localhost, so attachments work only on a deployed Worker. For `wrangler dev`,
put the values in `worker/.dev.vars`.

The quota shown in compose and Settings counts the sends of the current UTC day and month. Each
accepted send adds one; when Resend's own reported count is higher, that count is shown. Resend's
reported count can lag behind, so the local count is often the one shown. The limits come
from `wrangler.jsonc` (`RESEND_DAILY_LIMIT` 100, `RESEND_MONTHLY_LIMIT` 3000, the Free plan). Change the
vars there for another plan.

## REST API

Scripts and other programs read, flag and send mail through `/api/v1/` with an API key.

Create a key in Settings > API keys. Creating one asks for your passkey. The key is shown once;
only its SHA-256 hash is stored. Each key has a name, an expiry (30, 90 or 365 days, or never)
and one or more scopes:

| Scope | Allows |
| --- | --- |
| `mail:read` | list, search and read messages and threads, download raw messages, list addresses |
| `mail:write` | set read, starred, archived and trashed on one message or up to 100; a message in Spam cannot be changed |
| `mail:send` | send without attachments, list addresses |

Send the key as a Bearer token. The session cookie is never read on `/api/v1/`, and a key opens
nothing else: not settings, rules, keys or sign-in.

```sh
curl -H "Authorization: Bearer mmk_xxxxxxxx_<secret>" \
  "https://<your origin>/api/v1/messages?folder=inbox&limit=20"

curl -X POST -H "Authorization: Bearer mmk_xxxxxxxx_<secret>" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{"from": 1, "to": ["friend@example.org"], "subject": "Hello", "text": "Hi"}' \
  "https://<your origin>/api/v1/messages/send"
```

- Errors are `{ "error": "<code>" }`: `invalid_key` or `key_expired` (401), `insufficient_scope`
  (403), `rate_limited` (429, over 120 requests a minute from one IP). A send body with a wrong
  field adds `path`, for example `{ "error": "bad_request", "path": "to.1" }`.
- Lists page with `nextCursor`; pass it back as `cursor` until it is `null`.
- `folder=spam` lists Spam, and every message has a `spam` field. A key cannot move mail into
  or out of Spam: `PATCH` with `spam` answers `bad_request`, and a message in Spam answers
  `not_found`.
- Sending needs an `Idempotency-Key` header, one per message: a repeat with the same key sends
  nothing new and returns the first result.
- Revoke a key in Settings > API keys; it stops working at once. A recovery revokes every key.

The OpenAPI 3.1 document describes every operation: "Download OpenAPI document" in Settings >
API keys, or `GET /api/openapi.json` while signed in. It is kept in
[`worker/src/api/openapi.json`](../worker/src/api/openapi.json).

## Backups

The cron writes a daily export of D1 to the mail bucket under `backups/d1/<exportId>/`. Restores,
retention and the routine checks are in `docs/RUNBOOK.md`, "Backups".

Log events of the export:

| Event | Level | Fields |
| --- | --- | --- |
| `backup_export_started` | info | `exportId` |
| `backup_export_complete` | info | `exportId`, `parts`, `rows` |
| `backup_pruned` | info | `count` of removed exports |
| `backup_prune_failed` | warn | `exportId`, `error` (for example a locked object) |
| `backup_export_failed` | error | `exportId`, `table`, `seq`, `error`; or `exportId` with `error: "timeout"` after 48 hours |
| `backup_stale` | error | `lastComplete`; no export completed in 48 hours, logged once a day |
| `backup_export_restarted` | warn | `exportId` of an export started by code with other column lists (once after the M8 deploy); a new export starts |
| `trash_expired` | info | `count` of messages deleted after 30 days in Trash |
| `spam_expired` | info | `count` of messages deleted after 30 days in Spam |

With Telegram connected, a failed or stale export also sends one plain message a day at most, in
the chat's language:

| Language | Failed | Stale |
| --- | --- | --- |
| English | MelodyMail: the daily backup failed. Check the Worker logs for backup_export_failed. | MelodyMail: no backup has completed in the last 48 hours. Check the Worker logs. |
| Simplified Chinese | MelodyMail：每日备份失败。请在 Worker 日志中查看 backup_export_failed。 | MelodyMail：过去 48 小时内没有完成的备份。请查看 Worker 日志。 |
| Japanese | MelodyMail: 毎日のバックアップに失敗しました。Worker のログで backup_export_failed を確認してください。 | MelodyMail: 過去 48 時間に完了したバックアップがありません。Worker のログを確認してください。 |

The texts are in `worker/src/telegram/card.ts`. They name no mail content.

## Development

`bun run check` is the merge gate: lint, typecheck, tests, the i18n and README checks, build and the
requirements check, run at the same time by `scripts/check.ts`; each step prints its output and
exit code when it ends.

Run the Worker locally from the repository root:

```sh
cp worker/.dev.vars.example worker/.dev.vars
bun run --cwd web build
bun run --cwd worker db:migrate:local
bun run --cwd worker dev
```

Set `SETUP_TOKEN` in `worker/.dev.vars`, then open `http://localhost:8787/setup`.

`bun run dev` also starts Vite on its own port with hot reload; it proxies `/api`, including the
live-update WebSocket (`/api/events`), to the Worker on port 8787. Running the app through Vite
has not been checked against the Worker's same-origin checks; `http://localhost:8787` is the
checked way.

To fill a local mailbox with the test fixtures, start the Worker and run the seed script. It
sends every `.eml` in `worker/test/fixtures` through the real `email()` handler of `wrangler dev`
and creates `shop@example.com` and `news@example.com` in the local database:

```sh
bun run --cwd worker dev
bun scripts/seed-mail.ts
```

Run the two commands in separate terminals. `bun scripts/seed-mail.ts <url> --persist-to <dir>`
seeds a Worker started on other local state (the restore drill).

The browser suites need Chromium for Playwright once:
`bunx playwright@1.65.0 install chromium-headless-shell`. Then:

```sh
bun run test:browser
```

The compose and Markdown suites run apart with `bun run test:send`, the PWA suite with
`bun run test:pwa`, the settings suites with `bun run test:settings`, the mailbox folder suites and the
phone gesture suite (`web/test/gestures.test.ts`: long press, vertical drag, swipe actions) with
`bun run test:folders`.
