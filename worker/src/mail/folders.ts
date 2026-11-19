// Folder membership and the folder-wide statements of M8 (docs/M8-mailbox-ux.md, "Folder rules").
// The lists, the counts, the count route, the folder-form PATCH, the purge and the cron all read
// their conditions from here, and worker/bench/folders.d1.ts measures these exact statements.

/**
 * Every flag combination falls in one folder besides Starred. Trash has no Spam test: a row with
 * both flags (written by M7 code after a rollback) shows, counts and expires in Trash.
 */
export const FOLDERS = {
  inbox: "direction = 'in' AND trashed = 0 AND archived = 0 AND spam = 0",
  sent: "direction = 'out' AND trashed = 0 AND spam = 0",
  starred: "starred = 1 AND trashed = 0 AND spam = 0",
  archive: "archived = 1 AND trashed = 0 AND spam = 0",
  spam: "spam = 1 AND trashed = 0",
  trash: "trashed = 1",
} as const;

export type Folder = keyof typeof FOLDERS;

export const isFolder = (value: unknown): value is Folder =>
  typeof value === "string" && Object.hasOwn(FOLDERS, value);

/**
 * The only folders whose mail is ever deleted permanently, each with the clock its 30 days run on
 * and the partial indexes ordered by it. `byId` is the same test with each column behind a unary
 * plus, which keeps the planner on the primary key when the ids are given: without it, it walked
 * the whole folder through messages_folder_received for each statement (worker/bench/folders.d1.ts).
 */
export const DELETABLE = {
  trash: {
    test: FOLDERS.trash,
    byId: "+trashed = 1",
    clock: "trashed_at",
    index: "messages_trashed_at",
    addressIndex: "messages_address_trashed_at",
  },
  spam: {
    test: FOLDERS.spam,
    byId: "+spam = 1 AND +trashed = 0",
    clock: "spam_at",
    index: "messages_spam_at",
    addressIndex: "messages_address_spam_at",
  },
} as const;

export type DeletableFolder = keyof typeof DELETABLE;

export const isDeletable = (value: unknown): value is DeletableFolder =>
  typeof value === "string" && Object.hasOwn(DELETABLE, value);

/**
 * The database's clock in milliseconds. Every folder clock (trashed_at, spam_at) and the count
 * route's asOf come from it, inside the statement that writes or reads them: D1 runs statements
 * one at a time, so a write that lands after the count carries a clock at or after its asOf,
 * however late the Worker's own write reached the database. SQLite fixes 'now' per statement.
 */
export const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

/** The last seq handed out: the watermark a confirm dialog holds. */
export const COUNTER_SQL = "(SELECT value FROM counters WHERE name = 'messages_seq')";

/** Messages a folder-form PATCH changes per call. */
export const FOLDER_PATCH_MAX = 500;
/** Messages a purge call deletes: one D1 batch and one R2 delete, as the cron. */
export const PURGE_MAX = 100;

type Where = { sql: string; params: number[] };

/** A folder, optionally of one address. */
export function folderWhere(folder: Folder, addressId?: number): Where {
  return addressId === undefined
    ? { sql: FOLDERS[folder], params: [] }
    : { sql: `${FOLDERS[folder]} AND address_id = ?`, params: [addressId] };
}

/**
 * The count route's statement: the database clock (asOf), the counter and the rows of the view at
 * or below it, read in one statement so the three agree. In Trash and Spam a row counts only with
 * its folder clock strictly before asOf, the purge's own test, so the count is what purge may
 * delete.
 */
export function countStatement(db: D1Database, folder: Folder, addressId?: number) {
  const where = folderWhere(folder, addressId);
  const clock = isDeletable(folder) ? ` AND ${DELETABLE[folder].clock} < ${DB_NOW}` : "";
  return db
    .prepare(
      `SELECT ${DB_NOW} AS asOf, ${COUNTER_SQL} AS watermark,
         (SELECT COUNT(*) FROM messages
           WHERE ${where.sql} AND seq <= ${COUNTER_SQL}${clock}) AS total`,
    )
    .bind(...where.params);
}

/**
 * The rows one folder-form PATCH call changes: at most FOLDER_PATCH_MAX of the view at or below the
 * watermark and below `after`, highest seq first. The continuation moves by seq whether or not a
 * row leaves the folder. A call reads the view's rows once (the folder index, or the address's
 * rows when one is given) and sorts them by seq.
 */
export function folderTarget(
  folder: Folder,
  addressId: number | undefined,
  watermark: number,
  after: number | undefined,
): Where {
  const where = folderWhere(folder, addressId);
  const below = after === undefined ? "" : " AND seq < ?";
  // Without statistics the planner preferred the folder index even for an address with one row.
  const from =
    addressId === undefined ? "messages" : "messages INDEXED BY messages_address_received";
  return {
    sql: `id IN (SELECT id FROM ${from} WHERE ${where.sql} AND seq <= ?${below}
      ORDER BY seq DESC LIMIT ${FOLDER_PATCH_MAX})`,
    params: [...where.params, watermark, ...(after === undefined ? [] : [after])],
  };
}

/** What a permanent delete may remove besides its ids: the folder test and the optional bounds. */
export type DeleteBounds = {
  addressId?: number;
  watermark?: number;
  /** Only rows whose folder clock is strictly before this time. */
  before?: number;
};

/**
 * The exact condition of a permanent delete, repeated by every statement of its batch. `byId`
 * writes it for a statement that also names the ids (see DELETABLE).
 */
export function deleteCondition(
  folder: DeletableFolder,
  bounds: DeleteBounds,
  byId = false,
): Where {
  const d = DELETABLE[folder];
  const col = (name: string) => (byId ? `+${name}` : name);
  const parts: string[] = [byId ? d.byId : d.test];
  const params: number[] = [];
  if (bounds.addressId !== undefined) {
    parts.push(`${col("address_id")} = ?`);
    params.push(bounds.addressId);
  }
  if (bounds.watermark !== undefined) {
    parts.push(`${col("seq")} <= ?`);
    params.push(bounds.watermark);
  }
  if (bounds.before !== undefined) {
    parts.push(`${col(d.clock)} < ?`);
    params.push(bounds.before);
  }
  return { sql: parts.join(" AND "), params };
}

/** The table with the clock index of the folder, by address when the bounds name one. */
export function deleteSource(folder: DeletableFolder, bounds: DeleteBounds): string {
  const d = DELETABLE[folder];
  return `messages INDEXED BY ${bounds.addressId === undefined ? d.index : d.addressIndex}`;
}

/** The ids of the next purge or expiry call: oldest by the folder clock first. */
export function deleteCandidates(
  db: D1Database,
  folder: DeletableFolder,
  bounds: DeleteBounds,
  limit: number,
) {
  const where = deleteCondition(folder, bounds);
  return db
    .prepare(
      `SELECT id FROM ${deleteSource(folder, bounds)} WHERE ${where.sql}
       ORDER BY ${DELETABLE[folder].clock} LIMIT ?`,
    )
    .bind(...where.params, limit);
}
