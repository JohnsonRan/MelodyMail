# M5b: Telegram notifications for new mail

Risk class: High. The change adds a public webhook that can change message flags, a Worker
secret (the bot token), a table that links the owner's mailbox to a Telegram chat, and requests
from the Worker to the Telegram Bot API that carry the sender, subject and arrival address of
every new message. Read `AGENTS.md`, `worker/AGENTS.md`, `web/AGENTS.md`, `web/ASTRYX.md`,
`REQUIREMENTS.md`, `docs/PLAN.md` (sections 2, 7, 8), `docs/STATE.md` (owner rulings M1–M5) and
`docs/M4b-pwa.md` first. This file decides the M5b design. Record deviations under "Open
questions" in `docs/STATE.md`, M5b. M5b is built after M5 merges and before M6 (owner,
2026-11-16).

## Scope

1. Binding one private Telegram chat to the mailbox from Settings > Notifications.
2. A widget card in that chat for each new inbound message: sender label, subject, arrival
   address; buttons Open, Mark read, Archive, Star (owner, 2026-11-16, rulings 1 and 2).
3. The three action buttons change the message through the Worker; open mailbox pages refresh.
4. Connect, disconnect, status and a test card in the panel.

Out of scope: message bodies or snippets in Telegram, cards for sent mail, group chats, inline
mode, shared widgets, more than one chat, updating a card after an action taken in the panel
(open question 2), deleting the Telegram message when the mail is deleted (open question 5).

## Telegram facts (checked 2026-11-16)

Sources: the Bot API reference (`core.telegram.org/bots/api` and its machine-readable method and
type pages under `/bots/api/methods/` and `/bots/api/types/`), the widgets guide
(`core.telegram.org/bots/widgets.md`), the changelog (`/bots/api-changelog`), the Bot FAQ
(`/bots/faq.md`) and Bot features (`/bots/features.md`). Section names are in quotes.

Release and availability:

- Bot API 10.4 is dated November 9, 2026 and adds `sendWidget`, `sendSharedWidget`, `Widget`,
  `WidgetQuery`, `SharedWidgetQuery`, `answerWidgetQuery`, `editMessageWidgetData` and
  `editSharedWidgetData` (changelog, "November 9, 2026").
- In production, widgets work only in the private chat with the bot; groups, inline mode and
  forwards are test-server only (guide, "Availability").
- In production, sent widgets automatically have protected content and cannot be forwarded
  (`sendWidget` page; changelog). `copyMessage` refuses widget messages (guide, "Forwards").
- Apps without widget support show the message as unsupported media with its caption (guide,
  "Where widgets live").

`sendWidget` parameters (method page `sendwidget`):

- Required: `chat_id`, `html` (1–32768 bytes, at most 4096 bytes after zlib at the maximum
  level).
- Optional: `message_thread_id`, `width`, `height` (omit for automatic), `public_data` and
  `chat_data` (0–1024 bytes each), `caption` (0–1024 characters after entity parsing),
  `parse_mode`, `caption_entities`, `show_caption_above_media`, `allow_queries`, `is_shared`,
  `disable_notification`, `protect_content`, `allow_paid_broadcast`, `message_effect_id`,
  `reply_parameters`, `reply_markup`.
- Without `allow_queries`, every request from the widget is refused (guide, "Sending a widget").
- The HTML must not contain U+0000 (`INPUT_MEDIA_WIDGET_HTML_INVALID`); over a size limit the
  server answers `INPUT_MEDIA_WIDGET_TOO_LARGE` (guide, "Sending a widget", "Limits").
- Success returns the sent `Message` with its `widget` (guide, "Sending a widget").

`WidgetQuery` fields (type page `widgetquery`; guide, "Requests to the bot"):

- `id` (string), `from` (`User`), `chat` (optional, absent for inline messages), `message_id`
  (optional, absent for inline messages), `inline_message_id` (optional), `chat_instance`,
  `chat_type` (inline messages only), `type` (`WidgetQueryType`; `data` for a plain request),
  `data` (1–64 bytes), `widget_id` (shared widgets only).
- For an original in the private chat, the query carries `chat` and `message_id`.
- "`from` and `widget_id` cannot be forged": `from` is authenticated by Telegram (guide,
  "Requests to the bot").
- The query does not carry the widget's state; the bot keeps the authoritative state keyed by the
  message (guide, "Requests to the bot").
- Requests from a forwarded shared widget arrive as `shared_widget_query`; "If you pass
  `allowed_updates`, include both" (guide, "Requests to the bot"). M5b sends no shared widget and
  production forbids forwards, so it never receives one.

`answerWidgetQuery` (method page): `widget_query_id` (required), `data` (optional, 0–1024 bytes).
Answer every query within 15 seconds; the answer goes only to the widget that asked and does not
change its state. A late answer is refused with `query is too old` (guide, "Limits").

`editMessageWidgetData` (method page): `chat_id` + `message_id`, or `inline_message_id`;
`public_data` and `chat_data` (0–1024 bytes; an empty string removes it, an omitted field is
kept). Every edit is silent: no "edited" mark, no notification (guide, "Changing the state"). An
edit that changes nothing fails with `Bad Request: message is not modified`; take it as done. Each
edit counts as one sent message against the bot's sending limits.

State (guide, "The widget's state"):

- `chat_data` is tied to one message, seen only in that chat, never carried by a forward, and
  pushed to an open widget at once (`chatDataChanged`).
- `public_data` is seen wherever the widget is shown; a forward gets a copy.
- Only the bot writes either one. The widget reads `TelegramWidget.chatData` and
  `TelegramWidget.publicData`.

Requests from the widget (guide, "Requests to the bot", "Limits", "WidgetRequestError"):

- `TelegramWidget.request(data)`, 1–64 bytes, only in a tap's handler, synchronously; one tap
  unlocks one call, shared with `openLink`.
- One request in flight; a second rejects with `BUSY`.
- 5 requests per 5 seconds per user and bot, background requests included; above it the widget
  gets `RATE_LIMITED` (whether such a request reaches the bot is not stated; **unconfirmed**).
- No answer in 15 s gives `TIMEOUT`; a deleted message, a blocked bot or a network failure gives
  `FAILED`.
- Background requests (without a tap) exist only in the private chat, one when the widget
  appears, then at most one per 5 s while visible. The design makes none.

Links (guide, "Storage, links and haptics"): `openLink(url)` opens an `https:` URL of at most 256
characters, no user name or password, not a `t.me` host, after the user confirms it; an invalid
URL throws `TypeError`.

Sandbox (guide, "What a widget is", "JavaScript", "CSS"): QuickJS, no network API, no external
resources, no form controls except `<button>`, no `aria` semantics. `textContent`, `JSON.parse`,
`Intl` and `navigator.language` are available. `:has()`, `:focus*`, `vh` and named fonts are
removed.

Locale and theme:

- `Intl` runs "in the user's language (`navigator.language`)" (guide, "JavaScript"). The guide
  does not say whether this is Telegram's interface language or the device's; marked
  **unconfirmed**.
- The palette is on the root as CSS variables (`--tg-theme-bg-color`, `--tg-theme-text-color`,
  `--tg-theme-hint-color`, `--tg-theme-button-color`, …) and in `TelegramWidget.themeParams`; an
  unstyled `<button>` is drawn as the client's own button (guide, "Native look", "CSS
  variables").
- `prefers-color-scheme` follows the chat theme, not the system, and switches live; JavaScript
  reads `TelegramWidget.colorScheme` and the `themeChanged` event (guide, "Color schemes").

Bubble and caption (guide, "Sizes", "The time in the corner", "Design guidelines"): 200–600 px
wide (320–430 px on phones), 50–600 px tall, content beyond the height is clipped. With a caption
below the widget, the message time sits in the caption's line and covers nothing. "Always send a
caption": it is the text in the chat list, in notifications and in search.

Webhook (method page `setwebhook`; API page, "Getting updates", "Making requests when getting
updates"):

- `setWebhook` parameters: `url` (HTTPS), `certificate`, `ip_address`, `max_connections` (1–100,
  default 40), `allowed_updates`, `drop_pending_updates`, `secret_token` (1–256 characters of
  `A-Z a-z 0-9 _ -`).
- With `secret_token`, every webhook request carries it in `X-Telegram-Bot-Api-Secret-Token`.
- Ports: 443, 80, 88, 8443. Telegram cannot reach `localhost`.
- `allowed_updates` omitted keeps the previous setting; it does not affect updates created before
  the call.
- A non-2xx answer makes Telegram repeat the request "and give up after a reasonable amount of
  attempts". Updates are kept at most 24 hours.
- `update_id` increases sequentially and lets the bot ignore repeated updates (type page
  `update`).
- The bot may answer the webhook request with a method call in the response body; it cannot learn
  whether that call succeeded.

Other limits:

- "In a single chat, avoid sending more than one message per second"; bursts above it get 429
  (Bot FAQ). A failed request's `parameters.retry_after` gives the wait (type
  `ResponseParameters`).
- Deep-link `start` parameter: `A-Z a-z 0-9 _ -`, up to 64 characters; `https://t.me/<bot>?start=X`
  makes the app send `/start X` (Bot features, "Deep Linking").
- User and chat ids have at most 52 significant bits (type `User`); a JavaScript number holds
  them exactly.

## Libraries (owner preference: maintained libraries over own code)

- **Bot API client: none; `fetch` against six methods.** `grammy` 1.46.0 (released 2026-08-26)
  and `@grammyjs/types` 5.0.0 (2026-08-25) predate Bot API 10.4 (2026-11-09): the types package
  has no `sendWidget`, `WidgetQuery` or `widget_query`, and the `grammy` web build contains no
  `Widget` at all (checked by unpacking both tarballs, 2026-11-16). Its web build
  (`out/web.mjs`) is 207,778 bytes, 35,596 bytes after zlib level 9, and ships a Cloudflare
  webhook adapter; it was not run in workerd here. `telegraf` 4.16.3 was last released
  2024-02-29.
- Methods used: `getMe`, `setWebhook`, `deleteWebhook`, `sendWidget`, `editMessageWidgetData`,
  `sendMessage`; `answerWidgetQuery` goes back in the webhook response. A typed wrapper of about
  60 lines (`worker/src/telegram/api.ts`) costs less than a 35 kB client that would still need
  hand-written widget types. Revisit when grammY ships 10.4 types (deferred list).
- No new frontend dependency.
- The Worker already has `nodejs_compat` for other reasons (STATE, M4b); M5b needs none of it.

## Decisions

### Binding

- **Flow.** Settings > Notifications > Telegram > Connect calls `POST /api/telegram/link`. The
  Worker answers with a deep link `https://t.me/<bot_username>?start=<code>` and the code itself.
  The owner opens the link (or sends `/start <code>` by hand); Telegram sends the update to the
  webhook, which stores the chat. Reason: Telegram's own guide names the `start` parameter as the
  way to "connect the user's Telegram account to their account on another platform" (Bot
  features, "Deep Linking"), and it needs no typing on a phone.
- **Code.** 16 random bytes, base64url (22 characters, inside the 64-character limit), valid 10
  minutes, single use, one pending code at a time (a new one replaces the old). Only its SHA-256
  is stored. Reason: 128 bits cannot be guessed in 10 minutes; a hash in D1 is useless to a
  database reader.
- **Fresh authentication.** `POST /api/telegram/link` uses `requireFreshAuth` and the panel wraps
  it in `withReauth`. Reason: a stolen session could otherwise bind the thief's chat and receive
  every future subject; this matches adding a Passkey.
- **Who can bind.** The update must be a `message` whose `chat.type` is `private` and whose
  `from.id` equals `chat.id`; the text must be `/start <code>` with a code that matches the
  pending hash and has not expired. The claim is one `UPDATE … WHERE link_code_hash = ? AND
  link_expires_at > ?`, so two updates with the same code bind once.
- **Answers to the chat.** A successful bind replies "Connected. New mail will appear here." A
  `/start` with any other code replies "This code is invalid or expired. Create a new one in
  MelodyMail: Settings > Notifications." Both go back in the webhook response (no subrequest),
  in the chat's `from.language_code` mapped to zh-CN, en or ja-JP (else en). Every other message
  from any chat gets no reply. Reason: one answer for every wrong code reveals nothing about the
  pending code; silence for the rest costs nothing and starts no conversation with strangers.
- **One chat.** Binding replaces any earlier chat and deletes its card rows in the same batch, so
  buttons on the old chat's cards stop working. Reason: a single owner needs one chat; each extra
  chat is one more place subjects go.
- **Unbinding.** `DELETE /api/telegram` calls `deleteWebhook` with `drop_pending_updates`, then
  deletes the `telegram` row and every card row, and writes an audit entry. A failed
  `deleteWebhook` is logged and the local delete still runs; the webhook route answers 404
  without a row. Reason: with the feature off, no public route acts on anything.
- **Recovery.** The recovery step (`POST /api/auth/recover`) also unbinds the chat. Reason:
  `worker/AGENTS.md`, "Lockouts and recovery": the bound chat can change flags and receives
  subjects, so it is an access path that a recovery must not leave open. The owner connects
  again afterwards.

### Secrets and configuration

- **`TELEGRAM_BOT_TOKEN`**: a Worker secret (`wrangler secret put`), the token from BotFather.
  Without it, the Telegram section says Telegram is not set up and points to the README; the
  webhook route answers 404.
- **Webhook secret: generated, not configured.** Each Connect generates 32 random bytes,
  base64url (43 characters of the allowed set), passes them once to `setWebhook` as
  `secret_token`, and stores only the SHA-256. Reason: no second secret for the owner to create
  and rotate, nothing secret in D1, and every Connect rotates it.
- **`TELEGRAM_API_URL`**: a var, `https://api.telegram.org`, so tests point it at the stub and no
  URL is hardcoded (`worker/AGENTS.md`, "APIs and modularity").
- **Registration: from the panel, inside Connect.** `POST /api/telegram/link` calls `getMe` (for
  the bot's username) and `setWebhook` with `url = <request origin>/api/webhooks/telegram`,
  `secret_token`, `allowed_updates: ["message", "widget_query"]` and `drop_pending_updates:
  true`, then creates the code. It stores the request origin for message links. Reasons:
  - the origin comes from the owner's own request, so no `APP_ORIGIN` setting is needed (unlike
    `VAPID_SUBJECT`, STATE M4b deviation 1);
  - the token never leaves the Worker; a `bun run` script would need it on the dev machine;
  - Connect is self-healing: it re-registers after a token change or a new domain.
- **Origin check.** Connect refuses with 409 `telegram_needs_https` unless the request origin is
  `https:` on a port Telegram accepts (443, 88 or 8443) and at most 160 characters long.
  Local `wrangler dev` (`http://localhost:8787`) therefore cannot connect, and the panel says
  Telegram needs the deployed address. M7 does the first deploy, so a real connection waits for
  M7 unless the owner allows a tunnel test (open question 1).
- `.dev.vars.example` gets `TELEGRAM_BOT_TOKEN=`; README "Notifications" gets a Telegram part:
  create the bot with BotFather, `wrangler secret put TELEGRAM_BOT_TOKEN`, open Settings >
  Notifications on the deployed address, Connect.

### Data (migration 0011, the next number after M5's)

Both tables use `IF NOT EXISTS` and apply on a database that holds rows.

`telegram`, at most one row:

| Column | Notes |
| --- | --- |
| `id` | integer primary key, `CHECK (id = 1)` |
| `bot_username` | from `getMe`, for the deep link |
| `origin` | the `https://` origin Connect ran on; message links are built from it |
| `webhook_secret_hash` | SHA-256 hex of the current `secret_token` |
| `link_code_hash`, `link_expires_at` | the pending code, cleared on use, cancel or bind |
| `chat_id` | integer, null while not bound |
| `chat_label` | `@username` or first name, at most 64 characters, shown in the panel |
| `language` | `zh-CN`, `en` or `ja-JP`, from `from.language_code` at bind time |
| `bound_at` | |
| `last_error`, `last_error_at` | a short code of the last failed send (`blocked`, `rate_limited`, `failed`), cleared by the next success |
| `updated_at` | |

`telegram_cards`, one row per card sent:

| Column | Notes |
| --- | --- |
| `message_id` | text primary key, references `messages.id` `ON DELETE CASCADE` |
| `chat_id` | integer, the chat the card went to |
| `tg_message_id` | integer, null until `sendWidget` returns |
| `created_at` | |

Unique index on `(chat_id, tg_message_id)`; the webhook looks cards up by it.

- The primary key on `message_id` is the send claim: one card per message even if the Hub is
  asked twice.
- The cascade removes a card when the mail is deleted permanently, so a later tap finds nothing
  and the card shows "deleted".
- **No replay table.** Every webhook effect is idempotent: a bind consumes its code once, an
  action sets an absolute flag value, and a repeated answer to a query that was already answered
  fails harmlessly. The secret token authenticates the request. Reason: a replay guard like
  `webhook_events` would add a write per update and a cron job for no new safety. `update_id` is
  not stored.

### Routes (all in the authz route walk)

| Route | Auth | Behaviour |
| --- | --- | --- |
| `GET /api/telegram` | session | Status: `notConfigured` (no token), `off`, `pending` (with `url`, `code`, `expiresAt`), `on` (with `chatLabel`, `boundAt`, `lastError`). Also `httpsRequired` when the request origin cannot be registered. |
| `POST /api/telegram/link` | session, `requireFreshAuth`, `TELEGRAM_LIMITER` | `getMe`, `setWebhook`, new code. 404 `telegram_not_configured`, 409 `telegram_needs_https`, 502 `telegram_failed` (no upstream text). |
| `DELETE /api/telegram/link` | session | Cancels the pending code. |
| `DELETE /api/telegram` | session | Disconnects (see "Binding"). |
| `POST /api/telegram/test` | session, `TELEGRAM_LIMITER` | Sends a test card with sample content; 409 `telegram_not_connected`, 502 `telegram_failed`. |
| `POST /api/webhooks/telegram` | public (`signedWebhookRoute`), secret token | Telegram updates. |

- `TELEGRAM_LIMITER`: a new rate-limit binding, 5 per 60 s per session, like `PUSH_LIMITER`.
- The webhook is registered with `signedWebhookRoute`, so it carries the `publicRoute` marker
  and skips the same-origin check; it is added to `PUBLIC` in `test/authz.spec.ts`, the other
  five to `GUARDED`. `REQUIREMENTS.md`, "Exceptions", gets a row for it (caller: Telegram;
  reason: public, authenticated by the secret token).
- **Webhook handling, in order:**
  1. No `telegram` row with a `webhook_secret_hash`: 404.
  2. Hash the `X-Telegram-Bot-Api-Secret-Token` header (missing counts as empty) and compare it
     with the stored hash without an early exit (a `hashMatches` helper next to `secretsEqual`
     in `auth/crypto.ts`). Mismatch: 401, body not read.
  3. Body cap 64 KB: a declared `content-length` over it, or more bytes read, is answered 200 and
     ignored with a `telegram_update_too_large` log line, so Telegram does not repeat it. Reason:
     the two updates M5b uses are under 2 KB; a 4096-character text message with entities stays
     far below the cap.
  4. Invalid JSON: 200, ignored, logged. Every handled or ignored update answers 2xx; only an
     internal failure (D1 down) answers 500, so Telegram repeats it.
  5. Dispatch on `message` (bind) or `widget_query` (action); anything else is 200 with no body.

### Sending

- **Hook: `Hub.notify`, next to `pushNewMail`.** For a `message` event, `notify` runs
  `pushNewMail` and `telegramNewMail` with `Promise.all`, each in its own `try`/`catch` that
  logs and never throws. Reasons: one place sends every new-mail notification; the queue
  consumer's 10 ms budget stays untouched, as in M4b; a Telegram failure never fails the parse.
- **Open pages do not suppress Telegram.** A card goes out for every new message, whether or not
  a page is open (open question 3). Reason: the Web Push rule is per device, and the Hub cannot
  tell whether the open page is on the same phone as Telegram. Telegram is a channel the owner
  chose on purpose, and its own notification settings can mute the chat.
- **Steps of `telegramNewMail(env, id)`:**
  1. One D1 batch: the `telegram` row (chat, origin, language) and the message (`subject`,
     `from_hdr`, `envelope_from`, `envelope_to`). Stop when no chat is bound.
  2. Claim: `INSERT INTO telegram_cards … ON CONFLICT DO NOTHING RETURNING message_id`. No row
     returned: already sent, stop.
  3. `sendWidget` with `chat_id`, `html` (the constant template), `chat_data` (below),
     `caption`, `allow_queries: true`, `protect_content: true`. No `width`, `height` or
     `parse_mode`.
  4. Success: store `tg_message_id`, clear `last_error`.
  5. Failure: see "Timeouts, retries and logging".
- **`chat_data`** (JSON, at most 1024 bytes): `{"v":1,"f":sender,"s":subject|null,"t":to,
  "u":url,"r":0|1,"a":0|1,"st":0|1}`.
  - `f`: `senderLabel` from `push/send.ts`, the same label as Web Push.
  - Each text field is cut by code point to a byte budget measured on its JSON-escaped form:
    `f` 200 bytes, `s` 400, `t` 200. The worst case measured, a long CJK subject, a Japanese
    sender with quotes and a 78-character address, is 812 bytes (script below).
  - `u`: `<origin>/?m=<id>`, the app's message link (`messageUrl` in
    `web/src/pwa/notification.ts`). The origin is at most 160 characters by a check at Connect,
    the id a 36-character UUID, so `u` stays under the 256-character `openLink` limit.
- **Why content goes in `chat_data`, not in the HTML:**
  - the HTML is one constant file, so a test that measures it covers every card ever sent;
  - sender and subject are never parsed as markup: the widget writes them with `textContent`,
    so no escaping path exists to get wrong;
  - `chat_data` never travels with a forward; `public_data` would.
- **Caption:** plain text, no `parse_mode` (so nothing in it is parsed as entities):
  `<sender>\n<subject or "(no subject)" in the bound language>`, cut to 1024 characters. Reason:
  the caption is what the phone's notification, the chat list and search show, and what old apps
  show instead of the widget; the arrival address stays on the card. All three fields are the
  ruled content (ruling 1).
- **Fallback:** when `sendWidget` answers 400 (the widget refused, or an app server without
  widgets), send `sendMessage` with the caption's text and one inline URL button "Open" to `u`,
  without a card row. Reason: the notification still arrives; the action buttons need the
  widget. 403, 429 and 5xx get no fallback (open question 6).
- **CPU.** The Hub builds a JSON body of about 4 KB and makes at most four D1 calls and two
  fetches; no cryptography. The webhook hashes one header (Web Crypto) and parses a body under
  64 KB. A Bun benchmark (`bun worker/bench/telegram.ts`) times the webhook's parse, validation
  and card building on a 64 KB update and a worst-case card, against the existing 3 ms p95 budget
  per input (`REQUIREMENTS.md`, "Numbers"). Production `cpuTime` stays unverified until M7.
- **Subrequests** (each D1 call and each `fetch` counts; Workers limits, "Subrequests"):
  - `telegramNewMail`: 1 batch read + 1 claim + 1 `sendWidget` + 1 fallback at most + 1 update
    = 5.
  - Together with `pushNewMail` (1 batch + 10 sends + 10 deletes at most) the Hub invocation
    makes at most 26 of 50.
  - Webhook action: 1 config read + 1 card lookup + 1 flag update + 1 row read + 1
    `editMessageWidgetData` + 1 Hub call = 6; the answer rides in the response.
  - Connect: 1 read + `getMe` + `setWebhook` + 1 write = 4.
- **Timeouts, retries and logging:**
  - Every Bot API call has a 10 s `AbortSignal.timeout`; `editMessageWidgetData` inside the
    webhook has 5 s, so the answer leaves well within Telegram's 15 s.
  - No retry and no sleep. A 429 (`retry_after`), a 403 (bot blocked) or a network error
    records `last_error` for the panel and logs a warning; the card is lost. Reason: a retry
    after a timeout could post the card twice, and the Hub must not wait on `retry_after`.
    Bursts above one message per second per chat can hit 429; recorded as a limit (deferred:
    coalescing).
  - Log lines carry the message id, the method, the HTTP status, Telegram's `error_code` and a
    fixed classification (`not_modified`, `blocked`, `chat_not_found`, `widget_refused`,
    `rate_limited`, `other`). They never carry the token (it is in every Bot API URL, so neither
    a URL nor a `fetch` error message is logged, only the error's `name`), a chat id, a code,
    Telegram's raw `description`, the subject, the sender or an address.
  - `test/log-redaction.spec.ts` gains these paths.

### Actions from `widget_query`

- **Request data:** `<action>:<value>` with action `read`, `arch` or `star` and value `0` or `1`;
  anything else is answered `{"e":"bad"}`. The data names no message: the message comes from
  the card row found by `(chat.id, message_id)`. So a widget can only act on its own message,
  and "the message id belongs to the card" holds by construction.
- **Buttons toggle** (open question 4): Mark as read / Mark as unread, Archive / Move to Inbox,
  Star / Remove star, with the labels the panel already uses. The widget sends the target value,
  not "toggle", so a repeat is idempotent.
- **Checks, in order:** a chat is bound; `chat.type` is `private`; `chat.id` and `from.id` both
  equal the bound `chat_id`. Otherwise answer `{"e":"unbound"}` and change nothing. An answer is
  sent even then, because an unanswered query ends in `TIMEOUT` on the card.
- **Card not found** (mail deleted permanently, or a card of an earlier binding in the same
  chat): answer `{"e":"gone"}` and set `chat_data` to `{"v":1,"g":1}`, so the card shows "This
  message was deleted in MelodyMail" and drops its content after a restart too.
- **Perform:** the flag change goes through the same function as `PATCH /api/messages/:id`.
  `updateFlags` in `mail/routes.ts` takes `Context` today; it moves to an exported
  `updateMessageFlags(env, ids, flags)` that both callers use.
- **Answer and update:** read the row back, write the new `chat_data` with
  `editMessageWidgetData` (`message is not modified` counts as done), then answer
  `answerWidgetQuery` with `{"r":…,"a":…,"st":…}` in the webhook response. The widget redraws
  from the answer at once and from `chatDataChanged` when the edit arrives. A failed edit is
  logged; the answer still carries the true flags.
- **Open pages:** `notifyHub(env, { type: "changed", id })`, the event pages already refetch on.
- **Rate limit:** Telegram refuses a sixth request in 5 s with `RATE_LIMITED`; the card
  shows "Too many taps. Wait a few seconds and try again." for `RATE_LIMITED`. The webhook needs
  no limiter of its own: only the bound chat with the secret token gets past step 2.
- **Panel actions do not edit cards** (open question 2). A card may show a stale flag after the
  owner changes the message in the panel. Any tap sets an absolute value and the answer carries
  all three flags, so one tap brings the card back in line.

### The widget HTML

`worker/src/telegram/card.html`, imported as text (wrangler's default module rules include
`.html` as Text; to confirm in the build and in the vitest pool, else a generated `.ts` string).
It is a fragment, without `<html>`, `<meta>` or `role`, which the profile removes. The draft
measured below:

```html
<style>
#f{font-weight:600}
#s{margin:2px 0}
#f,#s,#t{overflow-wrap:anywhere}
#t,#m{color:var(--tg-theme-hint-color);font-size:.875em}
#m{margin-top:6px}
#b{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}
#b button{width:100%}
.d #b{display:none}
</style>
<div id="f"></div><div id="s"></div><div id="t"></div>
<div id="b"><button id="o"></button><button id="r"></button><button id="a"></button><button id="x"></button></div>
<div id="m"></div>
<script>
const W = window.TelegramWidget;
const L = {
  en: {o:"Open",r:["Mark as read","Mark as unread"],a:["Archive","Move to Inbox"],x:["Star","Remove star"],
    n:"(no subject)",to:"To: ",w:"Working…",g:"This message was deleted in MelodyMail.",
    u:"Telegram is no longer connected to MelodyMail.",RATE_LIMITED:"Too many taps. Wait a few seconds and try again.",
    f:"MelodyMail didn't answer. Try again.",k:"This is a test card. The buttons work on cards for real mail.",l:"This link can't be opened."},
  zh: { /* the same keys in zh-CN */ },
  ja: { /* the same keys in ja-JP */ }
};
const T = L[String(navigator.language || "en").slice(0, 2).toLowerCase()] || L.en;
const $ = (id) => document.getElementById(id);
let d = {};
let busy = false;

function parse(text) {
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; }
}
function say(text) { $("m").textContent = text || ""; $("m").hidden = !text; }
function render() {
  document.body.className = d.g ? "d" : "";
  if (d.g) { $("f").textContent = ""; $("s").textContent = ""; $("t").textContent = ""; say(T.g); return; }
  $("f").textContent = d.f || "";
  $("s").textContent = d.s || T.n;
  $("t").textContent = d.t ? T.to + d.t : "";
  $("o").textContent = T.o;
  $("r").textContent = T.r[d.r ? 1 : 0];
  $("a").textContent = T.a[d.a ? 1 : 0];
  $("x").textContent = T.x[d.st ? 1 : 0];
  for (const id of ["r", "a", "x"]) $(id).disabled = busy;
}
function act(name, on) {
  if (d.x) return say(T.k);
  if (busy) return;
  busy = true; say(T.w); render();
  W.request(name + ":" + (on ? 1 : 0)).then((answer) => {
    const v = parse(answer.result);
    if (v.e === "gone") d = { g: 1 };
    else if (v.e === "unbound") say(T.u);
    else if (v.e) say(T.f);
    else { Object.assign(d, v); say(""); }
  }, (err) => say(T[err && err.code] || T.f)).finally(() => { busy = false; render(); });
}
$("o").onclick = () => { try { W.openLink(d.u); } catch (e) { say(T.l); } };
$("r").onclick = () => act("read", !d.r);
$("a").onclick = () => act("arch", !d.a);
$("x").onclick = () => act("star", !d.st);
if (W) {
  d = parse(W.chatData);
  W.onEvent("chatDataChanged", () => { d = parse(W.chatData); render(); });
}
say("");
render();
</script>
```

- **Locale:** `navigator.language` mapped by its first two letters to zh-CN, ja-JP or en,
  default en; any `zh-*` gets the Simplified copy, the only Chinese locale the app has. The copy
  reuses the panel's strings (`mail.markRead`, `mail.archive`, `mail.star`, …) word for word.
  `scripts/check-i18n.ts` does not read this file, so a worker test compares the three blocks'
  keys.
- **Theme:** no color is set; text, hint and button colors come from the `--tg-theme-*`
  variables and the client's default button style, so the card follows light, dark and
  outgoing-bubble palettes live. Sizes are in `em`.
- **Escaping:** every untrusted value (sender, subject, address) goes through `textContent`;
  the script never uses `innerHTML`. `chat_data` is built with `JSON.stringify`. The only URL
  the card opens is `u`, built by the Worker from the stored origin and the message id; Telegram
  confirms it before opening.
- **Gestures and layout:** buttons stay in the default `touch-action: auto`; nothing is dragged.
  Content is a few lines plus a 2 × 2 button grid, about 170 px at a 320 px bubble (to measure
  in a browser stand-in, guide "A first look in a browser"), far below the 600 px cap. The
  caption sits below, so the time covers no button.
- **Test card:** `chat_data` with `"x":1`, sample sender "MelodyMail", subject "Test
  notification" in the bound language, `u` the origin. Its buttons show the test-card line
  without a request; Open opens the app.
- **Size, measured** with `zlib.compress(html, 9)` in Python 3.13 (the guide, "Counting the size",
  says Python's zlib counts as the server does) on the full draft with all three locales:
  **3,828 bytes of HTML, 1,993 bytes compressed, against the 4,096-byte limit** (32,768 for the
  raw HTML). Worst-case `chat_data`: **812 of 1,024 bytes**. The measured draft is
  in the appendix below, the starting point for `worker/src/telegram/card.html`; measure
  it with `zlib.compress(open(path, "rb").read(), 9)` under
  `uv run --no-project --python 3.13 python -I`.

### Settings screen

A second section, "Telegram", on Settings > Notifications, below "Notifications on this device".
Reason: the page is about notifications; GitHub's Settings > Notifications also lists every
delivery channel on one page. The section uses the existing `SecuritySection`, `Banner`,
`Button`, `useSettingsPage` and `withReauth`; a copy control from Astryx if `web/ASTRYX.md` has
one.

| State | Shows |
| --- | --- |
| loading | the page's `RowsSkeleton` |
| `notConfigured` | info Banner: Telegram isn't set up on this server; the README's "Notifications" section shows how |
| `httpsRequired` | info Banner: Telegram needs the deployed `https://` address of MelodyMail |
| `off` | the description and the primary action "Connect Telegram" |
| `pending` | "Open Telegram" (the deep link, opens in a new tab), the command `/start <code>` with a copy action, "The code expires at <time>.", "Cancel". The page asks `GET /api/telegram` every 3 s until the state changes or the code expires. |
| `on` | "Connected to <chatLabel> since <date>", a warning Banner when `lastError` is set ("The last card couldn't be sent: <reason>. Send a test card to check."), "Send test card" (secondary), "Disconnect" (asks for confirmation: old cards stop working) |

- **Description:** "Get a card in Telegram for each new mail with the sender, the subject and the
  address it arrived at, never the message text. Telegram can read these fields: bot messages
  aren't end-to-end encrypted." Reason: ruling 1 accepts that exposure; the owner sees it
  before connecting.
- All copy in zh-CN, en and ja-JP, under `notifications.telegram.*`; error codes
  `telegram_not_configured`, `telegram_needs_https`, `telegram_not_connected`,
  `telegram_failed` get entries in `web/src/errors.ts`.
- Phone width (390 px): the actions wrap below the text; the code never breaks (`web/AGENTS.md`,
  "Values never break") and shows in full on touch.
- Polling stops when the page unmounts. A pending code is the only polling case; it lasts at
  most 10 minutes, at most 200 requests.

## Proof the change needs (High risk)

- **Worker integration tests,** with `fetch` to `TELEGRAM_API_URL` stubbed like
  `send-helpers.ts` does for Resend (no traffic to Telegram unless the owner allows it):
  - route walk: the webhook is the only new public route; the five others answer 401 without a
    session; `POST /api/telegram/link` answers 403 `reauth_required` without fresh auth;
  - Connect: `getMe` then `setWebhook` with the request origin, `allowed_updates` containing
    `widget_query`, a `secret_token` of the allowed alphabet whose hash is stored; refuses an
    `http:` origin and a port Telegram does not accept; 404 without a token;
  - webhook auth: wrong, missing and right secret header; no row: 404; oversized body: 200 and no
    effect; invalid JSON: 200;
  - binding: valid code binds once (a second update with the same code does not rebind);
    expired code, wrong code, group chat, `from.id` different from `chat.id`: no bind and the one
    fixed reply (or none for non-`/start` text); rebinding drops the old chat's cards; recovery
    unbinds;
  - sending: the Hub sends one card per message even when `notify` runs twice; the request body
    carries the template, `allow_queries`, `protect_content`, `chat_data` within 1024 bytes with
    the cuts, `u` within 256 characters; no chat bound: no request; a page open: the card still
    goes; 400 falls back to `sendMessage`; 403 and 429 record `last_error` and send nothing else;
    a Telegram failure does not fail the parse or the push;
  - actions: each action and value changes exactly that flag through `updateMessageFlags`; the
    edit carries the new flags; the webhook response is `answerWidgetQuery` with the flags; a
    query from another chat, a group or another `from.id` changes nothing and answers
    `unbound`; unknown data answers `bad`; a deleted message answers `gone` and edits
    `chat_data` to `{"v":1,"g":1}`; `message is not modified` is success; the Hub gets a
    `changed` event;
  - disconnect: `deleteWebhook` called, rows gone, a later webhook answers 404; a failing
    `deleteWebhook` still disconnects;
  - logs: no token, chat id, code, subject, sender or address in any line of these paths.
- **Widget tests** (browser tier, Playwright): the template loaded with a stand-in
  `TelegramWidget` (guide, "A first look in a browser"): renders untrusted text containing `<img src=x onerror=…>` as text, maps
  each answer and error code to its line, sends `read:1` then `read:0`, shows the test-card line
  without a request, falls back to en for an unknown language. The three locale blocks have the
  same keys.
- **Widget size check as a test:** a Python check in the merge gate measures `card.html` with
  `zlib.compress(…, 9)` and fails over 4,096 compressed or 32,768 raw bytes, or on U+0000. It is
  shown red on a planted violation (the template padded with random text) before it counts.
- **Browser tier:** the Telegram section in every state against the API stand-in, Connect
  through the reauth prompt, the pending poll ending in `on`, Disconnect with confirmation, the
  test card, error banners.
- **Screenshots:** the section in each state at 390, 1280 and 1920 px, light and dark, zh-CN, en
  and ja-JP; the widget draft in a 320 px and a 430 px browser stand-in with light and dark
  palettes in the three locales (a browser draws more than Telegram does, so these show layout
  only).
- **Benchmark:** `bun worker/bench/telegram.ts` within 3 ms p95 per input.
- **Ablation** of every behaviour hunk; results in STATE.
- **Bundle:** first paint within 370 kB and total within 770 kB; the Worker grows by the
  template (about 4 KB).
- **Not verifiable locally, record as unverified:** the real webhook (Telegram cannot reach
  `localhost`), real widget rendering and taps on iOS, Android, Desktop and web clients, whether
  `navigator.language` in the widget is Telegram's interface language, the webhook response
  carrying `answerWidgetQuery`, the 1-message-per-second limit under a burst, production CPU
  time.

## Open questions for the owner (asked at the start)

1. **Real Telegram test before M7.** May a manual test connect your own bot to your own chat
   through a temporary public tunnel to local `wrangler dev` (for example a Cloudflare quick
   tunnel), with your token in `worker/.dev.vars` put there by you? Recommended: yes; otherwise
   real cards and taps stay unverified until the M7 deploy.
2. **Panel actions and cards.** Leave cards as they are when a message changes in the panel
   (recommended: a tap resyncs the card, and editing cards from bulk panel actions of up to 100
   messages would exceed the subrequest limit and Telegram's per-chat rate), or edit the card for
   single-message panel actions only?
3. **Open pages.** Send the card even while a MelodyMail page is open (recommended, see
   "Sending"), or skip it the way Web Push skips a device with an open page?
4. **Toggle buttons.** Let the three buttons switch back (Mark as unread, Move to Inbox, Remove
   star) so a mistaken tap can be undone from Telegram (recommended; the Worker work is the
   same), or make them one-way as listed in ruling 2?
5. **Deleted mail.** Leave the Telegram message in the chat when the mail is deleted for good
   (recommended for M5b; its card shows "deleted" on the next tap, and the caption still shows
   the sender and subject until you delete it in Telegram), or also call `deleteMessage`
   (deferred)?
6. **Fallback.** When Telegram refuses the widget (400), send a plain message with the caption
   and an Open button (recommended), or send nothing and only record the error?

## Owner rulings on the open questions (2026-11-16)

1. Real-bot test through a temporary Cloudflare quick tunnel to local `wrangler dev`: allowed. The
   owner adds `TELEGRAM_BOT_TOKEN` to `worker/.dev.vars`; the tunnel is closed right after the test.
2. Panel actions do not update the card in M5b (recommended default, accepted).
3. A card is sent even while a MelodyMail page is open.
4. The three action buttons toggle back (Mark unread, Move to Inbox, Remove star).
5. Permanently deleting a mail does not delete its Telegram message (deferred).
6. When Telegram refuses the widget, the Worker sends a plain message with an Open button.

## Appendix: measured widget draft

The draft measured above (3,828 bytes, 1,993 after zlib level 9). It is the starting point for
`worker/src/telegram/card.html`, not a finished file.

```html
<style>
#f{font-weight:600}
#s{margin:2px 0}
#f,#s,#t{overflow-wrap:anywhere}
#t,#m{color:var(--tg-theme-hint-color);font-size:.875em}
#m{margin-top:6px}
#b{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}
#b button{width:100%}
.d #b{display:none}
</style>
<div id="f"></div><div id="s"></div><div id="t"></div>
<div id="b"><button id="o"></button><button id="r"></button><button id="a"></button><button id="x"></button></div>
<div id="m"></div>
<script>
const W = window.TelegramWidget;
const L = {
  en: {o:"Open",r:["Mark as read","Mark as unread"],a:["Archive","Move to Inbox"],x:["Star","Remove star"],
    n:"(no subject)",to:"To: ",w:"Working…",g:"This message was deleted in MelodyMail.",
    u:"Telegram is no longer connected to MelodyMail.",RATE_LIMITED:"Too many taps. Wait a few seconds and try again.",
    f:"MelodyMail didn't answer. Try again.",k:"This is a test card. The buttons work on cards for real mail.",l:"This link can't be opened."},
  zh: {o:"打开",r:["标记为已读","标记为未读"],a:["存档","移到收件箱"],x:["加星标","取消星标"],
    n:"（无主题）",to:"收件人：",w:"正在处理…",g:"这封邮件已在 MelodyMail 中删除。",
    u:"Telegram 已与 MelodyMail 断开连接。",RATE_LIMITED:"点得太快了。请等几秒后重试。",
    f:"MelodyMail 没有响应。请重试。",k:"这是测试卡片。真实邮件的卡片上可以使用这些按钮。",l:"无法打开此链接。"},
  ja: {o:"開く",r:["既読にする","未読にする"],a:["アーカイブ","受信トレイに移動"],x:["スターを付ける","スターを外す"],
    n:"(件名なし)",to:"宛先: ",w:"処理中…",g:"このメールは MelodyMail で削除されました。",
    u:"Telegram と MelodyMail の接続は解除されています。",RATE_LIMITED:"操作が多すぎます。数秒待ってからもう一度お試しください。",
    f:"MelodyMail から応答がありません。もう一度お試しください。",k:"これはテスト用のカードです。ボタンは実際のメールのカードで使えます。",l:"このリンクは開けません。"}
};
const T = L[String(navigator.language || "en").slice(0, 2).toLowerCase()] || L.en;
const $ = (id) => document.getElementById(id);
let d = {};
let busy = false;

function parse(text) {
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; }
}
function say(text) { $("m").textContent = text || ""; $("m").hidden = !text; }
function render() {
  document.body.className = d.g ? "d" : "";
  if (d.g) { $("f").textContent = ""; $("s").textContent = ""; $("t").textContent = ""; say(T.g); return; }
  $("f").textContent = d.f || "";
  $("s").textContent = d.s || T.n;
  $("t").textContent = d.t ? T.to + d.t : "";
  $("o").textContent = T.o;
  $("r").textContent = T.r[d.r ? 1 : 0];
  $("a").textContent = T.a[d.a ? 1 : 0];
  $("x").textContent = T.x[d.st ? 1 : 0];
  for (const id of ["r", "a", "x"]) $(id).disabled = busy;
}
function act(name, on) {
  if (d.x) return say(T.k);
  if (busy) return;
  busy = true; say(T.w); render();
  W.request(name + ":" + (on ? 1 : 0)).then((answer) => {
    const v = parse(answer.result);
    if (v.e === "gone") d = { g: 1 };
    else if (v.e === "unbound") say(T.u);
    else if (v.e) say(T.f);
    else { Object.assign(d, v); say(""); }
  }, (err) => say(T[err && err.code] || T.f)).finally(() => { busy = false; render(); });
}
$("o").onclick = () => { try { W.openLink(d.u); } catch (e) { say(T.l); } };
$("r").onclick = () => act("read", !d.r);
$("a").onclick = () => act("arch", !d.a);
$("x").onclick = () => act("star", !d.st);
if (W) {
  d = parse(W.chatData);
  W.onEvent("chatDataChanged", () => { d = parse(W.chatData); render(); });
}
say("");
render();
</script>

```
