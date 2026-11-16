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
  // Not "failed": that is a local send failure, which the owner may retry. Resend's own report
  // is final; claimRetry takes only "failed" rows.
  "email.failed": "delivery_failed",
  "email.suppressed": "suppressed",
};

/** Order of the delivery statuses; a status only moves to a higher rank. The last ones are final. */
const RANK = `CASE status WHEN 'sending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delayed' THEN 2
  WHEN 'delivered' THEN 3 ELSE 4 END`;
const RANK_OF: Record<string, number> = { sent: 1, delayed: 2, delivered: 3 };

type Event = { type?: unknown; data?: { email_id?: unknown } };

/**
 * standardwebhooks computes the HMAC over the whole body in JS before it can refuse it: about
 * 1 ms for 256 KB, 12 ms for 4 MB (Bun, dev workstation), and Workers Free allows 10 ms of CPU.
 * Resend's email events carry ids, addresses and a subject, a few kB at most.
 */
export const WEBHOOK_BODY_MAX = 256 * 1024;

export function registerWebhookRoute(app: Hono<AppEnv>): void {
  signedWebhookRoute(app, "/webhooks/resend", async (c) => {
    const secret = c.env.RESEND_WEBHOOK_SECRET;
    if (!secret) return fail(c, 404, "not_found");
    const svixId = c.req.header("svix-id") ?? "";
    const body = await c.req.arrayBuffer();
    if (body.byteLength > WEBHOOK_BODY_MAX) return fail(c, 413, "payload_too_large");
    const raw = new TextDecoder().decode(body);
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
    const emailId = status && typeof event.data?.email_id === "string" ? event.data.email_id : null;
    const db = c.env.DB;
    // The status change and the replay guard commit together, so a failed update is retried by
    // Resend instead of being remembered as handled. An event for an id no message carries yet
    // is not remembered either: it may have overtaken the send that stores resend_id.
    const [updated, known] = await db.batch<{ id?: string; known?: number }>([
      db
        .prepare(
          `UPDATE messages SET status = ? WHERE resend_id = ? AND direction = 'out'
             AND ${RANK} < ?
             AND NOT EXISTS (SELECT 1 FROM webhook_events WHERE svix_id = ?)
           RETURNING id`,
        )
        .bind(status ?? null, emailId, RANK_OF[status ?? ""] ?? 4, svixId),
      db
        .prepare("SELECT EXISTS (SELECT 1 FROM messages WHERE resend_id = ?) AS known")
        .bind(emailId),
      db
        .prepare(
          `INSERT INTO webhook_events (svix_id, received_at)
           SELECT ?, ? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM messages WHERE resend_id = ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(svixId, Date.now(), emailId, emailId),
    ]);
    const changed = updated?.results[0]?.id;
    const type = typeof event.type === "string" ? event.type.slice(0, 64) : null;
    if (emailId && !known?.results[0]?.known) {
      // A non-2xx answer makes Resend deliver the event again later, with the same svix-id.
      log("info", "webhook_event_unmatched", { type });
      return fail(c, 409, "unknown_email");
    }
    log("info", "webhook_event", { type, messageId: changed ?? null });
    if (changed) await notifyHub(c.env, { type: "changed", id: changed });
    return c.json({ ok: true });
  });
}
