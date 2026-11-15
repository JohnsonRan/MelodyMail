import type { Hono } from "hono";
import type { AppEnv } from "../env";
import { fail, readJson } from "../http";
import { checkAssertion, counterUpdate } from "./assertion";
import { saveChallenge, takeChallenge } from "./challenge";
import { clearSessionCookie, requireFreshAuth, SESSION_IDLE_MS } from "./session";
import { audit, hashRecoveryKey, newRecoveryKey, passkeyInsert, passkeyLabel } from "./store";
import {
  authenticationOptions,
  registrationOptions,
  type StoredPasskey,
  verifyRegistration,
} from "./webauthn";

/**
 * Routes for the signed-in owner. None is public; the session middleware guards them all.
 * Sensitive actions also pass requireFreshAuth (see its comment for what counts as fresh).
 * Adding a Passkey is guarded at /passkeys/options.
 */
export function registerAccountRoutes(auth: Hono<AppEnv>): void {
  auth.post("/reauth/options", async (c) => {
    const options = await authenticationOptions(c);
    await saveChallenge(c, "reauth", options.challenge, Date.now());
    return c.json({ options });
  });

  auth.post("/reauth/verify", async (c) => {
    const now = Date.now();
    const assertion = await checkAssertion(c, "reauth", now);
    if (assertion instanceof Response) return assertion;
    const db = c.env.DB;
    await db.batch([
      counterUpdate(c, assertion.passkeyId, assertion.counter, now),
      db.prepare("UPDATE sessions SET reauth_at = ? WHERE id = ?").bind(now, c.get("sessionId")),
      audit(c, "reauth", now),
    ]);
    return c.json({ ok: true });
  });

  auth.post("/recovery-key", requireFreshAuth, async (c) => {
    const now = Date.now();
    const recoveryKey = newRecoveryKey();
    const db = c.env.DB;
    await db.batch([
      db
        .prepare("UPDATE owner SET recovery_key_hash = ? WHERE id = 1")
        .bind(await hashRecoveryKey(recoveryKey)),
      audit(c, "recovery_key_regenerated", now),
    ]);
    return c.json({ recoveryKey });
  });

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

  auth.post("/passkeys/options", requireFreshAuth, async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT id, public_key AS publicKey, counter, transports FROM passkeys",
    ).all<StoredPasskey>();
    const options = await registrationOptions(c, results);
    await saveChallenge(c, "add-passkey", options.challenge, Date.now());
    return c.json({ options });
  });

  // No requireFreshAuth here: verify needs the single-use add-passkey challenge, which only a
  // fresh session can get from /passkeys/options and which expires in 5 minutes. Guarding it as
  // well broke the flow when the window lapsed at the authenticator prompt, because the
  // re-authentication challenge replaced the add-passkey one.
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
        // A recovery session's extra freshness ends with its first new Passkey.
        db
          .prepare("UPDATE sessions SET recovery_fresh_until = NULL WHERE id = ?")
          .bind(c.get("sessionId")),
        audit(c, "passkey_added", now),
      ]);
    } catch (err) {
      // The authenticator already holds a registered Passkey (same credential id). Any other
      // failure goes to onError; the batch rolled back as a whole.
      const exists = await db
        .prepare("SELECT 1 AS one FROM passkeys WHERE id = ?")
        .bind(credential.id)
        .first();
      if (exists) return fail(c, 409, "passkey_exists");
      throw err;
    }
    return c.json({ ok: true });
  });

  auth.delete("/passkeys/:id", requireFreshAuth, async (c) => {
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
      "SELECT id, created_at AS createdAt, last_seen_at AS lastSeenAt, user_agent AS userAgent, ip, country, region, city, organization, geo_source AS geoSource FROM sessions WHERE expires_at > ? AND last_seen_at > ? ORDER BY last_seen_at DESC",
    )
      .bind(now, now - SESSION_IDLE_MS)
      .all<{ id: string } & Record<string, unknown>>();
    const current = c.get("sessionId");
    return c.json({
      sessions: results.map(({ id, ...rest }) => ({ ...rest, current: id === current })),
    });
  });

  auth.delete("/sessions/others", requireFreshAuth, async (c) => {
    const now = Date.now();
    const db = c.env.DB;
    const [deleted] = await db.batch([
      db.prepare("DELETE FROM sessions WHERE id != ?").bind(c.get("sessionId")),
      audit(c, "sessions_revoked", now),
    ]);
    return c.json({ revoked: deleted?.meta.changes ?? 0 });
  });
}
