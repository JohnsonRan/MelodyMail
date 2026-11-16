import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";

// Foreground reports for the Hub suites (docs/M5c-foreground.md). The Hub stores a page's "fg" or
// "bg" as its socket's attachment; these read the attachments inside the Durable Object.

/** Each open socket's attachment, as the Hub reads it after waking. */
export function attachments(): Promise<unknown[]> {
  return runInDurableObject(env.HUB.getByName("hub"), (_hub, state) =>
    state.getWebSockets().map((ws) => ws.deserializeAttachment()),
  );
}

/** Sends a page's report and waits until the Hub has stored it. */
export async function report(ws: WebSocket, state: "fg" | "bg"): Promise<void> {
  ws.send(state);
  await vi.waitFor(
    async () => {
      const stored = (await attachments()).some(
        (a) => (a as { foreground?: boolean } | null)?.foreground === (state === "fg"),
      );
      if (!stored) throw new Error(`no ${state} report yet`);
    },
    { timeout: 2000, interval: 10 },
  );
}
