import type { Hono } from "hono";
import { Webhook } from "standardwebhooks";
import type { AppEnv } from "../env";
import { fail, log } from "../http";
import { notifyHub } from "../mail/hub";
import { signedWebhookRoute } from "../routing";

// POST /api/webhooks/resend (docs/M5-sending.md, "Webhook"). Public: the Svix signature over the
// raw body with RESEND_WEBHOOK_SECRET is the authentication; standardwebhooks (the library the
// resend SDK's own verify uses) checks it and refuses a timestamp more than 5 minutes off.

const STATUS_BY_EVENT: Record<string, string> = {
  "email.sent": "sent",
  "email.delivery_delayed": "delayed",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
};

/** Order of the delivery statuses; a status only moves to a higher rank. The last ones are final. */
const RANK = `CASE status WHEN 'sending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delayed' THEN 2
  WHEN 'delivered' THEN 3 ELSE 4 END`;
const RANK_OF: Record<string, number> = { sent: 1, delayed: 2, delivered: 3 };

type Event = { type?: unknown; data?: { email_id?: unknown } };

export function registerWebhookRoute(app: Hono<AppEnv>): void {
  signedWebhookRoute(app, "/webhooks/resend", async (c) => {
    const secret = c.env.RESEND_WEBHOOK_SECRET;
    if (!secret) return fail(c, 404, "not_found");
    const svixId = c.req.header("svix-id") ?? "";
    const raw = await c.req.text();
    let event: Event;
    try {
      event = new Webhook(secret).verify(raw, {
        "webhook-id": svixId,
        "webhook-timestamp": c.req.header("svix-timestamp") ?? "",
        "webhook-signature": c.req.header("svix-signature") ?? "",
      }) as Event;
    } catch {
      return fail(c, 401, "unauthorized");
    }
    if (svixId.length > 128) return fail(c, 400, "bad_request");

    const status = typeof event.type === "string" ? STATUS_BY_EVENT[event.type] : undefined;
    const emailId = event.data?.email_id;
    const db = c.env.DB;
    const now = Date.now();
    // The status change and the replay guard commit together, so a failed update is retried by
    // Resend instead of being remembered as handled.
    const update =
      status && typeof emailId === "string"
        ? [
            db
              .prepare(
                `UPDATE messages SET status = ? WHERE resend_id = ? AND direction = 'out'
                   AND ${RANK} < ?
                   AND NOT EXISTS (SELECT 1 FROM webhook_events WHERE svix_id = ?)
                 RETURNING id`,
              )
              .bind(status, emailId, RANK_OF[status] ?? 4, svixId),
          ]
        : [];
    const results = await db.batch<{ id: string }>([
      ...update,
      db
        .prepare(
          "INSERT INTO webhook_events (svix_id, received_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
        )
        .bind(svixId, now),
    ]);
    const changed = update.length > 0 ? results[0]?.results[0]?.id : undefined;
    log("info", "webhook_event", {
      type: typeof event.type === "string" ? event.type.slice(0, 64) : null,
      messageId: changed ?? null,
    });
    if (changed) await notifyHub(c.env, { type: "changed", id: changed });
    return c.json({ ok: true });
  });
}
