# M5c: in-page notice and quiet foreground

Risk class: Medium. It changes when Web Push and Telegram messages are sent, and adds a notice
to the page. No login, secret or stored-data change. Owner requests of 2026-11-16, recorded in
`docs/STATE.md`, M5b, "Owner requests after the tunnel test".

## Scope

1. **In-page notice.** While a MelodyMail page is in the foreground and new mail arrives, the
   page shows a notice with the sender and the subject and an Open button. The notice hides
   itself after a few seconds. It never shows the body.
2. **Quiet foreground.** While any MelodyMail page is in the foreground, the Hub sends neither Web
   Push nor the Telegram message for new mail. This supersedes M5b ruling 3 ("a card is sent even
   while a page is open"). When no page is in the foreground, both go out as today.
3. **Gate race.** `scripts/check.ts` runs `build` and the worker `test` at the same time, and the
   worker pool reads `web/dist` while `build` rewrites it (one run in about 20 failed with
   `ENOENT web\dist\sw.mjs`). Remove the race.

## Design

### Foreground state

- "Foreground" means `document.visibilityState === "visible"` and `document.hasFocus()`. The page
  re-evaluates it on `visibilitychange`, `focus` and `blur`.
- The page sends `"fg"` or `"bg"` over its existing `/api/events` WebSocket when the state
  changes and right after the socket opens. `"ping"` stays auto-answered.
- The Hub stores the state on the socket with `serializeAttachment`, so it survives hibernation.
  `webSocketMessage` accepts only `"fg"` and `"bg"` and ignores anything else. A socket that never
  reported counts as background.
- A message wakes the Hub: on a state change and on the 30 s `"fg"` refresh (see "Owner ruling:
  a switch, default off" for the refresh, the 1 s re-check and the cost).

### Hub.notify for new mail

- If any socket is in the foreground: send the event to pages as today, and skip Web Push and
  Telegram entirely.
- Otherwise: unchanged (push to sessions without a page, Telegram card or message, and hidden
  pages notify themselves through `notifyWhenHidden`).
- A page that crashed without closing its socket is cleaned up by the runtime when the socket
  closes; until then its last reported state holds, at most 75 s (see the ruling section below;
  `blur` alone is not enough, since focus inside the reader frame sends none).

### The notice

- In `MailboxProvider`, on a `message` event while the page is in the foreground, fetch the
  message (as `notifyWhenHidden` does) and show the notice. Use the Astryx toast or notification
  component if one exists (`astryx search`), otherwise the closest Astryx component; follow
  `web/AGENTS.md` (layout, i18n in zh-CN, en and ja-JP, accessibility: the notice is announced
  politely and does not take focus).
- Open navigates to the message. Several notices in a row stack or replace each other; at most
  three are visible.

### Gate race

- Measure the gate's baseline first (three runs, load recorded).
- Pick the smallest fix that removes the race without exceeding the 15 s limit, for example
  running `build` before the steps that read `web/dist`, or pointing the worker test pool at a
  directory `build` does not rewrite. Show the race is gone (a planted delay or repeated runs).

## Proof

- Worker: Hub tests for `"fg"`/`"bg"` handling, attachment survival, and notify skipping push and
  Telegram when a socket is in the foreground and sending both otherwise.
- Web: browser tests for the foreground reports and the notice (shown in the foreground, not when
  hidden, Open navigates, no body text).
- Ablate every behaviour hunk or list the ones not ablated.
- Screenshots of the notice at 390, 1280 and 1920 px, light and dark, three locales.
- Real check by the owner on local `wrangler dev` (no Telegram traffic needed for the notice).

## Owner ruling: a switch, default off (2026-11-16)

Quiet foreground can hide a notification the owner needed on another device, so it becomes a
setting, off by default.

- Settings > Notifications has a switch "Quiet while MelodyMail is open", with one line saying
  that no system notification and no Telegram message is sent while a MelodyMail page is in the
  foreground on any device. It is stored in D1 (`settings`, one row, migration 0012) and changed
  with a normal session; it guards no secret, so it needs no fresh passkey.
- Off: the Hub notifies exactly as in M5b. Push goes to sessions without a page, Telegram always,
  hidden pages notify themselves, and no event carries `quiet`.
- On: the behaviour above, with the review fixes: the page re-checks its state every second and
  repeats `"fg"` every 30 s, and the Hub counts an `"fg"` older than 75 s as background.
- The in-page notice shows in both modes while the page is in the foreground.
- The Hub reads the setting only for new mail while a fresh `"fg"` exists: one D1 row read.
