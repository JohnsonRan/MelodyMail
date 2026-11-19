import type { ExportTable } from "./tables";

// The SQL text of an export (docs/M7-ops.md, "Paging" and "Statement length"). D1 builds every
// statement with quote() and ||, the rare row whose INSERT would pass D1's 100,000-byte statement
// limit included, so the Worker never formats a value; it only joins the lines D1 returns. Pure
// functions, so the Bun benchmark measures the same code.

/** A page stays under this many bytes of SQL, except a single oversized row, which goes alone. */
export const PAGE_BYTES = 256 * 1024;
/** Rows a page query reads at most. */
export const PAGE_ROWS = 500;
/** An INSERT longer than this is split. */
export const SPLIT_BYTES = 90_000;
/** In a split row, a text value longer than this moves out of the INSERT into UPDATEs. */
export const LONG_VALUE_BYTES = 8_192;
/** Characters per UPDATE piece: at most 64,000 bytes of UTF-8, or 32,000 with every quote doubled. */
export const PIECE_CHARS = 16_000;

const ident = (name: string) => `"${name}"`;

function insertHead(table: ExportTable): string {
  return `'INSERT INTO ${ident(table.name)} (${table.columns.map(ident).join(",")}) VALUES ('`;
}

const isLong = (c: string) => `(typeof(${c}) = 'text' AND length(CAST(${c} AS BLOB)) > ?2)`;

/**
 * One page: rows after rowid ?1, at most ?2... in rowid order, cut where the running byte sum
 * passes ?3. A row longer than ?4 comes back with s NULL, and only as the first row of a page.
 * Parameters: ?1 last rowid, ?2 row limit, ?3 page bytes, ?4 split bytes.
 */
export function pageQuery(table: ExportTable): string {
  const values = table.columns.map((c) => `quote(${ident(c)})`).join(" || ',' || ");
  return `WITH p AS (
  SELECT rowid AS r, ${insertHead(table)} || ${values} || ');' AS s
  FROM ${ident(table.name)} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2
), w AS (
  SELECT r, s, length(CAST(s AS BLOB)) AS n FROM p
), c AS (
  SELECT r, s, n, ROW_NUMBER() OVER (ORDER BY r) AS i, SUM(n) OVER (ORDER BY r) AS acc,
    SUM(n > ?4) OVER (ORDER BY r) AS big FROM w
)
SELECT r, CASE WHEN n > ?4 THEN NULL ELSE s END AS s FROM c
WHERE i = 1 OR (acc <= ?3 AND big = 0) ORDER BY r`;
}

/**
 * One oversized row by rowid ?1, as ready statements in order (column s): the INSERT with every
 * text value over ?2 bytes left empty, then for each such value one UPDATE per ?3 characters that
 * appends the next piece. substr() counts characters, so no piece ends inside one, and each
 * UPDATE stays under 4 × ?3 bytes plus its WHERE clause. `*` leaves out an FTS5 table's rowid,
 * which is its key, so it is selected by name.
 */
export function splitQuery(table: ExportTable): string {
  const values = table.columns
    .map((c) => `CASE WHEN ${isLong(ident(c))} THEN '''''' ELSE quote(${ident(c)}) END`)
    .join(" || ',' || ");
  const where = table.key
    .map((k, i) => `'${i === 0 ? " WHERE " : " AND "}${ident(k)} = ' || quote(${ident(k)})`)
    .join(" || ");
  // Qualified: json_each has columns of its own (id, key, value, ...).
  const longs = table.columns
    .map((c) => `CASE WHEN ${isLong(`one.${ident(c)}`)} THEN one.${ident(c)} END`)
    .join(", ");
  const names = JSON.stringify(table.columns);
  return `WITH RECURSIVE one AS (SELECT rowid AS "rowid", * FROM ${ident(table.name)} WHERE rowid = ?1),
longs AS (
  SELECT j.key AS o, json_extract('${names}', '$[' || j.key || ']') AS name, j.value AS v
  FROM one, json_each(json_array(${longs})) AS j WHERE j.value IS NOT NULL
),
pieces(o, k, name, v) AS (
  SELECT o, 0, name, v FROM longs
  UNION ALL SELECT o, k + 1, name, v FROM pieces WHERE (k + 1) * ?3 < length(v)
)
SELECT -1 AS o, 0 AS k, ${insertHead(table)} || ${values} || ');' AS s FROM one
UNION ALL
SELECT o, k, 'UPDATE ${ident(table.name)} SET "' || name || '" = "' || name || '" || '
  || quote(substr(v, k * ?3 + 1, ?3)) || (SELECT ${where} FROM one) || ';' FROM pieces
ORDER BY o, k`;
}
/**
 * The last statement of a restore. Restored rows keep their seq, which the trigger leaves alone,
 * so the counter the migration seeded is moved past every restored value; the first message
 * stored afterwards gets a higher seq (docs/M8-mailbox-ux.md, "Data").
 */
export const RESTORE_COUNTER =
  "UPDATE counters SET value = MAX(value, (SELECT COALESCE(MAX(seq), 0) FROM messages)) WHERE name = 'messages_seq';";

/** A part's text: one statement per line, each ending in a newline. */
export function partText(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Every export lives under this prefix, which the mail code never writes. */
export const EXPORT_PREFIX = "backups/d1/";

export function partKey(exportId: string, table: string, seq: number): string {
  return `${EXPORT_PREFIX}${exportId}/part-${table}-${String(seq).padStart(5, "0")}.sql`;
}

export const manifestKey = (exportId: string) => `${EXPORT_PREFIX}${exportId}/manifest.json`;

export type PartInfo = { table: string; key: string; bytes: number; md5: string };
export type TableCount = { rows: number; lastRowid: number };

export type Manifest = {
  format: 1;
  exportId: string;
  startedAt: number;
  finishedAt: number;
  migration: string | null;
  tables: { name: string; rows: number; lastRowid: number; parts: Omit<PartInfo, "table">[] }[];
};

/** The manifest, from the state row's JSON; every exported table is listed, empty ones too. */
export function buildManifest(
  tables: ExportTable[],
  state: { id: string; startedAt: number; rowsJson: string; partsJson: string },
  finishedAt: number,
  migration: string | null,
): Manifest {
  const counts = JSON.parse(state.rowsJson) as Record<string, TableCount>;
  const parts = JSON.parse(state.partsJson) as PartInfo[];
  return {
    format: 1,
    exportId: state.id,
    startedAt: state.startedAt,
    finishedAt,
    migration,
    tables: tables.map(({ name }) => ({
      name,
      rows: counts[name]?.rows ?? 0,
      lastRowid: counts[name]?.lastRowid ?? 0,
      parts: parts
        .filter((p) => p.table === name)
        .map(({ key, bytes, md5 }) => ({ key, bytes, md5 })),
    })),
  };
}

/** R2's MD5 as lowercase hex. */
export function hex(buffer: ArrayBuffer | undefined): string {
  if (!buffer) return "";
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The export id: the UTC start minute, for example 2026-11-18T0300Z. */
export function exportIdOf(time: number): string {
  const iso = new Date(time).toISOString();
  return `${iso.slice(0, 13)}${iso.slice(14, 16)}Z`;
}
