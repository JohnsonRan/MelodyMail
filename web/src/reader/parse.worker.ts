/// <reference lib="webworker" />
import PostalMime from "postal-mime";
import { fromPostal } from "./fromPostal";

// Parses one raw message off the main thread, so the page stays responsive on a 25 MiB message.
// postal-mime is imported only here, so it loads with the reader and never with the first paint.

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const email = await PostalMime.parse(event.data, { attachmentEncoding: "arraybuffer" });
    const mail = fromPostal(email);
    self.postMessage({ ok: true, mail }, { transfer: mail.parts.map((p) => p.content) });
  } catch {
    self.postMessage({ ok: false });
  }
};
