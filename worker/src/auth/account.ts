import type { Hono } from "hono";
import type { AppEnv } from "../env";
import { fail, readJson } from "../http";
import { saveChallenge, takeChallenge } from "./challenge";
import { audit, passkeyInsert, passkeyLabel } from "./routes";
import { clearSessionCookie, SESSION_IDLE_MS } from "./session";
import { registrationOptions, type StoredPasskey, verifyRegistration } from "./webauthn";

/** Routes for the signed-in owner. None is public; the session middleware guards them all. */
export function registerAccountRoutes(auth: Hono<AppEnv>): void {
  auth.post("/logout", async (c) => {
    const now = Date.now();
    const db = c.env.DB;
    await db.batch([
      db.prepare("DELETE FROM sessions WHERE id = ?").bind(c.get("sessionId")),
      audit(c, "logout", now),
    ]);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  auth.get("/passkeys", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT id, label, created_at AS createdAt, last_used_at AS lastUsedAt FROM passkeys ORDER BY created_at",
    ).all();
    return c.json({ passkeys: results });
  });

  auth.post("/passkeys/options", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT id, public_key AS publicKey, counter, transports FROM passkeys",
    ).all<StoredPasskey>();
    const options = await registrationOptions(c, results);
    await saveChallenge(c, "add-passkey", options.challenge, Date.now());
    return c.json({ options });
  });

  auth.post("/passkeys/verify", async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, "bad_request");
    const now = Date.now();
    const challenge = await takeChallenge(c, "add-passkey", now);
    if (!challenge) return fail(c, 401, "verification_failed");
    const credential = await verifyRegistration(c, body.credential, challenge);
    if (!credential) return fail(c, 401, "verification_failed");
    const db = c.env.DB;
    try {
      await db.batch([
        passkeyInsert(c, credential, passkeyLabel(body.label), now),
        audit(c, "passkey_added", now),
      ]);
    } catch {
      // The authenticator already holds a registered Passkey (same credential id).
      return fail(c, 409, "passkey_exists");
    }
    return c.json({ ok: true });
  });

  auth.delete("/passkeys/:id", async (c) => {
    const id = c.req.param("id");
    const db = c.env.DB;
    const now = Date.now();
    // One statement, so two concurrent deletes cannot remove the last two Passkeys together.
    const deleted = await db
      .prepare("DELETE FROM passkeys WHERE id = ? AND (SELECT COUNT(*) FROM passkeys) > 1")
      .bind(id)
      .run();
    if (deleted.meta.changes === 1) {
      await audit(c, "passkey_removed", now).run();
      return c.json({ ok: true });
    }
    const exists = await db.prepare("SELECT 1 AS one FROM passkeys WHERE id = ?").bind(id).first();
    return exists ? fail(c, 409, "last_passkey") : fail(c, 404, "not_found");
  });

  auth.get("/sessions", async (c) => {
    const now = Date.now();
    const { results } = await c.env.DB.prepare(
      "SELECT id, created_at AS createdAt, last_seen_at AS lastSeenAt, user_agent AS userAgent FROM sessions WHERE expires_at > ? AND last_seen_at > ? ORDER BY last_seen_at DESC",
    )
      .bind(now, now - SESSION_IDLE_MS)
      .all<{ id: string; createdAt: number; lastSeenAt: number; userAgent: string }>();
    const current = c.get("sessionId");
    return c.json({
      sessions: results.map(({ id, ...rest }) => ({ ...rest, current: id === current })),
    });
  });

  auth.delete("/sessions/others", async (c) => {
    const now = Date.now();
    const db = c.env.DB;
    const [deleted] = await db.batch([
      db.prepare("DELETE FROM sessions WHERE id != ?").bind(c.get("sessionId")),
      audit(c, "sessions_revoked", now),
    ]);
    return c.json({ revoked: deleted?.meta.changes ?? 0 });
  });
}
