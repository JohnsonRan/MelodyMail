import type { Hono } from "hono";
import { audit } from "../auth/store";
import { NOTE_MAX, parseEmail, parseId, parseText } from "../domains/validate";
import type { AppEnv } from "../env";
import { fail, readJson } from "../http";

/** Links an address to targets; ids that no longer exist are skipped. */
export function forwardsInsert(db: D1Database, domain: string, localPart: string, ids: number[]) {
  return db
    .prepare(
      "INSERT INTO address_forwards (address_id, target_id) SELECT a.id, t.id FROM addresses a JOIN forward_targets t ON t.id IN (SELECT value FROM json_each(?)) WHERE a.domain = ? AND a.local_part = ?",
    )
    .bind(JSON.stringify(ids), domain, localPart);
}

/**
 * Owner ruling (2026-11-16): a forward-only address always has a target. Run in the same batch
 * after any write that can remove its last link; an address left without one goes back to
 * store and forward.
 */
export function keepForwardOnlyTargeted(db: D1Database, domain: string, localPart: string) {
  return db
    .prepare(
      "UPDATE addresses SET forward_only = 0 WHERE domain = ? AND local_part = ? AND forward_only = 1 AND NOT EXISTS (SELECT 1 FROM address_forwards f WHERE f.address_id = addresses.id)",
    )
    .bind(domain, localPart);
}

/** True when any of the ids names no stored target. */
export async function unknownTargets(db: D1Database, ids: number[]): Promise<boolean> {
  if (ids.length === 0) return false;
  const n = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM forward_targets WHERE id IN (SELECT value FROM json_each(?))",
    )
    .bind(JSON.stringify(ids))
    .first<number>("n");
  return n !== ids.length;
}

/**
 * Settings > Forwarding. Each target must be a verified destination address in the Cloudflare
 * account (Email Routing > Destination addresses); nothing here calls Cloudflare, so an
 * unverified target fails only when M3 forwards to it.
 */
export function registerTargetRoutes(targets: Hono<AppEnv>): void {
  targets.get("/", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT id, email, note, created_at AS createdAt, (SELECT COUNT(*) FROM address_forwards f WHERE f.target_id = t.id) AS addressCount, (SELECT COUNT(*) FROM rule_forwards r WHERE r.target_id = t.id) AS ruleCount FROM forward_targets t ORDER BY email",
    ).all();
    return c.json({ targets: results });
  });

  targets.post("/", async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, "bad_request");
    const email = parseEmail(body.email);
    if (!email.ok) return fail(c, 400, email.error);
    const note = parseText(body.note, NOTE_MAX, "invalid_note");
    if (!note.ok) return fail(c, 400, note.error);
    const now = Date.now();
    const db = c.env.DB;
    const row = await db
      .prepare(
        "INSERT INTO forward_targets (email, note, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING id, email, note, created_at AS createdAt",
      )
      .bind(email.value, note.value ?? "", now)
      .first();
    if (!row) return fail(c, 409, "target_exists");
    await audit(c, "forward_target_added", now, email.value).run();
    return c.json({ target: { ...row, addressCount: 0, ruleCount: 0 } }, 201);
  });

  // Refused while addresses or rules use the target, unless ?detach=1 (the UI confirms first).
  // One statement decides; the links go with the target (cascade). In the same batch, a
  // forward-only address losing its last target goes back to store and forward, and a rule left
  // without any action is disabled (docs/M6-rules-api.md, "Forwarding").
  targets.delete("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return fail(c, 404, "not_found");
    const detach = c.req.query("detach") === "1" ? 1 : 0;
    const db = c.env.DB;
    const now = Date.now();
    const [, , deleted] = await db.batch([
      db
        .prepare(
          "UPDATE addresses SET forward_only = 0 WHERE ? = 1 AND forward_only = 1 AND id IN (SELECT address_id FROM address_forwards WHERE target_id = ?) AND NOT EXISTS (SELECT 1 FROM address_forwards f WHERE f.address_id = addresses.id AND f.target_id != ?)",
        )
        .bind(detach, id, id),
      db
        .prepare(
          "UPDATE rules SET enabled = 0, updated_at = ? WHERE ? = 1 AND enabled = 1 AND mark_read = 0 AND star = 0 AND archive = 0 AND trash = 0 AND stop = 0 AND id IN (SELECT rule_id FROM rule_forwards WHERE target_id = ?) AND NOT EXISTS (SELECT 1 FROM rule_forwards f WHERE f.rule_id = rules.id AND f.target_id != ?)",
        )
        .bind(now, detach, id, id),
      db
        .prepare(
          "DELETE FROM forward_targets WHERE id = ?1 AND (?2 = 1 OR NOT EXISTS (SELECT 1 FROM address_forwards WHERE target_id = ?1) AND NOT EXISTS (SELECT 1 FROM rule_forwards WHERE target_id = ?1)) RETURNING email",
        )
        .bind(id, detach),
    ]);
    const removed = deleted?.results[0] as { email: string } | undefined;
    if (removed) {
      await audit(c, "forward_target_removed", now, removed.email).run();
      return c.json({ ok: true });
    }
    const exists = await db
      .prepare("SELECT 1 AS one FROM forward_targets WHERE id = ?")
      .bind(id)
      .first();
    return exists ? fail(c, 409, "target_in_use") : fail(c, 404, "not_found");
  });
}
