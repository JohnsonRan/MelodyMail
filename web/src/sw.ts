/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { notification as en, app as enApp, mail as enMail } from "./locales/en/common.json";
import { notification as ja, mail as jaMail } from "./locales/ja-JP/common.json";
import { notification as zh, mail as zhMail } from "./locales/zh-CN/common.json";
import { clickTarget, type NotificationCopy, notificationFor } from "./pwa/notification";

// The service worker (docs/M4b-pwa.md). It caches the app shell only: the build's hashed assets,
// index.html, the manifest and the icons. No route caches or answers /api/*, so no mail and no
// user data is ever stored here.

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// Navigations open the precached shell, so the app starts offline.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), { denylist: [/^\/api\//] }),
);

// registerType "prompt": a new worker waits until the page's Reload sends this message.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});

const COPY: Record<string, NotificationCopy> = {
  en: { ...en, noSubject: enMail.noSubject },
  ja: { ...ja, noSubject: jaMail.noSubject },
  zh: { ...zh, noSubject: zhMail.noSubject },
};

function copyFor(language: string): NotificationCopy {
  const base = language.toLowerCase().split("-")[0] ?? "en";
  return COPY[base] ?? (COPY.en as NotificationCopy);
}

self.addEventListener("push", (event) => {
  let data: unknown = null;
  try {
    data = event.data?.json();
  } catch {
    // Not JSON: shown as a plain "New mail".
  }
  const { title, options } = notificationFor(data, copyFor(navigator.language), enApp.name);
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = clickTarget(event.notification.data);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows[0];
      // navigate() needs a window this worker controls; otherwise open a new one.
      const moved =
        open &&
        (await open
          .focus()
          .then((w) => w.navigate(url))
          .catch(() => null));
      if (!moved) await self.clients.openWindow(url);
    })(),
  );
});

/** The VAPID public key, or null when push is not set up or the Worker is out of reach. */
async function serverKey(): Promise<string | null> {
  try {
    const res = await fetch("/api/push/key", { credentials: "same-origin" });
    return res.ok ? ((await res.json()) as { key: string }).key : null;
  } catch {
    return null;
  }
}

// The push service replaced the subscription. Subscribe again with the same key and store it;
// without a session (401) or without push set up, nothing happens.
self.addEventListener("pushsubscriptionchange", (event) => {
  const change = event as Event & {
    oldSubscription?: PushSubscription | null;
    newSubscription?: PushSubscription | null;
  };
  event.waitUntil(
    (async () => {
      const key = change.oldSubscription?.options.applicationServerKey ?? (await serverKey());
      const subscription =
        change.newSubscription ??
        (key
          ? await self.registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: key,
            })
          : null);
      if (!subscription) return;
      await fetch("/api/push/subscription", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      }).catch(() => undefined);
    })(),
  );
});
