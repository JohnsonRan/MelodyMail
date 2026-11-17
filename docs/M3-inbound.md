# M3: inbound mail design

Risk class: High (stored data, mail delivery, a migration). Read `AGENTS.md`, `worker/AGENTS.md`,
`REQUIREMENTS.md`, `docs/PLAN.md` (sections 2, 4, 6, 7, 8), `docs/STATE.md` (owner rulings for M1
and M2) and `docs/M1-auth.md` first. This file decides the M3 design. Record deviations under
"Open questions" in `docs/STATE.md`; do not make them silently in code.

## Constraints

- Workers Free: 10 ms CPU per invocation, queue consumers included; 50 subrequests per invocation;
  D1 50 queries per invocation; Queues 10,000 operations a day with 24-hour retention, 128 KB per
  message.
- The Worker never does JS work that grows with the size of a message (PLAN, "CPU budget"). Full
  MIME parsing happens in the browser in M4.
- Owner rulings of 2026-11-16 (answers to the M3 open questions, recorded in `docs/STATE.md`)
  changed storage failures, the parse window, retries and search; this file describes the result.
- Only addresses added in the panel receive mail (owner ruling). Everything else is rejected
  before anything is stored.
- Never log mail content, subjects or full addresses. Log message ids and address ids only.

## The `email()` handler

Order matters, because a thrown error makes the sending server retry the whole message.

1. **Recipient.** Take the envelope recipient (`message.to`), lowercase it, and split it into local
   part and domain. If the local part contains `+`, the part before the first `+` is the address
   and the rest is the sub-address tag. Sub-addressing is always on in M3; the settings switch
   arrives with the settings page in M6.
2. **Lookup.** One indexed query on `addresses (domain, local_part)` joined to `domains`. Reject
   with `message.setReject("Address not found")` when the address does not exist, is disabled, or
   its domain has receiving switched off. Nothing is stored for a rejected message.
3. **Loop guard.** If the message carries the header `X-MelodyMail-Forwarded`, skip forwarding for
   it. A forward-only address then keeps a copy instead, so the message is never dropped.
4. **Forward-only addresses.** Call `message.forward(target, headers)` for each distinct target
   (owner ruling: a forward-only address always has at least one target). Add the header
   `X-MelodyMail-Forwarded: 1`. Record the outcome in `audit_log` with the address id and the
   number of targets that succeeded; no content. If every forward failed, store the message as
   below, so it is not lost.
5. **Storage.** For every other address:
   1. Generate the message id (`crypto.randomUUID()`).
   2. Stream `message.raw` into R2 at `raw/{yyyy}/{mm}/{id}.eml`. Use a `FixedLengthStream` of
      `message.rawSize`, so the bytes are piped natively and not read in JS.
   3. Insert the `messages` row with status `stored`, the address id, envelope sender, envelope
      recipient, sub-address tag, raw size, R2 key and received time.
   4. If either step throws and the address has targets (and no loop header), forward to them
      instead, write the audit row `mail_forwarded_unstored` (address id, counts, and the key of
      an R2 object already written, for a later orphan sweep), and return. Nothing is stored, so
      no later step forwards again. Throw when no forward goes out: no targets, the loop
      header, a forward-only address whose forwards all failed, or every fallback forward
      failing. A thrown error most likely reaches the sender as a permanent 521 (see below).
6. **Forward and keep.** After the row exists, forward to the address's default targets with the
   same header. A failing `forward()` is caught, logged at warn and recorded on the row
   (`forward_failed` count). It never makes the handler throw, so a retry cannot forward twice.
7. **Enqueue.** Send `{ id }` to the inbound queue. If sending fails, log and return; the cron
   step below re-enqueues it.

Two Cloudflare facts, checked on 2026-11-16 and cited in `worker/src/mail/inbound.ts`:
`forward()` works after `message.raw` has been read (the official local-development example
does it), so the order above holds. What a thrown error does at the sending server is not
documented; community reports describe a permanent "521 5.3.0 Upstream error", which is why a
storage failure forwards instead where it can (step 5.4).

Rule-based forwarding needs the rules table and its editor, which belong to M6. M3 forwards to the
address's default targets only. Leave one clear place in the code where M6 adds rule targets.

## The queue consumer

For each message in the batch:

1. Count the try: increment `attempts` on the row in its own write, before anything else, so a
   try the CPU limit kills still counts. Skip the job if the row is not `stored`, so a duplicate
   delivery is harmless. A row past 5 attempts becomes `parse_failed` without a parse.
2. Read only the first 64 KB of the R2 object (range read).
3. Run one bounded parse over that slice with `postal-mime` (at most 50 MIME parts, 64 KB of
   headers, nesting depth 32; over a limit the parse throws):
   - headers: Message-ID, In-Reply-To, References, Subject, From, To, Cc, Date;
   - `has_attachments`: true if the top-level type is `multipart/mixed` or the slice shows an
     attachment part;
   - text for search and the snippet: the first text part, or the first HTML part reduced to text,
     cut to 8 KB.

   A truncated slice must not fail the parse. A message whose text starts after 64 KB is
   `parsed` with an empty snippet and no search text; `has_attachments` comes from what the
   slice shows. If the parse throws, set status `parse_failed` and keep the row: the browser
   can still parse the raw message in M4. The HTML reduction is one forward scan, linear in
   the input, because the HTML comes from the sender.
4. Compute `thread_key`: the first id in References, else In-Reply-To, else the message's own
   Message-ID, else the message id.
5. In one D1 batch, update the row (headers, snippet of up to 200 characters, `has_attachments`,
   `thread_key`, status `parsed`) and insert the FTS row (subject, sender, text).
6. Ack. On a transient error (D1 or R2 unavailable), call `retry()` with a delay of 60 s,
   unless this was the fifth try: then set `parse_failed` and ack.

The Durable Object notification arrives with the mail UI in M4.

## The cron trigger

One Cron Trigger every 15 minutes. It sets `parse_failed` on messages still `stored` after 15
minutes that used their 5 tries, and re-enqueues the other messages still `stored` after 15
minutes, oldest first, at most 100 per run in one `sendBatch`. Messages are not lost when a queue message expires after 24
hours on the Free plan, because the raw mail is already in R2. M7 added the Trash clean-up and the
D1 export to the same trigger; the R2 orphan sweep is deferred (M7 owner ruling 3, 2026-11-17),
because it would delete raw objects the gap tool needs after a restore.

## Data (migration 0005)

- `messages`: id (text, primary key); address_id; direction (`in` now, `out` from M5); status
  (`stored`, `parsed`, `parse_failed`); envelope_from; envelope_to; subaddress_tag; message_id_hdr;
  in_reply_to; references_hdr; thread_key; subject; from_hdr; to_hdr; cc_hdr; date_hdr; snippet;
  raw_size; has_attachments; r2_key; forward_failed; flags (read, starred, archived, trashed as
  separate integer columns); received_at; attempts (migration 0006, default 0).
- Indexes: (address_id, received_at DESC); (status, received_at) for the cron query; (thread_key).
- `messages_fts`: FTS5 with the trigram tokenizer over subject, sender and text, keyed by the
  message id. The text lives only in the FTS index, not in `messages`. A whole-database
  `wrangler d1 export` fails while it exists; backups export table by table (M7).
- Search (`worker/src/mail/search.ts`, used by M4): terms of 3 or more characters form one
  `MATCH` of quoted phrases; shorter terms (a 2-character Chinese word) each add an escaped
  `LIKE` over subject, sender and body; every term must match.
- Keep the migration additive and safe on a database that already holds rows.

## Bindings

- R2 bucket `MAIL` and queue `melodymail-inbound` (producer and consumer). Find out whether
  `wrangler deploy` provisions queues on its own. If it does not, document the create command in
  the README.
- One cron trigger, `*/15 * * * *`.
- The consumer sets `max_batch_size` 1 and `max_retries` 5; dead-letter handling is not needed,
  because the cron step recovers stuck messages.

## Proof the change needs (High risk)

- Integration tests in workerd with real D1, R2 and Queues:
  - unknown, disabled and domain-off recipients are rejected and nothing is stored;
  - sub-address matching stores the tag;
  - case-insensitive recipients;
  - a forward-only address forwards to each target once and stores nothing;
  - a forward-only address with the loop header stores instead;
  - a forward-only address whose forwards all fail stores instead;
  - store-and-forward stores, forwards once, and records a failing forward without throwing;
  - an R2 or D1 failure throws before any forward;
  - a queue send failure leaves the row `stored`, and the cron step re-enqueues it;
  - the consumer parses and is idempotent on redelivery;
  - a broken message becomes `parse_failed`;
  - an FTS row is written and found by `MATCH`.
- Fixtures, small ones committed and large ones generated in the test:
  - plain text, HTML only, multipart/alternative, multipart/mixed with an attachment;
  - a 20 MiB message (raw; a 20 MiB decoded attachment would exceed the 25 MiB inbound limit);
  - charsets GBK, GB18030, Big5, ISO-2022-JP, Shift_JIS and EUC-JP;
  - quoted-printable and base64 bodies;
  - RFC 2047 encoded-word subjects in Chinese and Japanese;
  - a message with no subject, malformed boundaries, and a header-only message.
- A Bun benchmark of the bounded parse over the 64 KB slice of each fixture, the 20 MiB message,
  crafted MIME shapes and adversarial HTML: p95 under 3 ms for every input. Recorded in
  `REQUIREMENTS.md`; run by hand and checked in review.
- Ablation of every behaviour hunk, with results in `docs/STATE.md`.
- Not verifiable locally, so record as unverified: real Email Routing delivery; `forward()` to a
  real verified destination, including the M2 note about a destination verified in mixed case;
  production `cpuTime`.
