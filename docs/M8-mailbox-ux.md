# M8: mailbox behaviour of a mail client

Risk class: High. The change adds permanent bulk deletion, a migration (0016) and a change to how
inbound mail is filed. The owner asked for it on 2026-11-19: Trash had no bulk or full delete,
and the app "does not feel like mail". The owner chose bulk delete and Empty Trash, select all
matching messages, swipe actions on phones, a Spam folder, and four fixes to the phone list
layout (section 5).

This plan is reviewed before coding (`AGENTS.md`, "Change risk"). The first cross-family review
(`cliproxyapi/gpt-6.2-sol`, FIX FIRST, six Mediums and a Low) is folded in; each fix names it.

## Decisions

1. Permanent delete stays limited to mail that is already in Trash or Spam. Nothing outside those
   two folders is ever deleted by these routes.
2. Spam is a flag of its own. A message in Spam is out of every other folder, out of search, out
   of contact suggestions and out of the unread counts except Spam's own.
3. Bulk changes by folder are bounded by a server-issued watermark on a new column `seq`, an
   insertion sequence that never repeats. Mail stored after the confirmation is never changed or
   deleted by a "select all" it did not see. `received_at` cannot serve: `email()` takes it
   before the R2 write (`worker/src/mail/inbound.ts`), so a slower message can commit later with
   an older time (review 1, finding 2). `rowid` cannot serve either: SQLite reuses the highest
   rowid after the newest rows are deleted, which an Empty loop does (review 2, finding 1).
   - A table `counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)` holds `messages_seq`.
   - An `AFTER INSERT ON messages WHEN NEW.seq IS NULL` trigger increments it and writes it to
     the new row's `seq`. One trigger covers both INSERT sites (`inbound.ts`, `send/send.ts`) and
     any later one; a restore that writes `seq` explicitly is left alone (review 3, finding 1).
   - The migration fills `seq` for existing rows in `(received_at, id)` order and sets the
     counter to the maximum. An index `messages_seq` serves the continuation below.
4. Swipe actions are a phone convenience. Each one duplicates a toolbar action, so nothing is
   reachable only by gesture.
5. The REST API v1 can read Spam (`folder=spam`, the `spam` field) but cannot change a Spam
   message, and gains no delete route. Session and v1 PATCH get separate flag parsers; v1 keeps
   its four flags, and its UPDATE adds `AND spam = 0`, so a v1 `archived: true` cannot pull a
   message out of Spam and stop its clock (review 2, finding 4). A Spam id counts as not found
   in v1 `PATCH /messages/{id}`. v1 `PATCH /messages` keeps its own handler and request schema:
   ids only; a body with `folder` or `watermark` answers 400, so a key cannot move a whole folder
   (review 3, finding 5). A `mail:write` key can still move listed ids to Trash, which the cron
   empties after 30 days; that is unchanged from M7. The OpenAPI document gains `spam` in the
   folder enum and the message schema.
6. One transition policy, shared by `updateMessageFlags`, the rule decision and inbound filing
   (review, finding 5):
   - entering Spam sets `archived = 0`, `trashed = 0`, `trashed_at = NULL`, `spam_at = now`;
   - entering Trash or Archive leaves Spam (`spam = 0`, `spam_at = NULL`); when a request or the
     rules set several, Trash beats Spam and Spam beats Archive;
   - Not spam sets `spam = 0` and `archived = 0`, so the message lands in the Inbox;
   - a clock (`trashed_at`, `spam_at`) is set only on entry and kept while the message stays;
     it is the database clock read inside the writing statement, never the Worker's time;
   - outbound rows never enter Spam.

## 1. Bulk permanent delete and Empty Trash

### API

| Route | Body | Result |
| --- | --- | --- |
| `DELETE /api/messages` | `{ folder: "trash" \| "spam", ids }`, 1 to 100 ids (`BULK_MAX`) | Deletes the listed messages that are in that folder now. Returns `{ deleted: [ids] }`. Ids elsewhere are skipped, not an error. More than 100 ids: 400 `too_many_ids`. |
| `POST /api/messages/purge` | `{ folder: "trash" \| "spam", address?, watermark, asOf }` | Deletes up to `PURGE_MAX` (100) messages of that folder and address with `seq <= watermark` and a folder clock before `asOf`, oldest first. Every call of one loop sends the same pair. Returns `{ deleted: [ids], hasMore }`. The client calls again while `hasMore`. |

- Both go through `deleteFromTrash`, renamed `deletePermanently(env, folder, ids, opts)`. Both
  DELETE statements of its batch repeat the exact condition: the folder's own test (`trashed = 1`,
  or `spam = 1 AND trashed = 0`), the address and watermark when given, and for the cron the
  folder's own clock. A row moved to another folder between the SELECT and the batch is kept
  (review, finding 1). FTS rows and rows go in one D1 batch, then one R2 delete of the keys; a
  failed R2 delete leaves an orphan object, never a row without its raw mail.
- `PURGE_MAX` 100 keeps one call to one D1 batch and one R2 delete, the cron's existing bound
  (`TRASH_EXPIRE_MAX`).
- The audit row (`messages_deleted`, `trash_emptied` or `spam_emptied`, with the count) and the
  `hasMore` probe are statements of the same D1 batch as the deletes, so a call either commits
  all of it or none (review 2, finding 3). `hasMore` is `EXISTS (... LIMIT 1)` on the same
  condition, not a count, so a call reads a bounded number of rows however full the folder is
  (review 3, finding 3). The progress shown is the deleted total against the count from the
  confirm dialog.
- When a call fails without an answer (network error, timeout), the client cannot know whether
  the batch committed. It stops the loop, reloads the list and the counts, and the toast says
  the result is unknown and the list was refreshed.
- The watermark and `asOf`, the database clock, come from the count route (section 2) when the
  confirm dialog opens. Purge deletes only rows with `seq <= watermark` whose folder clock
  (`trashed_at` or `spam_at`) is strictly before `asOf`. A message that arrived later, or an older
  message moved or filed into the folder after the dialog opened (for example by the consumer),
  is kept. Empty and a whole-folder Delete forever therefore delete exactly what was in the
  folder when the owner confirmed (review 5, finding 1). Rows in Trash without a clock (before
  migration 0015) are stamped by the cron. Every folder clock is the database clock of the
  statement that set it, and D1 runs statements one at a time, so a write that lands after the
  count has a clock at or after `asOf`, even when the Worker began it earlier. In Trash and Spam
  the count applies the same strict clock test, so the dialog's number is what purge may delete; a
  message entering the folder in the same millisecond as `asOf` is neither counted nor deleted.
- Session routes only (decision 5).

### UI

- In Trash and Spam, the bulk bar gets "Delete forever" for the selection.
- The Trash and Spam lists get "Empty Trash" / "Empty Spam" next to the 30-day note, shown when
  the folder is not empty. On desktop they sit in the bulk bar's end slot as now; on phones, where
  the bulk bar is hidden outside selection mode, the note and the button form a folder row above
  the list (section 5).
- Both open the existing confirm dialog with the count and "This cannot be undone". Empty shows a
  progress count while it loops and can be cancelled between calls; what was deleted stays
  deleted.
- The list drops exactly the ids the server returned, and the toast counts those, after success,
  a partial failure or a cancel. While a delete or a folder loop runs, `useMessageList` starts no
  fetch (scroll paging and Hub refreshes wait), and every answer that arrives for a fetch begun
  before or during the loop is discarded (a generation counter bumped at the start and the end).
  The list reloads once at the end, so no page can bring deleted rows back (review 1, finding 6;
  review 3, finding 4). The counts refresh.
- The reader's single delete keeps `DELETE /api/messages/:id`, now also allowed in Spam.

## 2. Select all matching messages

Today the header checkbox selects the loaded rows only (50 per page, more after scrolling).

### API

- `GET /api/messages/count?folder=&address=` returns `{ total, watermark, asOf }`: the counter
  value, the database clock, and the rows of that view with `seq <= watermark` (in Trash and
  Spam also with the folder clock before `asOf`), in one statement.
- `PATCH /api/messages` accepts, instead of `ids`, `{ folder, address?, watermark, after?,
  ...flags }`. It updates at most `FOLDER_PATCH_MAX` (500) rows of the view with
  `seq <= watermark` and `seq < after`, highest `seq` first, and returns
  `{ updated, next }`, where `next` is the lowest `seq` it touched, or null when no row is left.
  The client passes `next` as `after` until it is null. The continuation moves forward whether
  or not a row leaves the folder, so marking 1,200 Inbox messages read does not select the same
  500 again (review 2, finding 2). The cap bounds the rows one invocation writes.
- Search results are not covered (owner ruling 4).

### UI

- When the header checkbox selects every loaded row and more rows exist (`nextCursor` set), the
  bulk bar shows "All 50 loaded messages are selected. Select all N in Inbox".
- Choosing it switches to "whole folder" mode: "All N messages in Inbox are selected. Clear
  selection". Each bulk action sends the folder form with that count's watermark; in Trash and
  Spam, Delete forever runs the purge loop. A loop shows progress and can be cancelled.
- A change of folder, address or search, a reload, or unchecking a row leaves the mode.
- New mail arriving while the mode is on is shown but not included (the watermark).
- A flag change in this mode applies to the folder's live membership below the watermark: an
  older message restored into the Inbox from another device before the action runs is included.
  Accepted, as in Gmail: the change is reversible, and the bar names the folder, not a frozen set
  (review 6, finding 2). Permanent delete is the exception and is frozen by `asOf` (section 1).

## 3. Swipe actions on phones

- Only under a coarse pointer at `NARROW` (below 768 px), the phone layout. Tablets and desktop
  are unchanged (review, Low).
- Swipe right: Archive (in Archive: Move to Inbox; in Trash: Restore; in Spam: Not spam). Swipe
  left: Move to Trash (in Trash and Spam: nothing, so a gesture never deletes forever).
- Pointer events on the row, no new dependency. The row follows the finger once the movement is
  mostly horizontal (|dx| > |dy| and |dx| > 10 px), so vertical scrolling is not captured. Past
  40% of the row width the action is armed (icon and colour change); release commits, otherwise
  the row springs back. `touch-action: pan-y` on the row.
- Reduced motion: no slide animation; the row is removed at once.
- The action goes through the same `act()` path and toast as the toolbar. No Undo: a delayed flag
  reversal could overwrite a newer change made elsewhere (review, Low).
- A swiped row never opens the message on release, and a swipe never starts selection mode.

## 4. Spam folder

### Data

Migration 0016 adds to `messages`:

- `spam INTEGER NOT NULL DEFAULT 0` and `spam_at INTEGER` (NULL outside Spam);
- index `messages_spam_received` on `(spam, received_at DESC, id DESC)` for the Spam list;
- index `messages_spam_at` on `(spam_at) WHERE spam = 1` for the cron, like
  `messages_trashed_at`.

A table `spam_senders (address TEXT PRIMARY KEY, created_at INTEGER NOT NULL)` holds the reported
senders. The rules table gains the `spam` action column. The migration is additive and safe on a
database that holds rows; it also adds `seq`, `counters` and the trigger (decision 3).

- The backup table list (`worker/src/backup/tables.ts`) gains the new columns, and
  `spam_senders` is appended at the end of the list. `counters` is not exported: it is derived
  state, and the migration already seeds its row in a fresh target, so an exported INSERT would
  collide with it (review 5, finding 3). Appending keeps the numeric table
  cursor of an export that is in progress during the deploy pointing at the same tables
  (review 2, finding 7).
- An export records the column list of every table when it starts. If a part is written after
  the columns changed (an export running across the 0016 deploy), the export is discarded and
  starts again, so one export never mixes rows with and without `seq` (review 3, finding 1).
- An export finished by the M7 Worker after 0016 landed (the migrate-before-deploy window) has
  parts without `seq` under a 0016 manifest. It still restores: every exported INSERT names its
  columns (`worker/src/backup/sql.ts`), so the missing `seq` is NULL and the trigger numbers the
  row (review 4, finding 2).
- A Time Travel restore rewinds the counter. A confirm dialog open across a restore could hold a
  watermark above it. Not designed for: the runbook's restore is a maintenance step, and the
  dialog's watermark lives for seconds. The runbook's restore step gains "close open MelodyMail
  tabs first" (review 4, finding 1, accepted).
- Restore writes `seq` as stored (the trigger skips it), then ends with `UPDATE counters SET
  value = MAX(value, (SELECT COALESCE(MAX(seq), 0) FROM messages)) WHERE name =
  'messages_seq'`. The restore drill restores a full M8 export into a freshly migrated database
  and checks that the first INSERT afterwards gets a `seq` above every restored one.
- Deploy order: `migrate:prod` before `deploy:prod`, as for every migration; the runbook step for
  M8 says so.

### Folder rules

- `FOLDERS.spam = "spam = 1 AND trashed = 0"`, the same test the permanent delete uses.
  `FOLDERS.trash` stays `trashed = 1` with no Spam test, so a row with both flags (written by an
  M7 Worker after a rollback) shows in Trash, is counted there, and expires by Trash's rules,
  exactly as the cron already treats it (review 5, finding 2). Inbox, Sent, Starred and Archive
  gain `spam = 0`; so do search, the thread view outside Spam and Trash, and their unread
  counts.
- Rollback to M7 code leaves the columns in place. M7 ignores `spam`, so Spam mail shows in the
  Inbox and Archive as ordinary mail, and its writes follow M7's rules; nothing is lost. After
  redeploying M8 the folder tests above sort every flag combination into one folder. The runbook
  records this (review 4, finding 3).
- The contact scan keeps its read bound: it still takes the 2,000 most recent rows by its index,
  and drops Spam rows from that window afterwards, instead of reading further to fill the window
  (review 2, finding 7).
- The 30-day cron covers Spam as it covers Trash, with its own `spam_at` clock and the same
  delete function. The Spam list shows the same "deleted after 30 days" note.
- Before the routes are coded, a local D1 with 5,000 messages (10% Spam, 10% Trash), and a dense
  one with 5,000 messages all in Trash for a complete Empty, records the
  `EXPLAIN QUERY PLAN`, rows read and written, and latency of: the Inbox and Spam lists, the count
  route, a folder PATCH call, a purge call including the FTS delete, both cron expiry steps
  together with the backup step, and the contact scan. It also records the scheduled handler's
  binding calls and CPU time with both expiry steps and the export running, and a skewed run
  where the 2,000 newest messages are all Spam, and address-scoped purge and folder PATCH calls
  for an address with one matching row among 5,000 and with none, against an explicit budget of
  rows read per call (review 4, finding 6; the budget goes into `REQUIREMENTS.md` with the
  measurement). A query that becomes a table scan, or exceeds the budget, gets an index
  or a changed condition before review (review 1, performance note; review 2, finding 7).

### Filing

- The sender key has one input only: the bare addr-spec, lowercased, of the structured address
  the parser returns for `From`, before it is formatted into `from_hdr` (whose 998-character cut
  can lose the address after a long display name). The consumer stores it in a new column
  `from_key` when it saves the parse. The envelope sender is never a key, because a relay or
  bounce address would then block unrelated mail (review 2, finding 5; review 3, finding 2).
  A message not parsed, parsed before M8, or whose `From` has no address has no key; the
  migration does not backfill it.
- **Report spam** (toolbar, reader, bulk with ids; never offered in Sent) runs one D1 batch, a
  transaction: first `INSERT OR IGNORE INTO spam_senders (address, created_at) SELECT from_key,
  ?now FROM messages WHERE id IN (...) AND direction = 'in' AND spam = 0 AND from_key IS NOT
  NULL` (review 5, finding 4), then the flag UPDATE on
  the same rows. The INSERT reads the rows before they change, so only rows that actually enter
  Spam in this transaction add a key: a repeated report of a message already in Spam adds
  nothing, and a sent message never adds the owner's address (review 3, finding 2; review 4,
  finding 4). In "whole folder" mode the action is labelled **Move to Spam**, not Report spam:
  it sets the flag and adds no senders, and the label says so (review 6, finding 4).
- **Not spam** mirrors it: first a DELETE of the keys of the listed rows with `spam = 1`, then the
  UPDATE, so only rows that actually leave Spam forget their sender.
- Session API (decided in phase A). The ids form is the one that learns; the folder form changes
  flags only. Session routes only; v1 refuses `spam` (decision 5).

  | Route | Body | Effect |
  | --- | --- | --- |
  | `PATCH /api/messages/:id`, `PATCH /api/messages` with `ids` | `{ spam: true }` | Report spam: senders of inbound rows entering Spam are added, then the flag, in one batch. A request that also sets `trashed: true` goes to Trash and adds nothing. |
  | the same | `{ spam: false }` | Not spam: senders of rows leaving Spam are removed, then the flag, in one batch. |
  | `PATCH /api/messages` folder form | `{ folder, address?, watermark, after?, spam: true }` | Move to Spam: the flag only, no sender added. |
  | `GET /api/spam-senders` | | `{ senders: [{ address, createdAt }] }`, newest first, at most 1,000. |
  | `DELETE /api/spam-senders` | `{ address }` | Removes that sender; `{ removed: true \| false }`. Mail already in Spam stays there. |
- **Inbound**: `email()` does not look senders up; it has no parsed `From`. The consumer computes
  the `From` key; when it is listed and the message is in the Inbox, the UPDATE that saves the
  parse also sets `spam = 1` and `spam_at`. A message waits in the Inbox, unnotified, until the
  consumer runs, as it does today.
- The consumer sends a new Hub event `filed` with the id when its UPDATE moved the message into
  Spam. The existing `changed` event and its page refresh stay as they are, because a v1 bulk
  PATCH sends `changed` with its first id only (review 6, finding 3). A `filed` event makes the
  open page reconcile that id (review 4, finding 5; review 5, finding 5):
  - `useMessageList` bumps its generation, so a page fetch in flight is discarded, then reads the
    message (`GET /api/messages/:id`) and drops it if it no longer `belongs` to the view; a
    discarded scroll page is fetched again from its cursor;
  - the reader, when that id is open, reloads the message's flags; a message now in Spam stops
    loading remote images and shows the Spam actions.
- **Forged senders.** A spammer can forge a real sender's `From`; reporting that message files
  the real sender's later mail in Spam (review, finding 4). Kept under owner ruling 2, because
  such mail is filed, not dropped: it stays visible in Spam with an unread count for 30 days, and
  Not spam forgets the sender. Settings gets a "Spam senders" list with Remove, so a wrong entry
  is undone without finding a message.
- A rule action "Move to Spam" joins the rule editor beside "Move to Trash" (decision 6).
- Spam-filed mail sends no Web Push and no Telegram card. The consumer decides from the flags its
  final UPDATE returns (`RETURNING read, archived, trashed, spam`), not from the flags it read
  before the parse (review 1, finding 5). `markFailed` returns the same flags, so a message that
  fails to parse notifies as today; an UPDATE that changed no row notifies nothing (review 2,
  finding 6).
- No content scoring: MelodyMail has no spam score to read.

### UI

- Side navigation: Spam below Archive, above Trash, with its unread count.
- Spam list: Not spam, Delete forever, star and read state. Other folders: Report spam in the
  bulk bar on desktop and under More on phones and in the reader.
- The reader loads no remote images for a message in Spam, whatever the global setting.

## 5. Phone list layout

The owner's iPhone 17 Pro screenshot (2026-11-19, Starred, dark theme) shows a black band under
the content, a heavy title row, and a bulk bar with idle icons in an empty folder. All four
changes apply at `NARROW` only, except the first, which applies everywhere.

1. **Bottom band.** `html` and `body` get the theme's body background, and the shell reaches the
   bottom edge, so the home-indicator area shows the app's colour. The cause (no page background
   behind the 100dvh shell) is inferred from the code, not seen on a device.
2. **Compose and refresh.** The title row holds the folder name, then a Refresh icon button and a
   Select button. Compose becomes a floating button at the bottom right, above the safe area,
   with list padding so it never covers the last row. Pull to refresh is not built: it competes
   with native scrolling and the row gestures for the same touch, and the 402 px Chromium suite
   cannot prove its behaviour on iOS Safari (review 2, finding 8).
3. **Selection mode.** The bulk bar is hidden until selection mode. A long press (500 ms) on a
   row, or Select in the title row, enters it; the row checkboxes and the bar appear; Done or
   clearing the selection leaves it. Desktop keeps the always-shown bar
   (`web/src/mailbox/BulkBar.tsx`, "the list does not move on selection").
   - Gesture ownership on a row: the long-press timer and the swipe both start on `pointerdown`.
     Any movement over 10 px, `pointercancel` (native scrolling took the touch) or `pointerup`
     clears the timer. A horizontal movement then belongs to the swipe; a vertical one to the
     browser. A long press that fired ends the swipe for that touch.
   - Outside selection mode, Trash and Spam show a folder row above the list with the 30-day
     note and Empty Trash / Empty Spam (section 1).
   - Real iOS behaviour (scroll versus swipe versus long press) is checked by the owner on the
     device before merge; the browser suite covers the logic only.
4. **App bar.** Language and theme leave the phone app bar and go to the bottom of the drawer.
   This supersedes the post-launch ruling that put them in the app bar at every width for
   phones only; desktop keeps them.

Each is checked by screenshots at 402 px in both themes, sent to the owner before merge.

## Tests

Worker suite (real D1 and R2 in workerd):

- bulk delete: only rows in the named folder; FTS rows and R2 objects removed; 101 ids rejected;
  ids elsewhere skipped; a row moved out of the folder before the batch kept; audit row in the
  same batch;
- purge: at most 100 per call, `hasMore` reported, nothing above the watermark or outside the
  folder and address; after the newest rows are deleted, new mail gets a higher `seq` and is
  kept;
- folder PATCH: only rows at or below the watermark in that folder and address, at most 500 per
  call; marking 1,200 Inbox rows read finishes in three calls;
- count route and watermark; a row inserted after the watermark with an older `received_at` left
  alone; the trigger fills `seq` on both INSERT sites;
- v1: `PATCH` with `spam` answers 400; `archived`, `trashed` and `read` on a Spam id change
  nothing; `folder=spam` lists;
- consumer: a parse failure notifies as before; a Spam-filed message does not;
- transitions of decision 6, including Not spam on a stale archived flag landing in the Inbox;
- purge: a row filed into Spam after `asOf` with a `seq` below the watermark is kept;
- spam filing: Report spam on a parsed message stores the key with `created_at` and the flag in
  one batch; a repeated Report spam after the sender was removed adds nothing; Not spam on a
  row not in Spam removes nothing; Report spam adds the key, Not spam removes the same key; a
  long display name does not lose the key; Report spam on a sent id adds nothing; `email()`
  applies rules only; the consumer files mail from a listed sender; no push for spam-filed mail;
  the cron removes Spam older than 30 days and keeps a row moved out; outbound cannot be spam;
- v1: a folder-form `PATCH /messages` with a valid `mail:write` key answers 400;
- purge: `hasMore` without a count; a list fetch begun during the loop does not bring a row back
  (browser suite);
- migration 0016 on a database holding rows; export and restore keep `seq`, `from_key`, `spam`,
  `spam_at`, `spam_senders`, the counter and the rule action; the first INSERT after a restore
  gets a higher `seq`; an export whose columns change mid-run starts again (local restore drill
  as in M7).

Browser suite: Empty Trash with confirmation; select all matching then archive; on the 402 px
project, swipe right archives, swipe left trashes, long press enters selection mode, a vertical
drag neither swipes nor selects, the floating Compose opens compose, and Empty Trash is reachable
outside selection mode; Report spam and Not spam; an Inbox row the consumer files into Spam
leaves the open list.

Each behaviour hunk is ablated (High risk). The review is by a different model family.

## Not in scope

- Spam scoring of content, Bayesian learning, or external blocklists.
- Select all in search results.
- Undo toasts and undo for permanent delete.
- Pull to refresh (section 5).
- Swipe on desktop, tablets or with a mouse.
- The FTS delete by `message_id` (an UNINDEXED column, so a scan of `messages_fts`) predates M8;
  the measurement decides whether it needs work, otherwise it goes to the deferred list.
