import { useSyncExternalStore } from "react";

// The service worker's update state. The registration chunk (./register.ts) loads after the
// first render and fills it; the banner reads it.

let apply: (() => Promise<void>) | null = null;
const listeners = new Set<() => void>();

/** A new service worker is waiting; `update` activates it and reloads the page. */
export function setUpdateWaiting(update: () => Promise<void>): void {
  apply = update;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The function that applies a waiting update, or null when none is waiting. */
export function useWaitingUpdate(): (() => Promise<void>) | null {
  return useSyncExternalStore(subscribe, () => apply);
}
