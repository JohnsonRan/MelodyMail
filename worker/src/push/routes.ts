import type { Hono, MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { fail, log, readJson } from "../http";
import { MAX_SUBSCRIPTIONS, sendTo, vapidConfig } from "./send";
import { parseSubscription } from "./subscription";

// Web Push routes (docs/M4b-pwa.md, "Routes"). None is public. A subscription belongs to the
// session that made it, so it ends with that session (foreign key ON DELETE CASCADE).

/** Abuse guard on the test send, per session; approximate by design (see wrangler.jsonc). */
const testLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { success } = await c.env.PUSH_LIMITER.limit({ key: c.get("sessionId") });
  if (!success) return fail(c, 429, "rate_limited");
  return next();
};

export function registerPushRoutes(push: Hono<AppEnv>): void {
  push.get("/key", (c) => {
    const vapid = vapidConfig(c.env);
    return vapid ? c.json({ key: vapid.publicKey }) : fail(c, 404, "push_not_configured");
  });

  push.put("/subscription", async (c) => {
    const body = await readJson(c);
    const sub = body && parseSubscription(body);
    if (!sub) {
      // The push service's host only (never the endpoint path, which identifies the device), so a
      // browser whose push service is missing from the allowlist can be recognised.
      log("warn", "push_subscription_rejected", { host: endpointHost(body?.endpoint) });
      return fail(c, 400, "invalid_subscription");
    }
    const sessionId = c.get("sessionId");
    const db = c.env.DB;
    await db.batch([
      // One subscription per device: a new endpoint replaces this session's old one.
      db
        .prepare("DELETE FROM push_subscriptions WHERE session_id = ? AND endpoint != ?")
        .bind(sessionId, sub.endpoint),
      // An endpoint already stored for another session moves to this one.
      db
        .prepare(
          `INSERT INTO push_subscriptions (id, session_id, endpoint, p256dh, auth, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (endpoint) DO UPDATE SET session_id = excluded.session_id,
             p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
        )
        .bind(crypto.randomUUID(), sessionId, sub.endpoint, sub.p256dh, sub.auth, Date.now()),
      db
        .prepare(
          `DELETE FROM push_subscriptions WHERE id NOT IN
             (SELECT id FROM push_subscriptions ORDER BY created_at DESC, id DESC LIMIT ?)`,
        )
        .bind(MAX_SUBSCRIPTIONS),
    ]);
    return c.json({ ok: true });
  });

  push.delete("/subscription", async (c) => {
    await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE session_id = ?")
      .bind(c.get("sessionId"))
      .run();
    return c.json({ ok: true });
  });

  push.post("/test", testLimit, async (c) => {
    const vapid = vapidConfig(c.env);
    if (!vapid) return fail(c, 404, "push_not_configured");
    const row = await c.env.DB.prepare(
      "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE session_id = ?",
    )
      .bind(c.get("sessionId"))
      .first<{ id: string; endpoint: string; p256dh: string; auth: string }>();
    if (!row) return fail(c, 404, "not_subscribed");
    const outcome = await sendTo(c.env, vapid, row, { type: "test" });
    if (outcome === "gone") return fail(c, 404, "not_subscribed");
    if (outcome === "failed") return fail(c, 502, "push_failed");
    return c.json({ ok: true });
  });
}

function endpointHost(endpoint: unknown): string | null {
  if (typeof endpoint !== "string") return null;
  try {
    return new URL(endpoint).hostname.slice(0, 253);
  } catch {
    return null;
  }
}
