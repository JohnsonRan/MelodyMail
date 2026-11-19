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
3. Bulk changes by folder are bounded by a server-issued watermark, `MAX(rowid)` of `messages`
   when the count was read. Mail stored after the confirmation is never changed or deleted by a
   "select all" it did not see. `received_at` cannot serve: `email()` takes it before the R2
   write (`worker/src/mail/inbound.ts`), so a slower message can commit later with an older time
   (review, finding 2). `rowid` grows with each INSERT; it is reused only when the newest row was
   itself deleted, which at worst includes one message the owner did not see.
4. Swipe actions are a phone convenience. Each one duplicates a toolbar action, so nothing is
   reachable only by gesture.
5. The REST API v1 can read Spam (`folder=spam`, the `spam` field) but cannot write it, and gains
   no delete route. Session and v1 PATCH get separate flag parsers; v1 keeps its four flags
   (review, finding 3). A `mail:write` key can still move mail to Trash, which the cron empties
   after 30 days; that is unchanged from M7.
6. One transition policy, shared by `updateMessageFlags`, the rule decision and inbound filing
   (review, finding 5):
   - entering Spam sets `archived = 0`, `trashed = 0`, `trashed_at = NULL`, `spam_at = now`;
   - entering Trash or Archive leaves Spam (`spam = 0`, `spam_at = NULL`); when a request or the
     rules set several, Trash beats Spam and Spam beats Archive;
   - Not spam sets `spam = 0` and `archived = 0`, so the message lands in the Inbox;
   - a clock (`trashed_at`, `spam_at`) is set only on entry and kept while the message stays;
   - outbound rows never enter Spam.

## 1. Bulk permanent delete and Empty Trash

### API

| Route | Body | Result |
| --- | --- | --- |
| `DELETE /api/messages` | `{ folder: "trash" \| "spam", ids }`, 1 to 100 ids (`BULK_MAX`) | Deletes the listed messages that are in that folder now. Returns `{ deleted: [ids] }`. Ids elsewhere are skipped, not an error. More than 100 ids: 400 `too_many_ids`. |
| `POST /api/messages/purge` | `{ folder: "trash" \| "spam", address?, watermark }` | Deletes up to `PURGE_MAX` (100) messages of that folder and address with `rowid <= watermark`, oldest first. Returns `{ deleted: [ids], remaining }`. The client calls again while `remaining > 0`. |

- Both go through `deleteFromTrash`, renamed `deletePermanently(env, folder, ids, opts)`. Both
  DELETE statements of its batch repeat the exact condition: the folder's own test (`trashed = 1`,
  or `spam = 1 AND trashed = 0`), the address and watermark when given, and for the cron the
  folder's own clock. A row moved to another folder between the SELECT and the batch is kept
  (review, finding 1). FTS rows and rows go in one D1 batch, then one R2 delete of the keys; a
  failed R2 delete leaves an orphan object, never a row without its raw mail.
- `PURGE_MAX` 100 keeps one call to one D1 batch and one R2 delete, the cron's existing bound
  (`TRASH_EXPIRE_MAX`).
- Each call writes one audit row: `messages_deleted`, `trash_emptied` or `spam_emptied`, with the
  count.
- The watermark comes from the count route (section 2) when the confirm dialog opens. A message
  stored before it but moved into Trash or Spam after the confirmation is deleted too. Accepted:
  the owner confirmed emptying the folder; the watermark spares mail that arrived later,
  including new mail filed into Spam.
- Session routes only (decision 5).

### UI

- In Trash and Spam, the bulk bar gets "Delete forever" for the selection.
- The Trash and Spam lists get "Empty Trash" / "Empty Spam" next to the 30-day note, shown when
  the folder is not empty.
- Both open the existing confirm dialog with the count and "This cannot be undone". Empty shows a
  progress count while it loops and can be cancelled between calls; what was deleted stays
  deleted.
- The list drops exactly the ids the server returned, and the toast counts those, after success,
  a partial failure or a cancel. A list request started before the action is discarded when it
  answers (a view generation counter in `useMessageList`), so an old page cannot bring deleted
  rows back (review, finding 6). The counts refresh.
- The reader's single delete keeps `DELETE /api/messages/:id`, now also allowed in Spam.

## 2. Select all matching messages

Today the header checkbox selects the loaded rows only (50 per page, more after scrolling).

### API

- `GET /api/messages/count?folder=&address=` returns `{ total, watermark }`: `MAX(rowid)` and the
  rows of that view with `rowid <= watermark`, in one D1 batch.
- `PATCH /api/messages` accepts, instead of `ids`, `{ folder, address?, watermark, ...flags }`. It
  updates at most `FOLDER_PATCH_MAX` (500) matching rows per call and returns
  `{ updated, remaining }`; the client loops like the purge. The cap bounds the rows one
  invocation writes (review, performance note).
- Search results are not covered (owner ruling 4).

### UI

- When the header checkbox selects every loaded row and more rows exist (`nextCursor` set), the
  bulk bar shows "All 50 loaded messages are selected. Select all N in Inbox".
- Choosing it switches to "whole folder" mode: "All N messages in Inbox are selected. Clear
  selection". Each bulk action sends the folder form with that count's watermark; in Trash and
  Spam, Delete forever runs the purge loop. A loop shows progress and can be cancelled.
- A change of folder, address or search, a reload, or unchecking a row leaves the mode.
- New mail arriving while the mode is on is shown but not included (the watermark).

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
database that holds rows. The backup table list (`worker/src/backup/tables.ts`) gains the new
columns and table.

### Folder rules

- `FOLDERS.spam = "spam = 1"`. Every other folder condition gains `spam = 0`; so do search, the
  contact scan, the thread view outside Spam, and the unread counts.
- The 30-day cron covers Spam as it covers Trash, with its own `spam_at` clock and the same
  delete function. The Spam list shows the same "deleted after 30 days" note.
- Before the routes are coded, a local D1 with 5,000 messages (10% Spam, 10% Trash) records the
  `EXPLAIN QUERY PLAN`, rows read and written, and latency of: the Inbox and Spam lists, the count
  route, a folder PATCH call, a purge call including the FTS delete, both cron expiry steps
  together with the backup step, and the contact scan. A query that becomes a table scan gets an
  index or a changed condition before review (review, performance note).

### Filing

- The sender key is one canonical form: the bare addr-spec, lowercased, of the parsed `From`;
  for a message not parsed yet, of the envelope sender. One function computes it for Report spam,
  Not spam, `email()` and the consumer, so the stored key is the key that is looked up and
  removed. It is never the display text of `from_hdr` (review, finding 4).
- **Report spam** (toolbar, reader, bulk with ids) sets the flag and adds each sender's key to
  `spam_senders`. In "whole folder" mode it sets the flag and adds no senders.
- **Not spam** clears the flag (decision 6) and removes each sender's key.
- **Inbound**: before the INSERT, `email()` looks the envelope sender's key up in `spam_senders`
  (one indexed read). A match files the message with `spam = 1`. The consumer computes the `From`
  key; when it is listed and the message is in the Inbox, the UPDATE that saves the parse also
  sets `spam = 1` and `spam_at`.
- **Forged senders.** A spammer can forge a real sender's `From`; reporting that message files
  the real sender's later mail in Spam (review, finding 4). Kept under owner ruling 2, because
  such mail is filed, not dropped: it stays visible in Spam with an unread count for 30 days, and
  Not spam forgets the sender. Settings gets a "Spam senders" list with Remove, so a wrong entry
  is undone without finding a message.
- A rule action "Move to Spam" joins the rule editor beside "Move to Trash" (decision 6).
- Spam-filed mail sends no Web Push and no Telegram card. The consumer decides from the flags its
  final UPDATE returns (`RETURNING read, archived, trashed, spam`), not from the flags it read
  before the parse (review, finding 5).
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
2. **Compose and refresh.** The title row keeps the folder name only. Compose becomes a floating
   button at the bottom right, above the safe area and clear of the last row. Refresh becomes
   pull to refresh on the list (pointer events, a threshold, the existing `reload()`); the
   `ArrowPath` button stays reachable from the drawer for devices where pull is awkward.
3. **Selection mode.** The bulk bar is hidden until selection mode. A long press (500 ms without
   movement) on a row, or "Select" in the title row, enters it; the row checkboxes and the bar
   appear; "Done" or clearing the selection leaves it. Desktop keeps the always-shown bar
   (`web/src/mailbox/BulkBar.tsx`, "the list does not move on selection").
4. **App bar.** Language and theme leave the phone app bar and go to the bottom of the drawer.
   This supersedes the post-launch ruling that put them in the app bar at every width for
   phones only; desktop keeps them.

Each is checked by screenshots at 402 px in both themes, sent to the owner before merge.

## Tests

Worker suite (real D1 and R2 in workerd):

- bulk delete: only rows in the named folder; FTS rows and R2 objects removed; 101 ids rejected;
  ids elsewhere skipped; a row moved out of the folder before the batch kept;
- purge: at most 100 per call, `remaining` reported, nothing above the watermark or outside the
  folder and address;
- folder PATCH: only rows at or below the watermark in that folder and address, at most 500 per
  call;
- count route and watermark; a row inserted after the watermark with an older `received_at` left
  alone;
- v1: `PATCH` with `spam` answers 400; `folder=spam` lists;
- transitions of decision 6, including Not spam on a stale archived flag landing in the Inbox;
- spam filing: Report spam adds the key, Not spam removes the same key; inbound from a listed
  sender is filed by `email()` and by the consumer; no push for spam-filed mail; the cron removes
  Spam older than 30 days and keeps a row moved out; outbound cannot be spam;
- migration 0016 on a database holding rows; export and restore keep `spam`, `spam_at`,
  `spam_senders` and the rule action (local restore drill as in M7).

Browser suite: Empty Trash with confirmation; select all matching then archive; on the 402 px
project, swipe right archives, swipe left trashes, long press enters selection mode, the floating
Compose opens compose, and pull to refresh reloads; Report spam and Not spam.

Each behaviour hunk is ablated (High risk). The review is by a different model family.

## Not in scope

- Spam scoring of content, Bayesian learning, or external blocklists.
- Select all in search results.
- Undo toasts and undo for permanent delete.
- Swipe on desktop, tablets or with a mouse.
- The FTS delete by `message_id` (an UNINDEXED column, so a scan of `messages_fts`) predates M8;
  the measurement decides whether it needs work, otherwise it goes to the deferred list.
