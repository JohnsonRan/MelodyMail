import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";

// Foreground reports for the Hub suites (docs/M5c-foreground.md). The Hub stores a page's "fg" or
// "bg" and its time as the socket's attachment; these read and age the attachments inside the
// Durable Object.

type Report = { foreground: boolean; at: number } | null;

/** Each open socket's attachment, as the Hub reads it after waking. */
export function attachments(): Promise<Report[]> {
  return runInDurableObject(env.HUB.getByName("hub"), (_hub, state) =>
    state.getWebSockets().map((ws) => ws.deserializeAttachment() as Report),
  );
}

/** Moves every stored report `ms` into the past, as if the page had sent it then. */
export function ageReports(ms: number): Promise<void> {
  return runInDurableObject(env.HUB.getByName("hub"), (_hub, state) => {
    for (const ws of state.getWebSockets()) {
      const report = ws.deserializeAttachment() as Report;
      if (report) ws.serializeAttachment({ ...report, at: report.at - ms });
    }
  });
}

/** Sends a page's report and waits until the Hub has stored it. */
export async function report(ws: WebSocket, state: "fg" | "bg"): Promise<void> {
  const sent = Date.now();
  ws.send(state);
  await vi.waitFor(
    async () => {
      const stored = (await attachments()).some(
        (a) => a?.foreground === (state === "fg") && a.at >= sent,
      );
      if (!stored) throw new Error(`no ${state} report yet`);
    },
    { timeout: 2000, interval: 10 },
  );
}

/** Sets "Quiet while MelodyMail is open" as Settings > Notifications does. */
export async function setQuiet(on: boolean): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (id, quiet_foreground, updated_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET quiet_foreground = excluded.quiet_foreground`,
  )
    .bind(on ? 1 : 0, Date.now())
    .run();
}
