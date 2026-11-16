# M5: sending mail through Resend

Risk class: High. The change sends mail to the outside world under the owner's domains, adds two
public endpoints (the Resend webhook and the signed attachment URL), two Worker secrets and an
HMAC key, and new tables. Read `AGENTS.md`, `worker/AGENTS.md`, `web/AGENTS.md`,
`web/ASTRYX.md`, `REQUIREMENTS.md`, `docs/PLAN.md` (sections 2, 3, 4, 7, 8), `docs/STATE.md`
(owner rulings M1–M4b) and `docs/M4-mailbox.md` first. This file decides the M5 design. Record
deviations under "Open questions" in `docs/STATE.md`, M5.

## Scope

Compose, reply, reply all and forward; attachments; drafts; idempotent sending; delivery status
from the Resend webhook; Sent and Drafts folders; the quota display. Out of scope: rich-text
editing (see open questions), signatures, scheduled sending, open and click tracking, contacts.

## Resend facts (checked 2026-11-16, resend.com/docs)

- `POST https://api.resend.com/emails` with `from`, `to`, `cc`, `bcc`, `reply_to`, `subject`,
  `text`, `html`, `headers` (custom headers such as `In-Reply-To` and `References`) and
  `attachments` (`filename` plus `content` or `path`; at most 40 MB per email after base64).
- `Idempotency-Key` header: at most 256 characters, kept 24 hours.
- Rate limit 10 requests per second per team; `429` with `ratelimit-*` and `retry-after`.
- Free plan quotas: 100 per UTC day, 3,000 per month. Every response carries
  `x-resend-daily-quota` and `x-resend-monthly-quota` (used counts). Over quota: `429` with
  `daily_quota_exceeded` or `monthly_quota_exceeded`.
- Webhooks are signed with Svix headers (`svix-id`, `svix-timestamp`, `svix-signature`); retries
  keep the same `svix-id`. Events used here: `email.sent`, `email.delivered`,
  `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`,
  `email.suppressed`. Free plan: one webhook endpoint.

## Libraries (owner preference: maintained libraries over own code)

- **Resend client:** the official `resend` SDK if it runs in workerd without `nodejs_compat` and
  passes the `Idempotency-Key` and reads the quota headers we need. Otherwise call the one
  endpoint with `fetch` and record why.
- **Webhook signature:** the official verification (`resend` SDK `webhooks.verify`, or `svix` /
  `standardwebhooks`) if it runs in workerd without `nodejs_compat`. Otherwise Web Crypto
  HMAC-SHA256 per the Svix scheme, with Svix's published test vector in a test.
- Check last release, license, dependencies and Worker bundle size for each; pin exact versions;
  record choices in STATE.

## Data (migration 0009)

- `messages` gains outbound use: `direction = 'out'`, a status set extended with `sending`,
  `sent`, `delivered`, `delayed`, `bounced`, `complained`, `failed`; new columns
  `resend_id` (unique, nullable), `idempotency_key` (unique, nullable), `cc_hdr`, `bcc_hdr`,
  `error` (a short code, never upstream text). The CHECK or enum in the schema follows.
- The sent copy goes to R2 as JSON (`sent/{yyyy}/{mm}/{id}.json`: from, to, cc, bcc, subject,
  text, html, headers, attachment list with upload ids, names, types, sizes). Resend returns no
  raw MIME, so the reader renders outbound messages from this JSON, not through postal-mime. The
  FTS row is written from subject, recipients and text.
- `drafts`: id, address id, to/cc/bcc, subject, text, reply/forward source message id, thread
  headers, attachment upload ids, `idempotency_key`, `updated_at`. Autosave is debounced (at
  least 2 s) to stay far below D1's 100k writes per day.
- `uploads`: id, R2 key, filename, content type, size, created_at, `draft_id` (nullable). Uploads
  not attached to a sent message or a live draft are removed by the existing cron after 24 h.
- `webhook_events`: `svix_id` primary key, received_at; rows older than 7 days are removed by the
  cron. This is the replay guard.
- `send_quota`: one row with the last seen daily and monthly used counts and the time seen.

## Routes

| Route | Auth | Behaviour |
| --- | --- | --- |
| `GET /api/send/from` | session | Addresses whose domain has `send_enabled`, with display names. |
| `PUT /api/uploads` | session | Streams the body into R2 natively (no JS work), with `X-Filename` and `Content-Type`. Limit per file 25 MiB; total per message 30 MiB raw (40 MB after base64). Returns the upload id. |
| `GET /api/uploads/:id/blob?exp=&sig=` | public, HMAC | For Resend to fetch an attachment. `sig` = HMAC-SHA256 over `id` and `exp` with `UPLOAD_URL_KEY`; valid 24 h, as long as Resend keeps an idempotency key; `exp` is fixed when the sent copy is prepared and stored in it, so every attempt sends the same body; constant-time compare; streams the R2 object as `application/octet-stream`. |
| `DELETE /api/uploads/:id` | session | Removes an upload not yet sent. |
| `GET/PUT/DELETE /api/drafts[/:id]` | session | Draft CRUD; list for the Drafts folder. |
| `POST /api/messages/send` | session | Body: from address id, to/cc/bcc, subject, text, html (optional), reply-to message id or forward source, upload ids, `idempotencyKey`. See "Sending". |
| `GET /api/send/quota` | session | Last seen counts and the plan limits (100/day, 3,000/month, configurable vars). |
| `POST /api/webhooks/resend` | public, Svix | See "Webhook". |

Every session route is in the authz route walk; the two public routes carry the `publicRoute`
marker with a reason, and the walk asserts that nothing else is public.

## Sending

1. Validate: the `from` address exists, is enabled and its domain has `send_enabled`; at most 50
   recipients in total; each a syntactically valid address; subject at most 998 bytes; uploads
   exist and total within the limit; header values carry no CR or LF.
2. Idempotency: `INSERT INTO messages (... status 'sending', idempotency_key ...) ON CONFLICT
   (idempotency_key) DO NOTHING`. If the row already existed:
   - `sent` or later: return it (200), no second call;
   - `sending` and younger than 60 s: return 409 `send_in_progress` (a concurrent submit);
   - `failed`, or `sending` older than 60 s: call Resend again with the same key, so Resend's own
     24-hour idempotency guarantees one email.
3. Call Resend once with `Idempotency-Key` = the client's key. Thread headers for replies:
   `In-Reply-To` = the source's Message-ID, `References` = the source's References plus its
   Message-ID; subject gets `Re:` / `Fwd:` once. Attachments go as `path` = the signed URL.
4. On 200: store `resend_id`, status `sent`, write the R2 JSON copy and the FTS row, update the
   quota row from the headers, delete the draft, notify the Hub (`{ id }`, as for new mail).
5. On 429 quota, 4xx validation, 5xx or network error: status `failed` with a short error code;
   the UI shows the reason and a Retry that reuses the same key. Upstream error text never reaches
   the client or the logs (log the status and the Resend error `name` only).
6. CPU: one fetch, a few D1 statements, one R2 put of a small JSON; no base64 or MIME work.

The client creates the idempotency key once per compose session (stored on the draft), so a
double click, a retry after a timeout and two tabs sending the same draft all send one email.

## Webhook

- Read the raw body; verify the Svix signature with `RESEND_WEBHOOK_SECRET`; reject a timestamp
  more than 5 minutes off; answer 401 on failure without detail.
- `INSERT INTO webhook_events (svix_id) ... ON CONFLICT DO NOTHING`; a duplicate answers 200 and
  does nothing.
- Map the event to the message by `data.email_id` = `resend_id` and move the status forward only
  (`sent` < `delayed` < `delivered`; `bounced`, `complained`, `failed`, `suppressed` are final).
  Unknown ids and other event types answer 200 and are ignored.
- Log the event type and message id only.

## Screens

- **Compose** (a full page at phone width, a panel beside the list from 1280 px): From selector,
  To / Cc / Bcc as address chips with validation, Subject, plain-text body, attachment list with
  upload progress and remove, Send, Save draft (autosave status shown), Discard (confirm).
- Reply / Reply all / Forward actions in the reader toolbar; the body starts with a quoted plain
  text of the source ("On <date>, <sender> wrote:"); forward lists the source's attachments,
  re-uploaded from the browser's parsed copy when kept.
- **Sent** and **Drafts** in the side navigation (hidden in M4). Sent rows show the delivery
  status as a badge; the reader shows the status and a Retry for `failed`.
- **Quota**: "Today 12 / 100 · This month 340 / 3,000" in the compose panel and Settings;
  a warning at 80%; the Send button explains when the daily quota is used up.
- All copy in zh-CN, en and ja-JP; `web/AGENTS.md` layout rules; keyboard: `c` compose, `r`
  reply, `a` reply all, `f` forward, Ctrl+Enter send.

## Secrets and configuration

- Secrets: `RESEND_API_KEY` (recommend a sending-only key in the README), `RESEND_WEBHOOK_SECRET`,
  `UPLOAD_URL_KEY` (32 random bytes; `bun run upload-key` prints one).
- Vars: `RESEND_DAILY_LIMIT` (100), `RESEND_MONTHLY_LIMIT` (3000).
- `.dev.vars.example` gets the names with empty values. README: create the key, verify the domain
  in Resend, add the webhook pointing at `/api/webhooks/resend` with the events above, set the
  secrets, turn on sending for the domain in the panel.
- Without `RESEND_API_KEY`, compose shows "sending is not set up" and points to the README.

## Proof the change needs (High risk)

- **Worker integration tests,** with `fetch` to Resend stubbed (no real traffic unless the owner
  allows it):
  - every route's auth through the route walk; the two public routes only;
  - validation (domain not enabled, disabled address, 51 recipients, CRLF in a header, upload
    over the limit, unknown upload);
  - idempotency: the same key twice sequentially sends once; two concurrent requests send once
    (one gets 409); a `sending` row older than 60 s and a `failed` row retry with the same key;
  - the request to Resend: headers, `Idempotency-Key`, thread headers, attachment `path` URLs that
    verify;
  - error mapping for 429 quota, 422, 500 and a network error; no upstream text in responses or
    logs;
  - quota headers stored;
  - signed URL: valid, expired, tampered id, tampered sig, missing params;
  - webhook: valid signature, bad signature, old timestamp, replayed `svix-id`, status moves
    forward only, unknown id, unknown type; the library or Svix test vector;
  - cron cleanup of stale uploads and old webhook events;
  - drafts CRUD and that sending deletes the draft.
- **Browser tier:** compose, reply, reply all, forward with thread headers in the request, chips,
  attachment upload and remove, autosave, double-click Send sends once, failed send and Retry,
  quota states, Sent and Drafts folders, the keyboard shortcuts.
- **Screenshots:** every new screen and state at 390, 1280 and 1920 px, light and dark, three
  locales.
- **Ablation** of every behaviour hunk; results in STATE.
- **Bundle:** first paint within 370 kB, total within 770 kB; compose loads in its own chunk.
- **Not verifiable locally, record as unverified:** real delivery, the webhook from Resend (it
  cannot reach localhost), Resend fetching a signed attachment URL from localhost, production CPU.

## Open questions for the owner (asked at the start)

1. Body editor: plain text only in M5 (recommended; HTML mail is still read fine) or a rich-text
   editor now (a library of roughly 50–100 kB gzip in the compose chunk)?
2. May a manual test send real mail through Resend from local `wrangler dev`? You would put your
   own `RESEND_API_KEY` into `worker/.dev.vars` yourself; mail would go only to Resend's test
   addresses (`delivered@resend.dev`, `bounced@resend.dev`) and to your own mailbox, without
   attachments (Resend cannot fetch from localhost).
3. Open and click tracking stays off (recommended; it rewrites links and adds a pixel).
