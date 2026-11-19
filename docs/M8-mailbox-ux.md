# M8: mailbox behaviour of a mail client

Risk class: High. The change adds permanent bulk deletion, a migration (0016) and a change to how
inbound mail is filed. The owner asked for it on 2026-11-19: Trash had no bulk or full delete,
and the app "does not feel like mail". The owner chose four items: bulk delete and Empty Trash,
select all matching messages, swipe actions on phones, and a Spam folder.

This plan is reviewed before coding (`AGENTS.md`, "Change risk").

## Decisions

1. Permanent delete stays limited to mail that is already in Trash or Spam. Nothing outside those
   two folders is ever deleted by these routes.
2. Spam is a flag of its own, not a folder column. A message in Spam is out of every other folder,
   out of search, out of contact suggestions and out of the unread counts except Spam's own.
3. Bulk changes by folder are bounded by a snapshot: the client sends the newest row it has seen,
   and mail that arrives later is never changed or deleted by a "select all" it did not see.
4. Swipe actions are a phone convenience. Each one duplicates a toolbar action, so nothing is
   reachable only by gesture.
5. The REST API v1 gains the `spam` flag and `folder=spam` (shared handlers). It gains no delete
   route: an API key still cannot destroy mail (docs/M6-rules-api.md).

## 1. Bulk permanent delete and Empty Trash

### API

| Route | Body or query | Result |
| --- | --- | --- |
| `DELETE /api/messages` | `{ ids }`, 1 to 100 (`BULK_MAX`) | Deletes the listed messages that are in Trash or Spam. Returns `{ deleted }` (the count). Ids outside those folders are skipped, not an error. More than 100 ids: 400 `too_many_ids`. |
| `POST /api/messages/purge` | `{ folder: "trash" \| "spam", upTo }` | Deletes up to `PURGE_MAX` (100) messages of that folder at or below the `upTo` keyset, oldest first. Returns `{ deleted, remaining }`. The client calls it again while `remaining > 0`. |

- Both go through `deleteFromTrash` (renamed `deletePermanently`, with the folder test widened to
  `trashed = 1 OR spam = 1`): FTS rows and rows in one D1 batch, then one R2 delete of the keys.
  The order stays: a failed R2 delete leaves an orphan object, never a row without its raw mail.
- `PURGE_MAX` 100 keeps one call to one D1 batch and one R2 delete (the cron's existing bound,
  `TRASH_EXPIRE_MAX`), well inside the Workers Free subrequest limit.
- Each call writes one audit row: `messages_deleted` with the count, or `trash_emptied` /
  `spam_emptied` with the count.
- `upTo` is the `(received_at, id)` cursor of the newest row the client loaded, in the existing
  cursor format. A message moved into Trash after the confirmation can still have an older
  `received_at`; it is deleted too. Accepted: the owner confirmed emptying the folder, and the
  snapshot only exists to spare new arrivals in Spam.
- Session routes only; no v1 route (decision 5).

### UI

- In Trash and Spam, the bulk bar gets "Delete forever" for the selection.
- The Trash and Spam toolbars get "Empty Trash" / "Empty Spam" in the end slot, next to the
  30-day note. It is shown when the folder is not empty.
- Both open the existing confirm dialog (`ConfirmDialog` as in the settings pages) with the count
  and "This cannot be undone". Empty shows a progress count while it loops and can be cancelled
  between calls; what was deleted stays deleted.
- After success the list reloads (Empty) or drops the rows (Delete forever), the counts refresh,
  and a toast says how many were deleted.
- The reader's single delete keeps its route (`DELETE /api/messages/:id`), now also allowed for
  Spam.

## 2. Select all matching messages

Today the header checkbox selects the loaded rows only (at most 50 per page, more after
scrolling).

### API

- `GET /api/messages/count?folder=&address=` returns `{ total }`, the number of rows in that view.
  One indexed `COUNT(*)` on the same `FOLDERS` condition.
- `PATCH /api/messages` accepts, instead of `ids`, `{ folder, address?, upTo, ...flags }`. One
  `UPDATE ... WHERE <folder condition> AND <keyset at or below upTo>`. No row cap: it is one
  statement on an indexed condition. The answer is `{ updated }`.
- Search results are not covered: an FTS view has no stable count without running the full
  match, and the owner did not ask for it. The banner is not offered in search.

### UI

- When the header checkbox selects every loaded row and more rows exist (`nextCursor` set), the
  bulk bar shows "All 50 loaded messages are selected. Select all N in Inbox". N comes from the
  count route when the banner first shows.
- Choosing it switches the selection to "whole folder" mode: the bar reads "All N messages in
  Inbox are selected. Clear selection", and each bulk action sends the folder form. In Trash and
  Spam, Delete forever in this mode runs the purge loop of section 1.
- Any change of folder, address or search, a reload, or unchecking any row leaves the mode.
- New mail arriving while the mode is on is shown but not included (the `upTo` snapshot).

## 3. Swipe actions on phones

- Only under a coarse pointer and below the side-by-side width (`NARROW`). Desktop is unchanged.
- Swipe right on a row: Archive (in Archive: Move to Inbox; in Trash: Restore; in Spam: Not spam).
  Swipe left: Move to Trash (in Trash and Spam: nothing, so a gesture can never delete forever).
- Pointer events on the row, no new dependency. The row follows the finger horizontally once the
  movement is mostly horizontal (|dx| > |dy| and |dx| > 10 px), so vertical scrolling is not
  captured. Past 40% of the row width the action is armed (icon and colour change); release
  commits, otherwise the row springs back. `touch-action: pan-y` on the row.
- Reduced motion: no slide animation; the row is removed at once.
- The action goes through the same `act()` path and toast as the toolbar. Trash and Archive toasts
  get an Undo button that reverts the flags (a flag change is reversible; delete is not offered).
- A row being swiped never opens the message on release.

## 4. Spam folder

### Data

Migration 0016 adds to `messages`:

- `spam INTEGER NOT NULL DEFAULT 0`;
- `spam_at INTEGER` (when the message entered Spam; NULL outside it);
- index `messages_spam_received` on `(spam, received_at DESC, id DESC)` for the Spam list.

And a table `spam_senders (address TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`, the senders the
owner reported. The migration is additive and safe on a database that holds rows. The backup
table list (`worker/src/backup/tables.ts`) gains the new columns and table.

### Folder rules

- `FOLDERS.spam = "spam = 1"`. Every other folder condition gains `spam = 0`; so do search, the
  contact scan, the thread view outside Spam, and the unread counts. The existing folder index
  keeps serving the inbox list: `spam = 0` is a filter on few rows, not a scan. The plan measures
  the Inbox list query plan before and after (`EXPLAIN QUERY PLAN`) and records it.
- Spam excludes Trash and Archive: setting `spam = 1` also sets `trashed = 0`, `archived = 0` and
  clears `trashed_at`. Setting `trashed = 1` on a Spam message clears `spam` (Trash wins, as it
  does over Archive for rules).
- Outbound mail cannot be marked spam (the UPDATE skips `direction = 'out'`).
- The 30-day cron clean-up covers Spam as it covers Trash, through the same delete function, with
  its own `spam_at` clock. The Spam folder shows the same "deleted after 30 days" note.

### Filing

- **Report spam** (toolbar, reader, bulk): sets the flag and adds the sender's address (the
  `From` address, else the envelope sender, lowercased) to `spam_senders`. In "whole folder" mode
  the flag is set but no senders are added (no list of senders exists without reading every row).
- **Not spam**: clears the flag, which returns the message to the Inbox, and removes its sender
  from `spam_senders`.
- **Inbound**: before the INSERT, `email()` looks the envelope sender up in `spam_senders` (one
  indexed read, the same invocation that already reads the address and the rules). A match files
  the new message with `spam = 1`. The queue consumer later fills `from_hdr`; when that address is
  in `spam_senders` and the message is still in the Inbox, it sets `spam = 1` in its existing
  UPDATE.
- A rule action "Move to Spam" joins the rule editor, beside "Move to Trash". Trash beats Spam,
  Spam beats Archive.
- Spam-filed mail sends no Web Push and no Telegram card, as rule-filtered mail does today
  (`consumer.ts`, `filtered`).
- No content scoring. Cloudflare Email Routing already rejects mail that fails DMARC with a reject
  policy; MelodyMail has no spam score to read.

### UI

- Side navigation: Spam below Archive, above Trash, with its unread count.
- Spam toolbar: Not spam, Delete forever, star and read state. Other folders: "Report spam" in the
  bulk bar (desktop) and under More (phone and reader).
- The reader does not load remote images for a message in Spam, whatever the global setting.
  Links still open with the existing warning.

## Tests

Worker suite (real D1 and R2 in workerd):

- bulk delete: deletes only Trash and Spam rows, removes FTS rows and R2 objects, rejects 101 ids,
  skips ids elsewhere;
- purge: deletes at most 100 per call, reports `remaining`, never deletes a row above `upTo`,
  never touches other folders;
- folder PATCH: changes only rows at or below `upTo` in that folder and address;
- count route;
- spam: folder conditions exclude it everywhere listed; report spam adds the sender; Not spam
  removes it; inbound from a listed sender is filed as spam by `email()` and by the consumer; no
  push for spam-filed mail; the cron removes Spam older than 30 days; outbound cannot be spam;
  Trash clears spam;
- migration 0016 on a database holding rows.

Browser suite: Empty Trash with confirmation; select all matching then archive; swipe right
archives and swipe left trashes on the 402 px phone project; report spam and Not spam.

Each behaviour hunk is ablated (High risk). The review is by a different model family.

## Not in scope

- Spam scoring of content, Bayesian learning, or external blocklists.
- Select all in search results.
- Undo for permanent delete (there is no soft step after Trash).
- Swipe on desktop or with a mouse.
