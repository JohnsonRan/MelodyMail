# M6: rules, API keys and the REST API

Risk class: High. API keys are a new way to authenticate. Rules can forward mail to outside
addresses and move mail to Trash. The change adds a migration (0013) and a dependency. Read
`AGENTS.md`, `worker/AGENTS.md`, `web/AGENTS.md`, `web/ASTRYX.md`, `REQUIREMENTS.md`,
`docs/PLAN.md` (sections 2, 4, 6, 7, 8), `docs/STATE.md` (owner rulings M1–M5c), `docs/M1-auth.md`,
`docs/M3-inbound.md`, `docs/M4-mailbox.md` and `docs/M5-sending.md` first. This file decides the M6
design. Record deviations under "Open questions" in `docs/STATE.md`, M6.

## Decisions

1. Rules are evaluated once per message, in `email()`, on envelope and header fields only. Forward
   actions run there with native `message.forward()`. The other actions (mark read, star, archive,
   move to Trash) are written as flags in the same INSERT that stores the row. PLAN puts those
   actions in the queue consumer; the owner approved this deviation (ruling 1).
2. A rule forwards only to rows of `forward_targets` (M2). Free-text addresses are refused.
3. "Delete" means move to Trash, as Gmail and Fastmail do. Permanent delete stays the owner's
   manual action from Trash (M4).
4. Rules apply to mail that arrives after the change. Stored mail never changes when a rule
   changes.
5. The REST API lives under `/api/v1/` and accepts only `Authorization: Bearer <key>`. It never reads
   the session cookie. Session routes never read an API key. So the CSRF guard is not needed on
   `/api/v1/`, and a key cannot reach auth, key management, settings or rules.
6. API keys have three scopes: `mail:read`, `mail:write`, `mail:send`. A key is shown once, stored
   only as a SHA-256 hash, and expires after 30, 90 (default) or 365 days, or never (ruling 3).
7. The OpenAPI 3.1 document is written by hand and committed (`worker/src/api/openapi.json`); no
   OpenAPI or schema library is added to the Worker (ruling 2). `/api/v1/` routes validate input
   by hand, as the existing routes do. Tests keep the document true (see "OpenAPI 3.1"). The
   Worker never generates it at request time.

## Scope

In scope:

- rules: data, evaluation in `email()`, Settings > Rules (list, create, edit, reorder, enable,
  disable, delete, test against a stored message);
- API keys: create (behind fresh Passkey re-authentication), list, revoke, last used;
- REST API v1: list, search and read messages, raw download, flags, send without attachments;
- the OpenAPI 3.1 document, served to a signed-in owner and committed in the repository.

Not in scope, each with its reason:

- Rules in the REST API. A stolen key that can write rules can add forwards and Trash rules; the
  owner manages rules in the panel. Recorded in the deferred list.
- Applying a rule to stored mail (Gmail's "also apply to matching conversations", Fastmail's
  preview and move). It needs a query over stored header columns; deferred.
- Regular expressions. Sender-controlled input against a backtracking engine can exceed the 10 ms
  CPU limit (Fastmail keeps regular expressions in a separate "no-preview" mode).
- Body conditions. `email()` never reads the body (PLAN, section 4).
- Attachments in the API: upload for send, and attachment extraction. The Worker does not parse
  MIME (PLAN, "CPU budget"); clients parse `/raw` themselves.
- Permanent delete, drafts, domains, addresses, targets and settings in the API.
- CORS on `/api/v1/`. Browser clients on other origins are not a goal.
- The sub-address switch that `docs/M3-inbound.md` deferred to M6: open question 5.

## Rules

### Data (migration 0013)

`CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, as in 0011 and 0012, so the
migration reruns safely and applies on a database with rows. Schema in
`worker/src/db/schema.ts`, SQL from `drizzle-kit generate`.

- `rules`: `id` (integer, autoincrement); `name` (text, at most 100 characters); `enabled`
  (integer, default 1); `position` (integer, the order); `match` (`all` or `any`, CHECK);
  `conditions` (text, a JSON array validated on write); `mark_read`, `star`, `archive`, `trash`,
  `stop` (integers, default 0); `created_at`, `updated_at`. Index `(enabled, position)`.
- `rule_forwards`: `rule_id` references `rules(id)` on delete cascade; `target_id` references
  `forward_targets(id)` on delete cascade; primary key `(rule_id, target_id)`; index on
  `target_id`.
- `api_keys`: see "API keys".

Limits, enforced on write: at most 50 rules; 1 to 10 conditions per rule; at least one action per
rule; at most 5 forward targets per rule; a condition value of 1 to 256 characters.

### Conditions

A condition is `{ field, op, value }`, plus `name` for the `header` field.

| Field | What it reads in `email()` |
| --- | --- |
| `from` | Each address in the `From` header and its display name. Without a `From` header, the envelope sender (`message.from`). |
| `to` | Each address in the `To` and `Cc` headers and its display name. |
| `recipient` | The envelope recipient's address without the sub-address tag (`shop@example.com` for `shop+github@example.com`), as `parseRecipient` computes it. The editor offers the owner's addresses. |
| `tag` | The sub-address tag (`github`); a message without a tag never matches, except `not_contains`. |
| `subject` | The `Subject` header, RFC 2047 encoded words decoded. |
| `header` | The value of the named header, for example `List-Id` or `X-GitHub-Reason`. The name is 1 to 64 header-name characters (RFC 5322 `ftext`). |

Operators: `contains`, `not_contains`, `equals`, `starts_with`, `ends_with`. A field with several
values (the addresses of `from` and `to`) matches when any value matches; `not_contains` matches
when no value contains the text.

Matching rules:

- Both sides are compared lowercased with `String.prototype.toLowerCase()`. Runs of white space
  are collapsed to one space and trimmed, on both sides. No Unicode normalization.
- Header values are unfolded (a line break followed by white space becomes one space). Whether
  `message.headers` already unfolds is not documented; unfolding twice is harmless.
- Each header value is cut to 2,000 characters before decoding, as `ADDRESS_LIST_MAX` in
  `worker/src/mail/parse.ts`. `Headers.get` joins repeated headers with `, `.
- `subject` and display names are decoded with postal-mime's `decodeWords`; addresses are split
  with its `addressParser`. postal-mime 4.2.1, already a Worker dependency, exports both
  (`worker/node_modules/postal-mime/README.md`, "addressParser()", "decodeWords()").
- Sub-addresses: the `+tag` rule applies only to the owner's own recipient (`recipient`, `tag`).
  Foreign addresses in `from` and `to` are compared as written; the meaning of `+` is up to the
  other domain.
- To match a domain, the owner writes `ends_with` `@example.com`. The editor's hint says so,
  because `ends_with` `example.com` also matches `notexample.com`.

`match: all` needs every condition; `match: any` needs one.

### Order, accumulation and stop

Rules run in `position` order. Every matching rule adds its actions. A matching rule with `stop`
ends the evaluation. This is Outlook's model: rules run in list order, and "Stop processing more
rules" ignores the later ones
([Microsoft Support](https://support.microsoft.com/en-gb/outlook/mail/stop-processing-more-rules-in-outlook)).
Fastmail also applies rules in list order
([Fastmail help](https://www.fastmail.help/hc/en-us/articles/1500000278122)). New rules start with
`stop` off, as Gmail filters all apply.

Accumulated result:

- forward targets: the union, deduplicated;
- `mark_read` and `star`: set when any matching rule sets them;
- `archive` and `trash`: set when any matching rule sets them; Trash wins, because a trashed
  message is out of every folder but Trash (M4 `FOLDERS`).

### Where each action runs, and why

Decision 1. All rules are evaluated once, in `email()`, for an address that accepts the message:

1. After `findAddress` accepts the recipient, one query loads the enabled rules in order, each
   with its target emails (`json_group_array` over `rule_forwards` joined to `forward_targets`).
   A rejected message costs no rule read.
2. `evaluateRules(rules, source)` in a new `worker/src/rules/evaluate.ts` returns targets and
   flags. `source` reads `message.from`, `message.to`, `message.headers` and the parsed recipient.
3. `forwardTargets(address)` in `worker/src/mail/inbound.ts`, the place M3 left for this, returns
   the address's default targets followed by the rule targets, deduplicated.
4. The flags go into the `messages` INSERT (`read`, `starred`, `archived`, `trashed`).

Why forwarding runs in `email()`: `message.forward()` exists only on the message being delivered
(PLAN, section 4).

Why the other actions are decided there too, instead of in the consumer as PLAN says:

- The conditions read only envelope and headers, which `email()` has. The consumer adds nothing a
  condition can use.
- One evaluation uses one snapshot of the rules. Two evaluations can disagree when a rule changes
  between `email()` and the parse, or when postal-mime's header decoding differs from
  `email()`'s, and `stop` then cuts different rules in the two places.
- The consumer needs no rule query and no new failure path.

The consumer changes in one place. Its first UPDATE also returns `read`, `archived` and `trashed`.
It sends the Hub event `changed` instead of `message` when the message is read, archived or in
Trash, so a filtered message refreshes open pages but sends no Web Push and no Telegram card.
Gmail's "Skip the Inbox" behaves the same way (not verified in this session). A starred message
still notifies.

### Forwarding

- Targets come only from `forward_targets`. Each target must be a verified destination address in
  the Cloudflare account (M2). The Worker cannot check verification; an unverified target fails at
  `forward()`, is caught, logged at warn and counted in `forward_failed`, as in M3.
- The loop guard covers rule targets: a message carrying `X-MelodyMail-Forwarded` is forwarded
  nowhere. `forward()` adds that header; Cloudflare allows only `X-` headers there
  ([Workers API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/),
  "Forward with custom headers").
- One message goes to one target at most once (PLAN, section 4): defaults and rule targets are
  deduplicated by the stored lowercase email.
- At most 10 distinct targets per message, defaults first, then rules in order. A message over the
  cap is forwarded to the first 10 and an audit row `mail_forward_capped` records the address id
  and the count. Reason: Workers Free allows 50 subrequests per invocation
  ([limits](https://developers.cloudflare.com/workers/platform/limits/)). Whether a `forward()`
  call counts as a subrequest is not documented; the cap holds either way.

Interaction with M2 and M3 behaviour:

- Store and forward (default): the message is stored with the rule flags and forwarded to defaults
  and rule targets.
- Forward-only address: it forwards to defaults and rule targets and stores nothing, so the flags
  are unused. If every forward fails, the message is stored as in M3, with the flags.
- Storage failure (M3 owner ruling 1): `forwardInstead` uses the same target list, rule targets
  included.
- Loop header on a forward-only address: stored instead, as in M3, with the flags.
- A rule cannot make an address forward-only or skip storage; Trash is the strongest action.
- Deleting a forward target that a rule uses: `DELETE /api/forward-targets/:id` answers 409
  `target_in_use` when rules or addresses use it, unless `?detach=1`. With `detach`, the
  `rule_forwards` rows go by cascade, and in the same batch every rule left without any action is
  disabled. The confirmation in Settings > Forwarding names those rules.

### Delete semantics

The `trash` action sets `trashed = 1` at INSERT. The message appears only in Trash, and the owner
can restore it. M4's `DELETE /api/messages/:id` stays the only permanent delete, and only from
Trash. M7's trash clean-up will later remove old Trash; it treats rule-trashed mail like any other.
Gmail ("delete") and Fastmail ("Delete to trash") both move to Trash
([Gmail help](https://support.google.com/mail/answer/6579?hl=en),
[Fastmail help](https://www.fastmail.help/hc/en-us/articles/1500000278122)).

### Changes to rules and stored mail

Creating, editing, reordering, disabling or deleting a rule changes no stored message. Gmail says
the same for forwarding filters: "only new messages will be affected"
([Gmail help](https://support.google.com/mail/answer/6579?hl=en)). Mail already in `email()`
when a rule changes uses the snapshot it loaded.

### Testing a rule against a sample

`POST /api/rules/test` takes an unsaved rule and a message id. It reads the first 64 KB of that
message's raw object (the R2 range read the consumer uses), takes the header block up to the first
empty line, unfolds it into a `Headers` object, and runs the same `evaluateRules` that `email()`
runs. The envelope sender and recipient come from the row. The answer lists each condition with
matched or not, the actions that would run, the forward targets, and whether `stop` would end the
evaluation. It changes nothing. A message without a raw object (an outbound row) answers 409
`no_raw`. CPU: the header block is at most 64 KB and each value is cut to 2,000 characters, so the
work is bounded as in `email()`.

### CPU budget

The bound: at most 50 rules × 10 conditions = 500 comparisons, each over at most 2,000 characters
per value, plus `decodeWords` and `addressParser` on at most 2,000 characters per header, plus
`JSON.parse` of the loaded rules. No step grows with the message size.

Benchmark `worker/bench/rules.ts` (`bun run bench:rules`), in the style of `bench:parse`:

- inputs: 50 enabled rules of 10 conditions that never match (every condition runs, no `stop`),
  mixing all fields and operators; headers with a 2,000-character subject of base64 and
  quoted-printable encoded words (UTF-8, GBK, ISO-2022-JP), a `To` of 100 addresses, a `header`
  condition on a header repeated 50 times, a missing `From`; plus the same rules all matching;
- it includes loading: `JSON.parse` of 50 rule rows;
- 3 runs of 200 per input on the dev workstation, load recorded;
- limit: 1 ms p95 per input, a new `REQUIREMENTS.md` "Numbers" row; the script exits 1 over it.

1 ms in Bun leaves room for the 3 ms bounded parse budget's assumption of a production CPU about
3 times slower, within the 10 ms of an `email()` invocation that also does the address lookup, the
R2 pipe (native) and the D1 writes.

## API keys

### Format and storage

- A key is `mmk_`, a public id of 8 random base32 characters (lowercase), `_`, and a secret of 32
  random bytes in base64url: 56 characters. The secret carries 256 bits of entropy. The fixed
  `mmk_` prefix makes a leaked key easy to recognise and scan for.
- Stored: SHA-256 hex of the whole key in `api_keys.token_hash` (unique), and the public id in
  `api_keys.public_id` (unique), shown in the list and in audit rows. The public id is not part of
  the secret, so nothing of the secret is stored in clear (`worker/AGENTS.md`, sensitive values).
  The key is returned once, in the create response, and never stored, logged or returned again.
  SHA-256 is enough because the secret has 256 bits of entropy (PLAN, section 8; M1
  "Constraints").
- `api_keys` columns: `id` (integer, autoincrement), `public_id`, `token_hash`, `label` (at most
  64 characters), `scopes` (JSON array), `created_at`, `expires_at` (not null), `last_used_at`,
  `last_used_ip`.
- At most 20 keys. Revoking deletes the row; the audit log keeps the record.

### Scopes

| Scope | Allows | Why it is separate |
| --- | --- | --- |
| `mail:read` | list, search, read a message and its thread, download raw, list addresses | read-only automation (backup, indexing) changes nothing |
| `mail:write` | set read, starred, archived, trashed on one or up to 100 messages | changes the mailbox but sends nothing out |
| `mail:send` | send, list the addresses that may send | speaks for the owner to outside recipients and spends Resend quota |

No scope reaches rules, keys, auth, domains, addresses, targets, settings, drafts or uploads. A
request without the route's scope answers 403 `insufficient_scope`.

### Expiry, revocation, last used

- Expiry is chosen at creation: 30, 90 (default) or 365 days, or never (owner ruling 3). The
  list marks a non-expiring key. GitHub recommends an expiration and offers 1 to 366 days or none
  ([GitHub Docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)).
- An expired key answers 401 `key_expired`; the list shows it as expired until the owner deletes
  it.
- Revoking (`DELETE /api/keys/:id`) needs a session but no re-authentication, so an emergency
  revoke is one click.
- A successful recovery deletes every API key, as it signs out every other session (M1 ruling C)
  (owner ruling 3). Audit row `api_keys_revoked` with the count.
- `last_used_at` and `last_used_ip` are written at most once per hour per key, like
  `sessions.last_seen_at` (M1). Each API request costs one indexed D1 read for the key and at most
  one write per key per hour.

### Creation

`POST /api/keys` needs a session with fresh Passkey re-authentication (`requireFreshAuth`, M1
ruling B); a stale session gets 403 `reauth_required` and the web app runs `withReauth`. The body
is `{ label, scopes, expiresInDays }`. The response is `{ key, apiKey }`, where `key` is the
secret and `apiKey` the stored metadata.

### How a request authenticates

- Only `Authorization: Bearer <key>` (RFC 6750 section 2.1). A key in the query string or the body
  is not read.
- The value must match `^mmk_[a-z2-7]{8}_[A-Za-z0-9_-]{43}$` before any D1 read; otherwise 401
  `invalid_key`.
- The Worker hashes the key with Web Crypto SHA-256 and looks up `token_hash`. An unknown hash
  answers 401 `invalid_key`. The lookup is an equality on a hash, so its time tells an attacker
  nothing about the key.
- A 401 carries `WWW-Authenticate: Bearer` (RFC 6750 section 3). The body keeps the project's
  `{ "error": "<code>" }`.
- The session cookie is ignored on `/api/v1/`; an invalid key never falls back to a session.

Coexistence with the session cookie and the CSRF guard:

- `routing.ts` gets a third route kind beside `publicRoute` and the default session route:
  `apiRoute(scope)`, which records the handler with its scope. `requireAuthorization` checks a key
  for these handlers and a session for the rest.
- `requireSameOrigin` skips `/api/v1/` handlers. That is safe because no ambient credential works
  there: a cross-site form or `fetch` carries cookies, not an `Authorization` header. A browser
  cannot add `Authorization` to a cross-origin request without a CORS preflight, because it is not
  a CORS-safelisted request header ([Fetch Standard](https://fetch.spec.whatwg.org/#cors-safelisted-request-header));
  the Worker answers no preflight, so the browser stops.
- Session routes read only the cookie. A request to them with only a key answers 401
  `unauthorized`. So keys never reach auth, key management, settings or rules.

### Rate limiting

A new Rate Limiting binding `API_LIMITER`, 120 requests per 60 s, keyed by the client IP, checked
on every `/api/v1/` request before the key lookup; over it, 429 `rate_limited` with
`Retry-After: 60`. Checking before the lookup keeps a flood of bad keys from spending D1 reads. The
binding is approximate and per Cloudflare location
([Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)); it
is an abuse guard only, as `AUTH_LIMITER` is. Sending is also bounded by the Resend quota (M5).

### Audit and logs

Audit rows: `api_key_created` (public id, scopes, expiry), `api_key_revoked` (public id),
`api_keys_revoked` (recovery, count), `rule_created`, `rule_updated`, `rule_deleted`,
`rules_reordered` (rule ids only, never condition values), `mail_forward_capped`. Log lines name a
key by its id, never by its value; the `Authorization` header is never logged.
`worker/test/log-redaction.spec.ts` gains a case that sends a key through every v1 route and
asserts the key appears in no log line and no D1 column.

## REST API v1

### Routes

All under `/api/v1/`, JSON, key only. Handlers call the same query functions as the M4 and M5
routes, moved out of the route files where they are inline today (`page`, `updateMessageFlags`, the
send flow in `worker/src/send/send.ts`).

| Route | Scope | Behaviour |
| --- | --- | --- |
| `GET /messages` | `mail:read` | As M4 `GET /api/messages`: `folder`, `address`, `cursor`, `limit` (at most 50). |
| `GET /messages/{id}` | `mail:read` | As M4: one message's metadata. |
| `GET /messages/{id}/thread` | `mail:read` | As M4. |
| `GET /messages/{id}/raw` | `mail:read` | As M4: streams the R2 object, `application/octet-stream`. |
| `GET /search` | `mail:read` | As M4 `GET /api/search`: `q`, `cursor`. |
| `GET /addresses` | `mail:read` | Id, address, display name, enabled, and whether its domain can send. |
| `PATCH /messages/{id}` | `mail:write` | As M4: `read`, `starred`, `archived`, `trashed`. |
| `PATCH /messages` | `mail:write` | As M4: up to 100 `ids`. |
| `POST /messages/send` | `mail:send` | M5 send without attachments: `from` (address id), `to`, `cc`, `bcc`, `subject`, `text`, optional `html`, optional `replyTo` (a message id, for thread headers). The `Idempotency-Key` header is required and takes the place of the body's `idempotencyKey`, with the same format and the same M5 idempotency and retry window; missing, it answers 400 `idempotency_key_required`. |

`html` from the API is the owner's own content and is sent as given; the reader shows sent HTML
only in the sandboxed frame (M4), like any other mail. The owner's web app keeps using its own
routes; `/api/v1/` has no frontend caller, so `REQUIREMENTS.md` "Exceptions" gains one row with
the reason (CLI and automation, API key).

### Errors and pagination

- One shape: `{ "error": "<code>" }`, as every other route. A validation failure answers 400
  `bad_request` with `path`, the location of the first failing field (for example `to.2`); never
  the submitted value and never the validator's message.
- Codes added: `invalid_key`, `key_expired`, `insufficient_scope`, `rate_limited`,
  `idempotency_key_required`. M4 and M5 codes keep their meaning.
- Pagination is M4's keyset cursor: the response has `nextCursor`, null on the last page.

### OpenAPI 3.1

Decision 7. Facts checked on 2026-11-16 from the npm registry and the project pages:

| Option | Version, date | Maintainer | Notes |
| --- | --- | --- | --- |
| `@hono/zod-openapi` | 1.6.3, 2026-09-04 | honojs/middleware (Yusuke Wada), npm provenance | peer `zod ^4.0.0`, `hono >=4.10.0`; depends on `@asteasolutions/zod-to-openapi ^9.1.0`, `@hono/zod-validator`, `openapi3-ts`; `doc31` and `getOpenAPI31Document` emit 3.1 ([README](https://github.com/honojs/middleware/blob/main/packages/zod-openapi/README.md)) |
| `hono-openapi` | 1.6.0, 2026-11-14 | rhinobase, one npm maintainer | any Standard Schema library (valibot, zod and others); its README says "This package is still in development" ([GitHub](https://github.com/rhinobase/hono-openapi)) |
| `chanfana` | 3.6.0, 2026-11-13 | Cloudflare | class-based endpoints over zod 4; a different route style from this codebase |
| `zod` | 4.6.7, 2026-10-12 | Colin McDonnell | |
| `valibot` | 1.5.0, 2026-09-09 | Fabian Hiller | |

Measured probe (2026-11-16, dev workstation, Ryzen 9 9950X3D, Bun 1.4.4, CPU load about 67% when
read after the runs): 15 GET and 15 POST routes with realistic schemas, built with
`bun build --minify`, gzip -6; module load and per-request times in Bun, 3 runs each.

| Probe | Bundle raw / gzip | Module load | POST with body validation, median | Document generation, first / second call |
| --- | --- | --- | --- | --- |
| plain Hono, hand validation | 21.0 / 8.6 kB | 7.5–11.2 ms | 0.003 ms | none |
| `@hono/zod-openapi` + zod | 453.6 / 109.1 kB | 24.0–48.8 ms | 0.006 ms | 10.3–11.1 / 4.6–5.4 ms |
| `hono-openapi` + valibot | 84.5 / 27.9 kB | 10.9–16.5 ms | 0.0045 ms | 15.8–20.2 / 4.2–4.3 ms |

The `hono-openapi` probe only built with its optional converter imports (`zod-to-json-schema`,
`effect` and others) marked external; wrangler's bundler would need the same configuration. The
current Worker bundle is 1,309.73 KiB, 274.59 KiB gzip (`wrangler deploy --dry-run`, 2026-11-16).
Workers have no compressed size limit and a 64 MiB uncompressed limit; global scope must run within
1 second of startup ([limits](https://developers.cloudflare.com/workers/platform/limits/)).

Choice (owner ruling 2): none of these. The document is hand-written in
`worker/src/api/openapi.json` and kept true by tests, as "Owner rulings" 2 describes. The table
and the probe stay as the record of what was compared. A signed-in owner downloads the committed
file from `GET /api/openapi.json`; Settings > API keys links to it.

## Routes added or changed (session)

| Route | Auth | Behaviour |
| --- | --- | --- |
| `GET /api/rules` | session | Rules in order, with conditions, actions and target ids. |
| `POST /api/rules` | session | Create, appended at the end. Validation as "Limits"; an unknown target id answers 400 `unknown_target`; a 51st rule answers 409 `too_many_rules`. |
| `PUT /api/rules/:id` | session | Replace name, enabled, match, conditions, actions, targets. |
| `DELETE /api/rules/:id` | session | Delete; the UI confirms. |
| `PUT /api/rules/order` | session | Body: every rule id in the new order; any other set answers 409 `order_mismatch`. One batch. |
| `POST /api/rules/test` | session | See "Testing a rule against a sample". |
| `GET /api/keys` | session | Metadata only: id, public id, label, scopes, created, expires, last used and its IP. |
| `POST /api/keys` | session, fresh | See "Creation". 409 `too_many_keys` over 20. |
| `DELETE /api/keys/:id` | session | Revoke. |
| `GET /api/openapi.json` | session | The committed OpenAPI document. |
| `DELETE /api/forward-targets/:id` | session | Changed: rules count as users of the target (see "Forwarding"). |
| `POST /api/auth/recover` | public | Changed: also deletes every API key (open question 3). |

Rule bodies are validated with zod schemas shared by the create, update and test routes.

## Authorization matrix

Every route is in exactly one row kind. The route walk in `worker/test/authz.spec.ts` lists every
route with its kind and fails on a route without one.

| Route group | No credential | Session cookie | Valid key, wrong scope | Valid key, right scope |
| --- | --- | --- | --- | --- |
| Public routes (health, sign-in, setup, recovery, signed blob URL, webhooks) | as today | as today | as today | as today |
| Session routes (auth, settings, domains, addresses, targets, mailbox, drafts, uploads, push, Telegram, rules, keys, OpenAPI document) | 401 | allowed; non-GET needs same `Origin` | 401 | 401 |
| `POST /api/keys`, and the M1 and M2 fresh-auth routes | 401 | 403 `reauth_required` unless fresh | 401 | 401 |
| `/api/v1/` `mail:read` routes | 401 | 401 | 403 | allowed, no `Origin` needed |
| `/api/v1/` `mail:write` routes | 401 | 401 | 403 | allowed, no `Origin` needed |
| `/api/v1/` `mail:send` routes | 401 | 401 | 403 | allowed, no `Origin` needed |

A request with both a cookie and a key is decided by the key on `/api/v1/` and by the cookie
elsewhere.

## Screens

Mainstream references: Gmail filters ([help](https://support.google.com/mail/answer/6579?hl=en)),
Fastmail rules ([help](https://www.fastmail.help/hc/en-us/articles/1500000278122)), Outlook rules
([support](https://support.microsoft.com/en-gb/outlook/mail/stop-processing-more-rules-in-outlook)),
GitHub personal access tokens
([docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)).

### Settings > Rules (`/settings/rules`)

- A table in the shared page frame: order, name, a one-line summary ("From contains github.com →
  Forward to a@x.com, Archive"), an enable switch, and Move up, Move down, Edit, Delete. Reorder
  uses Up and Down buttons, as Outlook does, so it works with the keyboard alone; no drag and drop.
- Create rule is the page's primary action. Create and edit open a `FormDialog`: name; "Match all"
  or "Match any"; condition rows (field, operator, value, header name for `header`; add, remove;
  at most 10); actions (Forward to: a multi-select of forward targets, with a link to Settings >
  Forwarding when there are none; Mark as read; Star; Archive; Move to Trash; Stop processing more
  rules).
- Test: in the dialog, a selector of the 20 most recent inbound messages (sender, subject, date);
  the result marks each condition as matched or not and lists the actions that would run. It says
  that a test changes nothing.
- Delete asks for confirmation. Empty state: "No rules yet" with Create rule.
- At phone width the table stacks (`REQUIREMENTS.md`, supported widths).

### Settings > API keys (`/settings/api-keys`)

- A table: label, `mmk_<public id>_` and an ellipsis, scopes, created, expires (or "Expired"),
  last used with its IP (or "Never"), Revoke. Revoke asks for confirmation and says that clients
  using the key stop working at once.
- Create key (primary action) opens a `FormDialog`: label, scope checkboxes ("Read mail", "Change
  mail flags", "Send mail"), expiry (30, 90, 365 days). It runs through `withReauth`.
- After creation the key is shown once, with a copy button and the note that it will not be shown
  again, in the pattern of `RecoveryKeyPanel`; closing needs "I have copied it".
- A link "Download the OpenAPI document" (`GET /api/openapi.json`).

Both pages: copy in zh-CN, en and ja-JP; skeletons from the first paint; lazy chunks, so first
paint does not grow; side navigation entries beside Forwarding.

## Proof the change needs (High risk)

- **Worker integration tests** (workerd, real D1, R2 and Queues; `fetch` rejecting by default):
  - evaluation units: each field and operator; case folding; white space; encoded-word subject;
    folded header; repeated header; missing `From`; sub-address `recipient` and `tag`; `all` and
    `any`; accumulation; `stop`; Trash over archive; a value cut at 2,000 characters;
  - `email()`: a rule forwards to its target once; a target that is both default and rule target
    is forwarded once; the loop header stops rule forwards; forward-only with rule targets stores
    nothing; forward-only with all forwards failing stores with the flags; the storage fallback
    forwards to rule targets; the 10-target cap and its audit row; a disabled rule does nothing;
    flags land in the INSERT; a rejected recipient reads no rules;
  - the consumer sends `changed` for a read, archived or trashed message and `message` otherwise;
  - rules CRUD validation, limits, `unknown_target`, `order_mismatch`; editing a rule changes no
    stored row; deleting a used target answers 409, and with `detach` disables the rule left
    without actions;
  - `POST /api/rules/test` returns what `email()` decides for the same fixture;
  - keys: creation needs fresh re-authentication; the key is returned once; no D1 column holds or
    contains it; `GET /api/keys` never returns it; malformed, unknown, expired and revoked keys
    answer 401; a missing scope answers 403; `last_used_at` is written once in an hour of
    requests; the rate limit answers 429; recovery deletes every key; audit rows;
  - v1: each route against its M4 or M5 counterpart's results; send needs `Idempotency-Key`; the
    same key twice sends once; a v1 POST without `Origin` passes; a session POST without `Origin`
    still answers 403;
  - the authorization matrix above, row by row, for every registered route, through the route
    walk;
  - log redaction: a key sent through every v1 route appears in no log line.
- **Gates:** `bun run check:openapi` red on a planted drift; `bun run bench:rules` under 1 ms p95,
  red on a planted slow input.
- **Ablation** of every behaviour hunk, with results in `docs/STATE.md`.
- **Startup:** `wrangler check startup` profile before and after the dependency, recorded in
  `docs/STATE.md`.
- **Migration:** `bun run db:migrate:local` applies 0013 on a local database with rows; a second
  run applies nothing.
- **Browser tier:** both pages, the rule dialog with the test, key creation through re-auth, the
  show-once panel, revoke. Screenshots at 390, 1280 and 1920 px, light and dark, three locales,
  with real data.
- **Bundle:** first paint within 370 kB, total within 770 kB.
- **Review:** an independent review by a different model family; when none is available, the
  owner reviews (`AGENTS.md`, Model usage).
- **Not verifiable locally, record as unverified:** real Email Routing delivery with rule
  targets; whether `forward()` counts as a subrequest; whether `message.headers` unfolds; isolate
  start in production `cpuTime`; the API rate limit across locations.

## Owner rulings (2026-11-16)

1. Every rule action is decided once in `email()`; flags are written at INSERT; a message that a
   rule marks read, archives or moves to Trash sends no Web Push and no Telegram (Decision 1).
2. The OpenAPI document is hand-written, with no runtime dependency, because the same Worker
   receives mail and a heavier isolate start is not worth the risk. This replaces the
   `@hono/zod-openapi` choice in "OpenAPI 3.1": there is no `spec.ts`, no generation script and
   no `check:openapi`. Instead the worker suite (a) walks every registered `/api/v1/` route and
   asserts exactly one matching operation (path, method, security scope) in the document and the
   reverse, and (b) validates every response body that the API tests receive against the
   operation's response schema with a small JSON Schema subset checker written for the test
   (type, required, properties, items, enum, nullable), so a changed response shape turns red. A
   planted drift (an undocumented field, a missing route) must turn red before it counts.
   `GET /api/openapi.json` (session) still serves the committed file.
3. A successful recovery deletes every API key. Expiry choices: 30, 90 (default), 365 days, or
   never.
4. The sub-address on/off switch stays deferred; sub-addressing stays always on.

## Open questions for the owner (asked 2026-11-16, answered above)

1. **Decide every rule action in `email()`.** PLAN runs mark, archive and delete in the consumer
   after parsing. Recommended: evaluate once in `email()` and write the flags at INSERT (see
   "Where each action runs"). One rule snapshot, one place for `stop`, no second rule query.
2. **Dependency for the OpenAPI document.** Recommended: `@hono/zod-openapi` 1.6.3 with zod
   4.6.7, as PLAN's Hono + Zod: about 430 kB more bundle and about 16 ms more module load in Bun
   at isolate start. Alternatives: `hono-openapi` 1.6.0 with valibot (about 64 kB more, about
   4 ms more load, still "in development", needs bundler externals), or a hand-written document
   checked against the routes by a test.
3. **Recovery deletes every API key.** Recommended: yes, as recovery signs out every other
   session (M1 ruling C). The cost: automations stop after a recovery until new keys are made.
4. **Key expiry.** Recommended: 30, 90 (default) or 365 days, no non-expiring key; a renewed key
   is a new key.
5. **Sub-address switch.** `docs/M3-inbound.md` deferred the "sub-addressing on or off" setting
   to M6, but PLAN's M6 row does not list it. Recommended: leave it out of M6 and record it in
   the deferred list; sub-addressing stays always on.

## Deferred (proposed)

- Rules in the REST API (scope `rules:write`). Source: this design, "Scope".
- Applying a rule to stored mail. Source: Gmail and Fastmail comparison.
- Recording which rules applied to a message, shown in the reader. Source: this design.
- Skipping `forward()` when `message.canBeForwarded` is false: the Workers API now lists that
  property ([Workers API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/));
  today a failing forward is caught and counted. Source: the check for this design.
- Attachments in API sends. Source: this design, "Scope".
- The sub-address on/off switch (M3 deferral). Source: owner ruling 4.
