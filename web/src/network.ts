import { useSyncExternalStore } from "react";

// Whether the app can reach the Worker (docs/M4b-pwa.md, "Offline state"). An API call that gets
// no answer, or the browser's `offline` event, marks the app offline; any answer or the `online`
// event ends it. `epoch` counts recoveries, so the shell can reload its data once it is back.
// While offline, the public health route is asked every few seconds: the `online` event does
// not fire when the network stays up but the Worker is out of reach.

// Offline, the request fails on the device; with the network up it is one small GET.
const PROBE_MS = 2_000;

type State = { offline: boolean; epoch: number };

let state: State = { offline: false, epoch: 0 };
let probe: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

export function reportNetwork(reachable: boolean): void {
  if (state.offline !== reachable) return;
  state = { offline: !reachable, epoch: reachable ? state.epoch + 1 : state.epoch };
  clearInterval(probe);
  if (!reachable) {
    probe = setInterval(() => {
      fetch("/api/health", { cache: "no-store" }).then(
        () => reportNetwork(true),
        () => {},
      );
    }, PROBE_MS);
  }
  for (const listener of listeners) listener();
}

let watching = false;

/** Starts following the browser's online state once the first component asks for it. */
function watchBrowser() {
  if (watching) return;
  watching = true;
  window.addEventListener("online", () => reportNetwork(true));
  window.addEventListener("offline", () => reportNetwork(false));
  if (!navigator.onLine) reportNetwork(false);
}

function subscribe(listener: () => void) {
  watchBrowser();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNetwork(): State {
  return useSyncExternalStore(subscribe, () => state);
}
