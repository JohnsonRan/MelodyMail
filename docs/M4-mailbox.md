# M4: web mailbox design

Risk class: High. The app renders HTML that any sender controls, inside the owner's
authenticated origin. Read `AGENTS.md`, `worker/AGENTS.md`, `web/AGENTS.md`, `web/ASTRYX.md`,
`REQUIREMENTS.md`, `docs/PLAN.md` (sections 2, 3, 4, 7, 8), `docs/STATE.md` (owner rulings for
M1–M3, the M3 carry-over) and `docs/M3-inbound.md` first. This file decides the M4 design. Record
deviations under "Open questions" in `docs/STATE.md`.

## Constraints

- Workers Free: 10 ms CPU per invocation. The Worker streams raw mail and runs indexed queries.
  It never parses or renders mail. Full MIME parsing runs in the browser (PLAN, "CPU budget").
- Single owner. Every new route is guarded and appears in the authz route walk.
- Astryx only (`web/ASTRYX.md`); copy in zh-CN, en and ja-JP; `web/AGENTS.md` layout rules
  (skeletons, no truncated values, phone width, keyboard, one title per page).
- Bun for all tooling; wrangler alone on Node.

## API (all guarded)

| Route | Behaviour |
| --- | --- |
| `GET /api/messages` | Query `folder` = `inbox` \| `starred` \| `archive` \| `trash`, optional `address` (id), `cursor`, `limit` (≤ 50). Keyset pagination on `(received_at DESC, id DESC)`. Returns list fields only: id, address, from, subject, snippet, date, size, flags, has_attachments, status, thread_key. |
| `GET /api/messages/:id` | One message's metadata. |
| `GET /api/messages/:id/thread` | All messages with the same `thread_key`, oldest first. |
| `GET /api/messages/:id/raw` | Streams the R2 object as the response body, with no JS work. Headers: `Content-Type: application/octet-stream`, `Content-Disposition: attachment`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`. A browser that opens the URL directly therefore never renders it. |
| `PATCH /api/messages/:id` and `PATCH /api/messages` | Set read, starred, archived and trashed, on one message or on up to 100 `ids`. |
| `DELETE /api/messages/:id` | Permanent delete of a message that is already in trash: removes the R2 object, the row and the FTS row. The UI asks for confirmation. |
| `GET /api/search` | Query `q`, `cursor`. Uses M3's `buildSearch`; same list fields and pagination. |
| `GET /api/counts` | Unread counts per folder and per address. |
| `GET /api/events` | WebSocket upgrade to the Hub Durable Object (below). It needs a valid session and an `Origin` equal to the request's own origin. |

Migration 0007 adds the index the folder queries need, for example
`(trashed, archived, received_at DESC)`. It is additive and safe on a database that holds rows.

## Real-time push

- One Durable Object, `Hub` (SQLite-backed, which Workers Free requires). It uses the WebSocket
  Hibernation API (`ctx.acceptWebSocket`, `webSocketMessage`, `webSocketClose`) and an
  auto-response for pings, so an idle connection is not billed for duration.
- The Worker validates the session before it forwards the upgrade. Each socket is tagged with
  its session id hash.
- After a message is parsed, the queue consumer calls `hub.notify({ id })` (one RPC). A failure is
  logged and never fails the parse.
- The event carries ids only, never content. The client then refetches the list and counts
  through the normal authenticated routes.
- Signing out or revoking sessions calls `hub.closeSessions(hashes)`, which closes the tagged
  sockets.
- The client reconnects with backoff. When reconnecting fails with 401, it sends the owner to
  sign-in.

## Reading mail in the browser (the security core)

1. The client fetches `/raw` and parses it with `postal-mime` in a Web Worker, so the page stays
   responsive on a 25 MiB message. A size over 5 MiB shows a progress state.
2. **Plain-text bodies** render as React text, with links turned into anchors
   (`rel="noopener noreferrer"`, `target="_blank"`). No HTML is involved.
3. **HTML bodies** render only inside an iframe with every layer below:
   - `sandbox="allow-popups allow-popups-to-escape-sandbox"`. That means no scripts, no
     same-origin, no forms and no top navigation. Only links that open a new tab are allowed.
   - `srcdoc` built from the sanitized HTML, with a CSP `<meta>` placed first in `<head>`:
     `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:`. Remote
     images, fonts, CSS and frames are therefore blocked by default.
   - A `<meta name="referrer" content="no-referrer">`.
   - Sanitizing with DOMPurify before `srcdoc`, as defence in depth. Remove `script`, `iframe`,
     `object`, `embed`, `form`, `base`, every `<meta http-equiv>` (refresh can navigate the frame)
     and event-handler attributes. Every `<a>` gets `target="_blank"` and
     `rel="noopener noreferrer"`. Keep inline styles and `<style>`, because mail layout needs them.
   - **Inline images** (`cid:`): rewrite them to `data:` URLs from the parsed attachment. A
     `blob:` URL would not load, because the sandboxed frame has an opaque origin. Inline parts
     above a size cap (2 MiB) show a placeholder.
   - **Remote images:** a "Show remote images" action re-renders that message with
     `img-src data: https:`. The choice is not remembered in M4.
   - The frame height follows its content through `ResizeObserver` on the parent side. The frame
     cannot run scripts, so the parent measures the srcdoc document after load.
     `allow-same-origin` must never be added. If measuring is not possible without it, use a fixed
     height with a scrollable frame and record the trade-off.
4. **Attachments** are always downloaded and never opened in the app's origin:
   - create the Blob with type `application/octet-stream`;
   - download through an `<a download="<sanitized filename>">`;
   - revoke the object URL afterwards.

   A `blob:` URL of a `text/html` or `image/svg+xml` attachment opened in a tab would run in the
   app's origin and could call the API, so it is forbidden.
5. **`parse_failed` messages and late text.** Both go through the same browser parse. The list
   shows a neutral "no preview" line instead of a snippet.
6. **Marking read.** Opening a message marks it read. Unread is toggled from the toolbar.

## Screens

- **Shell:** the M1–M2 `AppShell`.
  - Side navigation lists Inbox, Starred, Archive and Trash, plus one entry per address, all with
    unread counts.
  - Sent and Drafts arrive with M5 and stay hidden until then.
  - A search field sits in the top bar.
- **Layout by width:**
  - at 1280 px and wider, the list and the reader sit side by side;
  - below that, one pane at a time, with back navigation;
  - at 390 px, nothing is cut off and there is no horizontal scroll.
- **List:**
  - each row shows sender, subject, snippet, date, an unread marker, a star and an attachment
    icon;
  - row selection supports bulk archive, trash, star and mark read;
  - the next page loads when the list is scrolled near its end;
  - loading shows a skeleton;
  - empty and error states are designed states.
- **Reader:**
  - the thread view, oldest first, with the newest message expanded;
  - headers: from, to, cc, date and the sub-address tag;
  - a toolbar with archive, trash, star, mark unread, show remote images, and permanent delete
    (in Trash, with confirmation);
  - the attachment list with sizes.
- **Keyboard:** every action is reachable by Tab with visible focus. Shortcuts: `j` and `k`
  move, `Enter` opens, `e` archives, `#` trashes, `s` stars, `u` goes back to the list, `/`
  searches. They are off while focus is in a text field.
- **Copy:** every string is in all three locales.

## Proof the change needs (High risk)

- **Worker integration tests for every route:**
  - folder filters, the address filter, keyset pagination with no gaps or duplicates, bulk limits;
  - the raw response headers and that the body is streamed;
  - permanent delete only from trash, removing the row, the FTS row and the R2 object;
  - search including two-character Chinese terms;
  - counts;
  - the WebSocket upgrade refused without a session and with a bad `Origin`;
  - `notify` reaching a connected socket, and `closeSessions` closing it;
  - a notify failure not failing the parse;
  - 401 without a session for every route, through the route walk.
- **Rendering security tests in the browser test runner:** run them against a corpus of hostile
  HTML and assert the sanitized `srcdoc` and the frame attributes. The corpus:
  - script tags, `onerror` and `onload` handlers;
  - `<meta http-equiv="refresh">`, `<base href>`, forms;
  - `javascript:`, `data:` and `vbscript:` links;
  - SVG with script;
  - CSS `url()` to remote hosts;
  - `@import`;
  - remote `<img>` and tracking pixels;
  - a `cid:` image;
  - an HTML attachment.

  Assert that no request leaves the page while remote images are off. If the project has no
  browser test runner, add one. Use Playwright if it runs under Bun; if it does not, stop,
  record it, and propose an alternative. Do not fall back to Node.
- **Screenshots:** every new screen at 390, 1280 and 1920 px, light and dark, in all three
  locales. Use real-looking data seeded into the local D1 and R2: a script that runs the M3
  `email()` path on the fixture `.eml` files, so the list is not empty.
- **Ablation** of every behaviour hunk, with results in `docs/STATE.md`.
- **Bundle:** first paint stays within its 370 kB limit (gzip). `postal-mime` and DOMPurify load
  only with the reader chunk. Record the new numbers.
- **Not verifiable locally:** Durable Object hibernation billing, real WebSocket behaviour behind
  Cloudflare, and real mail arriving. Record these as unverified.
