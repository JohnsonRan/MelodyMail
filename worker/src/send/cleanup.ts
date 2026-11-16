import type { Env } from "../env";
import { log } from "../http";

// Cron jobs for sending (docs/M5-sending.md, "Data"): uploads that belong to neither a live draft
// nor a stored message after 24 hours, and replay-guard rows older than 7 days.

export const UPLOAD_STALE_MS = 24 * 60 * 60 * 1000;
export const WEBHOOK_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const UPLOAD_SWEEP_MAX = 100;

export async function removeStaleUploads(env: Env, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, r2_key AS key FROM uploads WHERE created_at <= ? AND (
       (message_id IS NULL AND (draft_id IS NULL OR draft_id NOT IN (SELECT id FROM drafts)))
       OR (message_id IS NOT NULL AND message_id NOT IN (SELECT id FROM messages)))
     ORDER BY created_at LIMIT ?`,
  )
    .bind(now - UPLOAD_STALE_MS, UPLOAD_SWEEP_MAX)
    .all<{ id: string; key: string }>();
  if (results.length === 0) return 0;
  // Objects first: if this fails, the rows stay and the next run tries again.
  await env.MAIL.delete(results.map((r) => r.key));
  await env.DB.prepare("DELETE FROM uploads WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(results.map((r) => r.id)))
    .run();
  log("info", "uploads_removed", { count: results.length });
  return results.length;
}

export async function removeOldWebhookEvents(env: Env, now: number): Promise<number> {
  const { meta } = await env.DB.prepare("DELETE FROM webhook_events WHERE received_at <= ?")
    .bind(now - WEBHOOK_KEEP_MS)
    .run();
  return meta.changes;
}
