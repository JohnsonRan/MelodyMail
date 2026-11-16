import { registerSW } from "virtual:pwa-register";
import { setUpdateWaiting } from "./status";

// Loaded after the first render (App.tsx), so registration is not part of first paint. With
// registerType "prompt" a new worker waits until the owner chooses Reload: a page that keeps
// running on the old deployment could lazy-load a chunk the new one removed.
const update = registerSW({
  onNeedRefresh: () => setUpdateWaiting(() => update(true)),
});
