import { ApiError, api } from "../api";

// This device's Web Push state and the switch behind Settings > Notifications
// (docs/M4b-pwa.md, "Settings UI"). Permission is asked only from the owner's click.

export type PushState =
  | { kind: "unsupported"; reason: "browser" | "homeScreen" }
  | { kind: "notConfigured" }
  | { kind: "blocked" }
  | { kind: "off"; key: string }
  | { kind: "on"; key: string };

function isAppleMobile(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1)
  );
}

function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

const sameKey = (subscription: PushSubscription, key: string) => {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return encoded === key;
};

/** The current subscription of this device, if the app's service worker is registered. */
async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function readPushState(): Promise<PushState> {
  if (!pushSupported()) {
    // iOS and iPadOS offer push only to a web app opened from the Home Screen.
    return { kind: "unsupported", reason: isAppleMobile() ? "homeScreen" : "browser" };
  }
  let key: string;
  try {
    key = (await api<{ key: string }>("GET", "/push/key")).key;
  } catch (err) {
    if (err instanceof ApiError && err.code === "push_not_configured") {
      return { kind: "notConfigured" };
    }
    throw err;
  }
  if (Notification.permission === "denied") return { kind: "blocked" };
  const subscription = await currentSubscription();
  if (subscription && !sameKey(subscription, key)) {
    // Made with an earlier key pair: push services refuse it now (README, "Notifications").
    await subscription.unsubscribe();
    return { kind: "off", key };
  }
  return subscription ? { kind: "on", key } : { kind: "off", key };
}

/** Asks for permission, subscribes and stores the subscription; returns the new state. */
export async function turnOn(key: string): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission === "denied") return { kind: "blocked" };
  if (permission !== "granted") return { kind: "off", key };
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  try {
    await api("PUT", "/push/subscription", subscription.toJSON());
  } catch (err) {
    await subscription.unsubscribe();
    throw err;
  }
  return { kind: "on", key };
}

/** Unsubscribes this device and removes its subscription from the Worker. */
export async function turnOff(key: string): Promise<PushState> {
  await (await currentSubscription())?.unsubscribe();
  await api("DELETE", "/push/subscription");
  return { kind: "off", key };
}

/** Whether this device gets push, so an open but hidden page notifies by itself instead. */
export async function deviceSubscribed(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  return (await currentSubscription()) !== null;
}
