import type { Env } from "../env";
import { errorText, log } from "../http";
import {
  DB_NOW,
  type DeletableFolder,
  type DeleteBounds,
  deleteCandidates,
  deleteCondition,
  deleteSource,
  PURGE_MAX,
} from "./folders";

// Permanent delete from Trash and Spam (M4, docs/M8-mailbox-ux.md, section 1) and the automatic
// clean-up after 30 days (docs/M7-ops.md, owner ruling 3; Spam from M8). Everything goes through
// deletePermanently: the FTS rows, the rows, the audit row and the hasMore probe in one batch,
// then the raw objects, so a failed R2 delete leaves an orphan object rather than a row whose raw
// message is gone.

/** A message in Trash or Spam this long is deleted by the cron. */
export const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Messages deleted per cron step: one D1 batch, one R2 delete of up to 1,000 keys. */
export const TRASH_EXPIRE_MAX = 100;

export type DeleteOptions = DeleteBounds & {
  /** An audit row written in the delete batch, only when a row was deleted. */
  audit?: {
    event: string;
    now: number;
    client?: { ip: string; userAgent: string };
    /** The audit detail; the number of deleted rows when left out. */
    detail?: string;
  };
  /** Also answer whether rows matching the bounds remain after this batch. */
  probe?: boolean;
};

/**
 * Deletes the given messages that are in `folder` now and match the bounds; a message moved to
 * another folder since the caller chose it is kept. Returns the deleted ids and, with `probe`,
 * whether rows matching the bounds remain.
 */
export async function deletePermanently(
  env: Env,
  folder: DeletableFolder,
  ids: string[],
  options: DeleteOptions = {},
): Promise<{ deleted: string[]; hasMore: boolean }> {
  const db = env.DB;
  const condition = deleteCondition(folder, options, true);
  const match = `id IN (SELECT value FROM json_each(?)) AND ${condition.sql}`;
  const params = [JSON.stringify(ids), ...condition.params];
  const statements = [
    db
      .prepare(
        `DELETE FROM messages_fts WHERE message_id IN (SELECT id FROM messages WHERE ${match})`,
      )
      .bind(...params),
    db.prepare(`DELETE FROM messages WHERE ${match} RETURNING id, r2_key AS key`).bind(...params),
  ];
  const { audit, probe } = options;
  if (audit) {
    // changes() is the row count of the DELETE just before it in the batch.
    const client = audit.client ?? { ip: "", userAgent: "" };
    statements.push(
      db
        .prepare(
          `INSERT INTO audit_log (event, created_at, ip, user_agent, detail)
           SELECT ?, ?, ?, ?, COALESCE(?, CAST(changes() AS TEXT)) WHERE changes() > 0`,
        )
        .bind(audit.event, audit.now, client.ip, client.userAgent, audit.detail ?? null),
    );
  }
  if (probe) {
    const rest = deleteCondition(folder, options);
    statements.push(
      db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM ${deleteSource(folder, options)} WHERE ${rest.sql}) AS more`,
        )
        .bind(...rest.params),
    );
  }
  const results = await db.batch(statements);
  const rows = (results[1]?.results ?? []) as { id: string; key: string }[];
  const more = probe ? (results.at(-1)?.results[0] as { more: number } | undefined) : undefined;
  if (rows.length > 0) {
    try {
      await env.MAIL.delete(rows.map((r) => r.key));
    } catch (err) {
      log("warn", "mail_raw_delete_failed", { count: rows.length, error: errorText(err) });
    }
  }
  return { deleted: rows.map((r) => r.id), hasMore: more?.more === 1 };
}

const EXPIRED = { trash: "trash_expired", spam: "spam_expired" } as const;

/**
 * One cron step: deletes up to TRASH_EXPIRE_MAX messages that have been in the folder for 30 days,
 * oldest first. A row in Trash without a time (moved there by code from before migration 0015)
 * starts its 30 days now; every way into Spam sets spam_at.
 */
async function expireFolder(env: Env, folder: DeletableFolder, now: number): Promise<number> {
  const db = env.DB;
  const bounds = { before: now - TRASH_KEEP_MS + 1 };
  const select = deleteCandidates(db, folder, bounds, TRASH_EXPIRE_MAX);
  const statements =
    folder === "trash"
      ? [
          db.prepare(
            `UPDATE messages SET trashed_at = ${DB_NOW} WHERE trashed = 1 AND trashed_at IS NULL`,
          ),
          select,
        ]
      : [select];
  const results = await db.batch<{ id: string }>(statements);
  const ids = (results.at(-1)?.results ?? []).map((r) => r.id);
  if (ids.length === 0) return 0;
  const event = EXPIRED[folder];
  const { deleted } = await deletePermanently(env, folder, ids, {
    ...bounds,
    audit: { event, now },
  });
  if (deleted.length > 0) log("info", event, { count: deleted.length });
  return deleted.length;
}

export const expireTrash = (env: Env, now: number) => expireFolder(env, "trash", now);
export const expireSpam = (env: Env, now: number) => expireFolder(env, "spam", now);

/**
 * One purge call (POST /api/messages/purge): deletes up to PURGE_MAX of the folder's oldest rows
 * within the bounds and says whether more remain. With nothing left it writes nothing.
 */
export async function purgeFolder(
  env: Env,
  folder: DeletableFolder,
  bounds: DeleteBounds,
  audit: NonNullable<DeleteOptions["audit"]>,
): Promise<{ deleted: string[]; hasMore: boolean }> {
  const { results } = await deleteCandidates(env.DB, folder, bounds, PURGE_MAX).all<{
    id: string;
  }>();
  if (results.length === 0) return { deleted: [], hasMore: false };
  return deletePermanently(
    env,
    folder,
    results.map((r) => r.id),
    { ...bounds, audit, probe: true },
  );
}
