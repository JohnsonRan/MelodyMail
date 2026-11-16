import type { Env } from "../env";
import { errorText, log } from "../http";
import { EXPORT_PREFIX } from "./sql";

// Retention (docs/M7-ops.md, "Retention and pruning"). Runs once after each export completes.
// Only exports with a backup_exports row are ever removed, so after a restore into a fresh
// database the exports already in R2 stay until the owner removes them.

export const KEEP_NEWEST = 14;
export const KEEP_MONTHS = 6;
/** An export that never completed is removed this long after it started. */
export const INCOMPLETE_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
/** Exports removed per run: each costs one R2 list and one delete. */
export const PRUNE_MAX = 3;

export type ExportRow = { id: string; status: string; startedAt: number };

const monthIndex = (time: number) => {
  const d = new Date(time);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

/**
 * The exports to remove, oldest first: complete ones that are neither among the 14 newest nor
 * the first complete export of one of the last 6 calendar months, and incomplete ones started 2
 * days ago or earlier. A running export younger than that is kept.
 */
export function exportsToDrop(rows: ExportRow[], now: number): string[] {
  const complete = rows
    .filter((r) => r.status === "complete")
    .sort((a, b) => b.startedAt - a.startedAt);
  const keep = new Set(complete.slice(0, KEEP_NEWEST).map((r) => r.id));
  const firstOfMonth = new Map<number, ExportRow>();
  for (const row of complete) firstOfMonth.set(monthIndex(row.startedAt), row);
  const current = monthIndex(now);
  for (const [month, row] of firstOfMonth) {
    if (current - month < KEEP_MONTHS) keep.add(row.id);
  }
  return rows
    .filter((r) =>
      r.status === "complete" ? !keep.has(r.id) : r.startedAt <= now - INCOMPLETE_KEEP_MS,
    )
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((r) => r.id);
}

/**
 * Removes up to PRUNE_MAX exports, then marks `newestId` as pruned; what is left waits for the
 * next completed export. A failed delete (a bucket lock, for one) is logged and skipped.
 */
export async function pruneExports(env: Env, now: number, newestId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, status, started_at AS startedAt FROM backup_exports",
  ).all<ExportRow>();
  let removed = 0;
  for (const id of exportsToDrop(results, now).slice(0, PRUNE_MAX)) {
    try {
      const listed = await env.MAIL.list({ prefix: `${EXPORT_PREFIX}${id}/` });
      if (listed.objects.length > 0) await env.MAIL.delete(listed.objects.map((o) => o.key));
      // The row goes only when nothing is left; the rest of a larger export goes in a later pass.
      if (!listed.truncated) {
        await env.DB.prepare("DELETE FROM backup_exports WHERE id = ?").bind(id).run();
        removed++;
      }
    } catch (err) {
      log("warn", "backup_prune_failed", { exportId: id, error: errorText(err) });
    }
  }
  await env.DB.prepare("UPDATE backup_exports SET pruned_at = ? WHERE id = ?")
    .bind(now, newestId)
    .run();
  if (removed > 0) log("info", "backup_pruned", { count: removed });
}
