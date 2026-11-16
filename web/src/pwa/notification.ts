// What a push or a live event shows as a system notification. Shared by the service worker
// (src/sw.ts) and the page, which notifies by itself while it is open but hidden
// (docs/M4b-pwa.md, "Sending"). Pure functions, so the tests can call them directly.

/** The payload the Worker encrypts (worker/src/push/send.ts, PushMessage). */
export type PushMessage =
  | { type: "message"; id: string; from: string; subject: string | null; to: string }
  | { type: "test" };

/** The localized fallbacks, from the `notification` section of the locale catalogs. */
export type NotificationCopy = { newMail: string; noSubject: string; testBody: string };

export type NotificationSpec = { title: string; options: NotificationOptions };

const ICON = "/pwa-192x192.png";

/** The message's address in the app: the inbox with the message open (router.tsx, `m`). */
export function messageUrl(id: string): string {
  return `/?m=${encodeURIComponent(id)}`;
}

function isMessage(data: unknown): data is Extract<PushMessage, { type: "message" }> {
  if (data === null || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return d.type === "message" && typeof d.id === "string" && d.id.length > 0;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function notificationFor(data: unknown, copy: NotificationCopy, appName: string) {
  if (isMessage(data)) {
    const subject = text(data.subject) || copy.noSubject;
    const to = text(data.to);
    return {
      title: text(data.from) || copy.newMail,
      options: {
        body: to ? `${subject}\n${to}` : subject,
        // Repeats of one message replace each other instead of stacking.
        tag: `message:${data.id}`,
        icon: ICON,
        data: { url: messageUrl(data.id) },
      },
    } satisfies NotificationSpec;
  }
  if (data !== null && typeof data === "object" && (data as { type?: unknown }).type === "test") {
    return {
      title: appName,
      options: { body: copy.testBody, tag: "test", icon: ICON, data: { url: "/" } },
    } satisfies NotificationSpec;
  }
  return {
    title: copy.newMail,
    options: { tag: "mail", icon: ICON, data: { url: "/" } },
  } satisfies NotificationSpec;
}

/** Where a click on a notification goes: an absolute URL on the app's origin, never another. */
export function clickTarget(data: unknown, origin: string): string {
  const url = data !== null && typeof data === "object" ? (data as { url?: unknown }).url : null;
  const home = `${origin}/`;
  if (typeof url !== "string") return home;
  // Resolved here and returned absolute: a relative result such as "//evil.example" (from
  // "/.//evil.example") would be resolved again by openWindow() and could leave the origin.
  let target: URL;
  try {
    target = new URL(url, origin);
  } catch {
    return home;
  }
  return target.origin === origin ? target.href : home;
}
