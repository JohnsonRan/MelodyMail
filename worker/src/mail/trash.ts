import { auditRow } from "../auth/store";
import type { Env } from "../env";
import { errorText, log } from "../http";

// Permanent delete from Trash (M4) and the automatic clean-up after 30 days (docs/M7-ops.md,
// owner ruling 3). Both go through deleteFromTrash: the FTS rows and the rows in one batch, then
// the raw objects, so a failed R2 delete leaves an orphan object rather than a row whose raw
// message is gone.

/** A message in Trash this long is deleted by the cron. */
export const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Messages deleted per cron run: one D1 batch, one R2 delete of up to 1,000 keys. */
export const TRASH_EXPIRE_MAX = 100;

/**
 * Deletes the given messages that are in Trash, and with `trashedBefore` only those in Trash
 * since then or earlier, so a message restored meanwhile stays. Returns the deleted ids.
 */
export async function deleteFromTrash(
  env: Env,
  ids: string[],
  trashedBefore: number | null = null,
): Promise<string[]> {
  const db = env.DB;
  const match = `id IN (SELECT value FROM json_each(?1)) AND trashed = 1
    AND (?2 IS NULL OR trashed_at <= ?2)`;
  const list = JSON.stringify(ids);
  const [, deleted] = await db.batch<{ id: string; key: string }>([
    db
      .prepare(
        `DELETE FROM messages_fts WHERE message_id IN (SELECT id FROM messages WHERE ${match})`,
      )
      .bind(list, trashedBefore),
    db
      .prepare(`DELETE FROM messages WHERE ${match} RETURNING id, r2_key AS key`)
      .bind(list, trashedBefore),
  ]);
  const rows = deleted?.results ?? [];
  if (rows.length > 0) {
    try {
      await env.MAIL.delete(rows.map((r) => r.key));
    } catch (err) {
      log("warn", "mail_raw_delete_failed", { count: rows.length, error: errorText(err) });
    }
  }
  return rows.map((r) => r.id);
}

/**
 * The cron step: deletes up to TRASH_EXPIRE_MAX messages that have been in Trash for 30 days,
 * oldest first. A row in Trash without a time (moved there by code from before migration 0015)
 * starts its 30 days now.
 */
export async function expireTrash(env: Env, now: number): Promise<number> {
  const db = env.DB;
  const cutoff = now - TRASH_KEEP_MS;
  const [, due] = await db.batch<{ id: string }>([
    db
      .prepare("UPDATE messages SET trashed_at = ? WHERE trashed = 1 AND trashed_at IS NULL")
      .bind(now),
    db
      .prepare(
        "SELECT id FROM messages WHERE trashed = 1 AND trashed_at <= ? ORDER BY trashed_at LIMIT ?",
      )
      .bind(cutoff, TRASH_EXPIRE_MAX),
  ]);
  const ids = (due?.results ?? []).map((r) => r.id);
  if (ids.length === 0) return 0;
  const deleted = await deleteFromTrash(env, ids, cutoff);
  if (deleted.length > 0) {
    await auditRow(db, "trash_expired", now, String(deleted.length)).run();
    log("info", "trash_expired", { count: deleted.length });
  }
  return deleted.length;
}
