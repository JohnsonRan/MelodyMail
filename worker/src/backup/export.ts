import type { Env } from "../env";
import { errorText, log } from "../http";
import { alertOwner, STALE_AFTER_MS } from "./alert";
import { pruneExports } from "./prune";
import {
  buildManifest,
  exportIdOf,
  hex,
  LONG_VALUE_BYTES,
  manifestKey,
  PAGE_BYTES,
  PAGE_ROWS,
  type PartInfo,
  PIECE_CHARS,
  pageQuery,
  partKey,
  partText,
  SPLIT_BYTES,
  splitQuery,
} from "./sql";
import { EXPORTED, type ExportTable } from "./tables";

// The daily D1 export to R2 (docs/M7-ops.md, "Backups"), the last step of every cron run. Each
// run writes pages until its byte or call budget is spent and keeps its cursor in
// backup_exports, so an export spans as many runs as it needs. A run killed by the CPU limit
// repeats at most its last page: the part key comes from table and sequence, so the repeat
// overwrites the same object, and the cursor moves only after the put.

/**
 * SQL text one run writes at most: four full pages. It is the CPU control, since a Worker cannot
 * read its own CPU (REQUIREMENTS.md, "Numbers": export JS per page).
 */
export const RUN_BYTES = 1024 * 1024;
/**
 * D1 and R2 calls the step may make in one run. Workers Free allows 50 subrequests per
 * invocation; the other cron jobs use about 12 and the alert 3.
 */
export const RUN_CALLS = 30;
/** A page costs at most a page query, a split query, a put and the cursor update. */
const PAGE_CALLS = 4;
/** The migration name, the manifest put and the status update. */
const FINISH_CALLS = 3;
/** A new export starts each day at this UTC hour. */
export const START_HOUR_UTC = 3;
/** A running export older than this is marked failed, and a new one may start. */
export const RUNNING_MAX_MS = 48 * 60 * 60 * 1000;

type Latest = {
  id: string;
  status: "running" | "complete" | "failed";
  tableIndex: number;
  lastRowid: number;
  partSeq: number;
  startedAt: number;
  lastComplete: number | null;
  firstStarted: number;
  pruneId: string | null;
};

/** Today's start time, or yesterday's before START_HOUR_UTC. */
export function dayStart(now: number): number {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), START_HOUR_UTC);
  return now >= start ? start : start - 24 * 60 * 60 * 1000;
}

/** The newest export; null when there is none, "no_table" before migration 0015. */
async function readLatest(db: D1Database): Promise<Latest | null | "no_table"> {
  try {
    // pruneId: the newest complete export, while pruning has not run after it.
    return await db
      .prepare(
        `SELECT id, status, table_index AS tableIndex, last_rowid AS lastRowid,
           part_seq AS partSeq, started_at AS startedAt,
           (SELECT MAX(started_at) FROM backup_exports WHERE status = 'complete') AS lastComplete,
           (SELECT MIN(started_at) FROM backup_exports) AS firstStarted,
           (SELECT CASE WHEN pruned_at IS NULL THEN id END FROM backup_exports
              WHERE status = 'complete' ORDER BY started_at DESC LIMIT 1) AS pruneId
         FROM backup_exports ORDER BY started_at DESC LIMIT 1`,
      )
      .first<Latest>();
  } catch (err) {
    // Before migration 0015 the table does not exist; code and migration order do not matter.
    if (errorText(err).includes("no such table")) return "no_table";
    throw err;
  }
}

type Cursor = { id: string; tableIndex: number; lastRowid: number; partSeq: number };

/**
 * Writes one page of `table` after the cursor; returns the calls used and the bytes written. An
 * oversized row costs about three full pages of CPU, so it is written only as a run's first page;
 * otherwise the run ends (`deferred`) and the next run starts with it.
 */
async function writePage(env: Env, cursor: Cursor, table: ExportTable, first: boolean) {
  const db = env.DB;
  const { results } = await db
    .prepare(pageQuery(table))
    .bind(cursor.lastRowid, PAGE_ROWS, PAGE_BYTES, SPLIT_BYTES)
    .all<{ r: number; s: string | null }>();
  if (results.length === 0) {
    cursor.tableIndex++;
    cursor.lastRowid = 0;
    cursor.partSeq = 0;
    return { calls: 1, bytes: 0, dirty: true, deferred: false };
  }
  let lines = results.map((r) => r.s as string);
  const head = results[0] as { r: number; s: string | null };
  const oversized = head.s === null;
  if (oversized) {
    // An oversized row always comes alone.
    if (!first) return { calls: 1, bytes: 0, dirty: false, deferred: true };
    const split = await db
      .prepare(splitQuery(table))
      .bind(head.r, LONG_VALUE_BYTES, PIECE_CHARS)
      .all<{ s: string }>();
    // Deleted since the page query: nothing to write; the next page query skips it.
    if (split.results.length === 0) return { calls: 2, bytes: 0, dirty: false, deferred: false };
    lines = split.results.map((r) => r.s);
  }
  const calls = oversized ? 2 : 1;
  const lastRowid = (results.at(-1) as { r: number }).r;
  const key = partKey(cursor.id, table.name, cursor.partSeq);
  const object = await env.MAIL.put(key, partText(lines));
  // put() answers null only for a failed onlyIf condition, which this call does not set.
  if (!object) throw new Error("part not written");
  const part: PartInfo = {
    table: table.name,
    key,
    bytes: object.size,
    md5: hex(object.checksums.md5),
  };
  await db
    .prepare(
      `UPDATE backup_exports SET table_index = ?2, last_rowid = ?3, part_seq = ?4,
         bytes = bytes + ?5,
         rows_json = json_set(rows_json, '$.' || ?6, json_object(
           'rows', COALESCE(json_extract(rows_json, '$.' || ?6 || '.rows'), 0) + ?7,
           'lastRowid', ?3)),
         parts_json = json_insert(parts_json, '$[#]', json(?8))
       WHERE id = ?1 AND status = 'running'`,
    )
    .bind(
      cursor.id,
      cursor.tableIndex,
      lastRowid,
      cursor.partSeq + 1,
      part.bytes,
      table.name,
      results.length,
      JSON.stringify(part),
    )
    .run();
  cursor.lastRowid = lastRowid;
  cursor.partSeq++;
  return { calls: calls + 2, bytes: part.bytes, dirty: false, deferred: false };
}

/** Writes the manifest last, then marks the export complete. */
async function finish(env: Env, id: string, now: number): Promise<void> {
  const db = env.DB;
  const [state, migration] = await db.batch([
    db
      .prepare(
        `SELECT id, started_at AS startedAt, rows_json AS rowsJson, parts_json AS partsJson
         FROM backup_exports WHERE id = ?`,
      )
      .bind(id),
    db.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1"),
  ]);
  const row = state?.results[0] as
    | { id: string; startedAt: number; rowsJson: string; partsJson: string }
    | undefined;
  if (!row) return;
  const name = (migration?.results[0] as { name: string } | undefined)?.name ?? null;
  const manifest = buildManifest(EXPORTED, row, now, name);
  await env.MAIL.put(manifestKey(id), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
  });
  await db
    .prepare(
      "UPDATE backup_exports SET status = 'complete', finished_at = ? WHERE id = ? AND status = 'running'",
    )
    .bind(now, id)
    .run();
  log("info", "backup_export_complete", {
    exportId: id,
    parts: manifest.tables.reduce((n, t) => n + t.parts.length, 0),
    rows: manifest.tables.reduce((n, t) => n + t.rows, 0),
  });
}

/** The cursor to work on this run: the running export, or a new one when the day's is due. */
async function cursorFor(env: Env, latest: Latest | null, now: number): Promise<Cursor | null> {
  if (latest?.status === "running") {
    if (latest.startedAt > now - RUNNING_MAX_MS) return { ...latest };
    await env.DB.prepare(
      "UPDATE backup_exports SET status = 'failed', error = 'timeout', finished_at = ? WHERE id = ?",
    )
      .bind(now, latest.id)
      .run();
    log("error", "backup_export_failed", { exportId: latest.id, error: "timeout" });
  } else if (latest && latest.startedAt >= dayStart(now)) {
    return null;
  }
  const id = exportIdOf(now);
  await env.DB.prepare(
    "INSERT INTO backup_exports (id, status, started_at) VALUES (?, 'running', ?) ON CONFLICT DO NOTHING",
  )
    .bind(id, now)
    .run();
  log("info", "backup_export_started", { exportId: id });
  return { id, tableIndex: 0, lastRowid: 0, partSeq: 0 };
}

/** One cron run's share of the export. A failure is logged, alerted and rethrown to the cron. */
export async function runExport(env: Env, now: number): Promise<void> {
  const latest = await readLatest(env.DB);
  if (latest === "no_table") return;
  const stale = latest && (latest.lastComplete ?? latest.firstStarted) <= now - STALE_AFTER_MS;
  if (stale && (await alertOwner(env, now, "stale"))) {
    log("error", "backup_stale", { lastComplete: latest.lastComplete });
  }
  const cursor = await cursorFor(env, latest, now);
  if (!cursor) {
    if (latest?.pruneId) await pruneExports(env, now, latest.pruneId);
    return;
  }
  let calls = 2;
  let bytes = 0;
  let dirty = false;
  try {
    while (
      cursor.tableIndex < EXPORTED.length &&
      bytes < RUN_BYTES &&
      calls + PAGE_CALLS + FINISH_CALLS <= RUN_CALLS
    ) {
      const table = EXPORTED[cursor.tableIndex] as ExportTable;
      const page = await writePage(env, cursor, table, bytes === 0);
      calls += page.calls;
      bytes += page.bytes;
      // A written part moves the stored cursor; an empty table or a vanished row does not.
      dirty = page.bytes > 0 ? false : dirty || page.dirty;
      if (page.deferred) break;
    }
    if (cursor.tableIndex >= EXPORTED.length) {
      await finish(env, cursor.id, now);
    } else if (dirty) {
      await env.DB.prepare(
        "UPDATE backup_exports SET table_index = ?, last_rowid = ?, part_seq = ? WHERE id = ? AND status = 'running'",
      )
        .bind(cursor.tableIndex, cursor.lastRowid, cursor.partSeq, cursor.id)
        .run();
    }
  } catch (err) {
    log("error", "backup_export_failed", {
      exportId: cursor.id,
      table: EXPORTED[cursor.tableIndex]?.name ?? null,
      seq: cursor.partSeq,
      error: errorText(err),
    });
    await alertOwner(env, now, "failed").catch(() => false);
    throw err;
  }
}
