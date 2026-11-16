# M4b: PWA, push notifications and dark reading

Risk class: High. The change adds a service worker that controls the owner's origin, a new
Worker secret (the VAPID private key), a table that links sessions to push endpoints on third-party
push services, and requests from the Worker to those services. Read `AGENTS.md`,
`worker/AGENTS.md`, `web/AGENTS.md`, `web/ASTRYX.md`, `REQUIREMENTS.md`, `docs/PLAN.md` (sections
3, 7, 8), `docs/STATE.md` (owner rulings for M1–M4) and `docs/M4-mailbox.md` first. This file
decides the M4b design. Record deviations under "Open questions" in `docs/STATE.md`.

## Scope

1. Installable PWA: manifest, icons, service worker that caches the app shell only.
2. Offline: the shell opens and shows an offline state; no mail is cached.
3. Web Push for new mail while no page of the app is open.
4. Dark reading: a per-message toggle that shows HTML mail inverted (owner, 2026-11-16).

Out of scope: offline reading of opened mail (PLAN section 3), push for anything other than new
mail, a notification history.

## Libraries (owner preference: use maintained libraries, not own code)

- **Service worker:** `vite-plugin-pwa` with the `injectManifest` strategy. Workbox precaches the
  build output; our own service worker source adds the push and click handlers.
- **Icons:** `@vite-pwa/assets-generator` from one source SVG. The repository has no logo file:
  draw a simple mark (an envelope with a note) in the Astryx accent color, one SVG, and record it
  for the owner's screenshot review.
- **Web Push (Worker side):** a zero-dependency library on Web Crypto and `fetch` that sends
  `aes128gcm` (RFC 8291) with VAPID (RFC 8292) and does not need `nodejs_compat`. Candidates found
  on 2026-11-16: `@mmmike/web-push` (tests pinned to the RFC 8291 Appendix A vector),
  `@portable/web-push`, `@pushforge/builder`, `@block65/webcrypto-web-push` 2.x. Check each
  candidate's last release, license, open issues and tests before choosing; record the choice and
  why in STATE. Never `web-push` (Node crypto).

## Service worker and caching

- Precache only the build's hashed assets, `index.html`, the manifest and the icons.
- `/api/*` is never cached and never answered from cache: no runtime caching route matches it, and
  the navigation fallback excludes it (`navigateFallbackDenylist: [/^\/api\//]`).
- Navigations fall back to the precached `index.html`, so the shell opens offline.
- Updates: `registerType: "prompt"`. A new service worker waits; the app shows a banner "A new
  version is available" with a Reload action. Reason: an open page that lazy-loads a chunk from a
  removed deployment would fail; reloading onto the new worker avoids mixed versions.
- Registration happens after first render, from a chunk that is not part of first paint. First
  paint stays within its 370 kB limit.
- Sign-out clears nothing from the cache, because the cache holds no mail or user data. A test
  proves no `/api` response is in Cache Storage after browsing the mailbox.

## Offline state

- When an API call fails with a network error, or `navigator.onLine` is false, the shell shows a
  designed offline state (Astryx Banner) instead of an error boundary. It recovers on the `online`
  event and on the next successful call.
- Sign-in and Passkey flows need the network; offline they show the same state.

## Manifest

- `name` and `short_name` are the brand "MelodyMail", the same in every locale (the manifest is
  one file; PLAN asked for names in three languages, but the brand is not translated, and this is
  recorded as a deviation). `description` in English.
- `start_url: "/"`, `scope: "/"`, `display: "standalone"`, `theme_color` and `background_color`
  from the Astryx neutral theme, icons 192 and 512 px plus a maskable 512 px.
- `index.html` gets `<link rel="manifest">`, `theme-color` metas for light and dark, and an
  `apple-touch-icon`.

## Push notifications

### Data

Migration 0008 adds `push_subscriptions`:

| Column | Notes |
| --- | --- |
| `id` | text primary key |
| `session_id` | references `sessions.id` `ON DELETE CASCADE` |
| `endpoint` | text, unique |
| `p256dh`, `auth` | the browser's keys (not secrets of ours; they only let us encrypt to it) |
| `created_at` | |

The cascade ties each subscription to the device's session. Sign-out, revoke, recovery and the
expiry sweep (`DELETE FROM sessions ...`) remove the device's subscription with no extra code, so a
revoked device stops receiving subjects. Sending also joins on live sessions (not expired, not
idle-expired) so a session that expired but was not swept yet gets nothing.

### Routes (all guarded, all in the authz route walk)

| Route | Behaviour |
| --- | --- |
| `GET /api/push/key` | The VAPID public key, or 404 when push is not configured. |
| `PUT /api/push/subscription` | Body: the `PushSubscription` JSON. Upserts by endpoint for the current session (an endpoint moved from another session is reassigned). |
| `DELETE /api/push/subscription` | Removes the current session's subscription. |
| `POST /api/push/test` | Sends one test notification to the current session's subscription. Rate limited with the existing limiter pattern. |

Endpoint validation on PUT: `https:` only, and the host must belong to a known push service:
`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`,
`*.notify.windows.com`. Anything else is 400. Reason: the Worker POSTs to this URL; the allowlist
keeps it from becoming a request relay even with a stolen session. Key lengths are checked
(`p256dh` a 65-byte P-256 point, `auth` 16 bytes).

### Sending

- The queue consumer already calls `hub.notify({ id })` after a parse. The Hub returns how many
  sockets it reached. When it reached none, the Hub itself sends the push (one more step inside the
  same RPC), so the encryption and the subrequests run in the Hub's invocation and the consumer's
  10 ms CPU budget is untouched. A push failure is logged with ids and status only, and never
  fails the parse.
- When a page is open but hidden (another tab, minimized), the page shows the notification itself
  through `registration.showNotification` on the live event, if permission is granted. So the
  owner is notified exactly once either way.
- Payload (encrypted end to end; the push service sees only size and timing): message id, sender
  display name (or address), subject, and the address it arrived at. Truncate the subject to 200
  characters. No body text, no snippet. This content is an open question for the owner, see below.
- TTL 24 hours, urgency `normal`. A 404 or 410 deletes the subscription. Other errors are logged.
- VAPID subject: the app's own `https://` origin, so no e-mail address is sent to push services.
- Subrequests: one per subscription. A single owner has a handful of devices; cap at 10
  subscriptions per send (oldest dropped on PUT beyond 10) to stay far below 50.

### Service worker side

- `push` event: show a notification with the sender as title and the subject as body; tag it with
  the message id so repeats replace each other. Localize the fallback strings ("New mail", "(no
  subject)") from `navigator.language` with the three locales' copy.
- `notificationclick`: focus an open window of the app and navigate it to the message, or open
  `/m/<id>` (match the router's actual message route).
- `pushsubscriptionchange`: resubscribe and PUT the new subscription when the session cookie still
  works; otherwise do nothing.

### Settings UI

A "Notifications" section in settings, per device:

- state: not supported (with the reason, for example "Add to Home Screen first" on iOS), blocked
  by the browser, off, on;
- a switch that asks for permission only on the owner's click, subscribes and PUTs, or
  unsubscribes and DELETEs;
- a "Send test notification" action.
- When the Worker has no VAPID keys (`GET /api/push/key` 404), the section says push is not set up
  and points to the README.

### Secrets and configuration

- `VAPID_PRIVATE_KEY` is a Worker secret; `VAPID_PUBLIC_KEY` a var or secret. Add both to
  `worker/.dev.vars.example` with empty values and a generator script (`bun run vapid`) that prints
  a fresh pair using the chosen library or Web Crypto.
- README: how to generate the keys, `wrangler secret put`, and that changing the key pair drops
  every subscription (clients resubscribe from settings).
- Nothing about keys, endpoints or payloads goes into logs. Log the subscription id and the push
  service status.

## Dark reading

- In the reader toolbar, a toggle "Dark reading" for HTML messages, shown when the app theme is
  dark. Off by default, not remembered (owner ruling: the default stays white).
- On, the srcdoc gets an extra inline style: `html{filter:invert(1) hue-rotate(180deg)}` and the
  same filter again on `img, video, picture, svg image` and elements with a `background-image` so
  pictures look normal. No script, no change to the sandbox or the CSP.
- It combines with "Show remote images".

## Proof the change needs (High risk)

- **Worker integration tests:**
  - every push route, 401 without a session through the route walk;
  - endpoint allowlist (accepts each listed host, rejects `http:`, other hosts, IP literals,
    userinfo tricks such as `https://fcm.googleapis.com@evil.example/`), key-length checks;
  - upsert by endpoint, the 10-subscription cap;
  - the cascade: sign-out, revoke and recovery each remove the session's subscription;
  - Hub sends when no socket is open and does not when one is; an expired session gets nothing;
  - a 410 deletes the subscription; a send failure does not fail the parse;
  - the outgoing request has an `aes128gcm` body and a VAPID `Authorization` header, with `fetch`
    stubbed. No test traffic to a real push service (hard limit) unless the owner allows it.
- **Library check:** a test that decrypts the library's output with the subscription's private key
  (generated in the test) and gets the payload back, so a wrong library choice turns it red.
- **Browser tier:**
  - the manifest is valid and Chromium reports no installability error
    (`Page.getInstallabilityErrors` over CDP with a persistent context);
  - the service worker controls the page; after browsing the mailbox, Cache Storage holds no
    `/api` URL;
  - offline (`context.setOffline(true)`): reloading shows the shell and the offline state, not an
    error boundary; going online recovers;
  - the update banner appears when a new worker is waiting;
  - dark reading: the srcdoc carries the filter only when toggled, the sandbox and CSP are
    unchanged, and the hostile corpus still produces no request with it on;
  - the push and click handlers, tested as functions (payload to notification options, click to
    URL), since a real push cannot be delivered in the test.
- **Screenshots:** the notifications section in all its states, the offline state, the update
  banner and dark reading, at 390, 1280 and 1920 px, light and dark, three locales.
- **Bundle:** first paint within 370 kB, total within 770 kB; record the service worker's size
  separately (it is not part of the page).
- **Ablation** of every behaviour hunk, results in STATE.
- **Not verifiable locally, record as unverified:** delivery through real push services (unless
  the owner allows a test to their own browser), iOS Home Screen push, Firefox and Safari install,
  Hub CPU time in production.

## Open questions for the owner (asked at the start)

1. Notification content: sender and subject (recommended), or only "New mail" with no content?
2. May a manual test send real pushes from local `wrangler dev` to the owner's own Chrome through
   Google's push service (FCM)? Without it, real delivery stays unverified until deploy.
