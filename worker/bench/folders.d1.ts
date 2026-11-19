/**
 * D1 work of the M8 folder statements (docs/M8-mailbox-ux.md, "Folder rules"), measured in workerd
 * on a local D1 with the real migrations: rows read and written per call (D1 meta), the query
 * plan of every statement, the binding calls, and the wall time of each call. Local wall time
 * includes I/O and is an upper bound of CPU time; workerd does not advance the clock during
 * computation. Fixtures:
 * - mixed: 5,000 messages, 10% Spam, 10% Trash, 10% Archive, 10% Sent, the rest Inbox, over three
 *   addresses, plus a sparse address with one Inbox, one Trash and one Spam row, and an address
 *   with none;
 * - dense: 5,000 messages all in Trash, emptied completely by the purge loop;
 * - skewed: 5,000 messages whose 2,000 newest are all Spam.
 * Every message has a search row of about 1 KB. Fails when a call reads more rows than its budget
 * (REQUIREMENTS.md, "Numbers": D1 rows read per call).
 *
 * Usage: bun run bench:folders (from worker/)
 */
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Env } from "../src/env";
import { handleScheduled } from "../src/mail/consumer";
import { flagStatement } from "../src/mail/flags";
import {
  countStatement,
  type DeletableFolder,
  FOLDERS,
  type Folder,
  folderTarget,
  PURGE_MAX,
} from "../src/mail/folders";
import { PAGE_MAX, unreadStatements } from "../src/mail/routes";
import { purgeFolder, TRASH_EXPIRE_MAX, TRASH_KEEP_MS } from "../src/mail/trash";
import { MATCH_ROWS, receivedContacts, SCAN_ROWS } from "../src/send/contacts";

const N = 5000;
const DAY = 24 * 60 * 60 * 1000;
/** The cron run time: the oldest half of the fixture is past its 30 days. */
const NOW = Date.UTC(2026, 10, 18, 3, 15);
const T0 = NOW - TRASH_KEEP_MS - 10 * DAY;
const STEP = Math.floor((20 * DAY) / N);
const SPARSE = 50;
const EMPTY = 51;

type Stmt = { sql: string; params: unknown[] };
type Done = Stmt & { read: number; written: number };
type Call = { kind: string; ms: number; statements: Done[] };

/** env with D1 and R2 wrapped: every binding call, its statements and its D1 meta are recorded. */
function metered() {
  const calls: Call[] = [];
  const record = async <T>(kind: string, statements: Stmt[], run: () => Promise<T>) => {
    const start = performance.now();
    const result = await run();
    const ms = performance.now() - start;
    const metas = (Array.isArray(result) ? result : [result]).map(
      (r) => (r as D1Result | null)?.meta,
    );
    calls.push({
      kind,
      ms,
      statements: statements.map((st, i) => ({
        ...st,
        read: metas[i]?.rows_read ?? 0,
        written: metas[i]?.rows_written ?? 0,
      })),
    });
    return result;
  };
  type Wrapped = D1PreparedStatement & { inner: D1PreparedStatement; stmt: Stmt };
  const wrap = (inner: D1PreparedStatement, stmt: Stmt): Wrapped => {
    const all = () => record("d1", [stmt], () => inner.all());
    return {
      inner,
      stmt,
      bind: (...params: unknown[]) => wrap(inner.bind(...params), { sql: stmt.sql, params }),
      all,
      run: all,
      first: async (column?: string) => {
        const row = ((await all()) as D1Result<Record<string, unknown>>).results[0];
        if (!row) return null;
        return column === undefined ? row : row[column];
      },
      raw: () => {
        throw new Error("raw() is not metered");
      },
    } as unknown as Wrapped;
  };
  const DB = {
    prepare: (sql: string) => wrap(env.DB.prepare(sql), { sql, params: [] }),
    batch: (list: Wrapped[]) =>
      record(
        "d1",
        list.map((s) => s.stmt),
        () => env.DB.batch(list.map((s) => s.inner)),
      ),
  } as unknown as D1Database;
  const r2 =
    (name: keyof R2Bucket) =>
    (...args: unknown[]) =>
      record("r2", [], () => (env.MAIL[name] as (...a: unknown[]) => Promise<unknown>)(...args));
  const MAIL = {
    get: r2("get"),
    put: r2("put"),
    delete: r2("delete"),
    list: r2("list"),
    head: r2("head"),
  } as unknown as R2Bucket;
  const INBOUND = {
    send: () => record("queue", [], async () => undefined),
    sendBatch: () => record("queue", [], async () => undefined),
  } as unknown as Queue;
  return { env: { ...env, DB, MAIL, INBOUND } as Env, calls };
}

const plans = new Map<string, string>();

/** EXPLAIN QUERY PLAN of a statement, one line; "SCAN messages" without an index is a table scan. */
async function planOf(stmt: Stmt): Promise<string> {
  const key = stmt.sql;
  const known = plans.get(key);
  if (known) return known;
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${stmt.sql}`)
    .bind(...stmt.params)
    .all<{ detail: string }>();
  const plan = results.map((r) => r.detail).join("; ");
  plans.set(key, plan);
  return plan;
}

const isScan = (plan: string) => /(^|; )SCAN messages(?! USING)(?!_fts)/.test(plan);

type Row = {
  fixture: string;
  operation: string;
  calls: number;
  /** Rows read by every statement except the FTS delete, which is reported apart. */
  read: number;
  fts: number;
  written: number;
  ms: number;
  budget: number;
  plans: string[];
};

/** The search-row delete scans messages_fts (message_id is UNINDEXED); it predates M8. */
const isFtsDelete = (st: Stmt) => st.sql.startsWith("DELETE FROM messages_fts");
const table: Row[] = [];

async function measure(
  fixture: string,
  operation: string,
  budget: number | ((result: unknown) => number),
  run: (env: Env) => Promise<unknown>,
) {
  const m = metered();
  const result = await run(m.env);
  const statements = m.calls.flatMap((c) => c.statements);
  const sum = (list: Done[], key: "read" | "written") => list.reduce((n, st) => n + st[key], 0);
  const row: Row = {
    fixture,
    operation,
    calls: m.calls.length,
    read: sum(
      statements.filter((st) => !isFtsDelete(st)),
      "read",
    ),
    fts: sum(statements.filter(isFtsDelete), "read"),
    written: sum(statements, "written"),
    ms: m.calls.reduce((n, c) => n + c.ms, 0),
    budget: 0,
    plans: await Promise.all(statements.map(planOf)),
  };
  row.budget = typeof budget === "function" ? budget(result) : budget;
  table.push(row);
  return row;
}

// --- fixtures -------------------------------------------------------------------------------

async function clear() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages_fts"),
    env.DB.prepare("DELETE FROM messages"),
  ]);
}

/**
 * N messages in received_at order; `kind(i)` (0 = oldest) picks the folder. Each folder clock is
 * the arrival time, so the oldest half is past its 30 days at NOW.
 */
type Kind = "inbox" | "spam" | "trash" | "archive" | "sent";

async function seed(kind: (i: number) => Kind) {
  await clear();
  const kinds = Array.from({ length: N }, (_, i) => kind(i));
  const code = { inbox: 0, spam: 1, trash: 2, archive: 3, sent: 4 };
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1),
     k AS (SELECT i, CAST(json_extract(?2, '$[' || i || ']') AS INTEGER) AS k FROM n)
     INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to, from_hdr,
       to_hdr, subject, snippet, raw_size, r2_key, read, starred, archived, trashed, trashed_at,
       spam, spam_at, from_key, received_at)
     SELECT printf('m%05d', i), 1 + i % 3, CASE k WHEN 4 THEN 'out' ELSE 'in' END, 'parsed',
       printf('s%d@example.org', i % 400), 'shop@example.com',
       printf('Sender %d <s%d@example.org>', i % 400, i % 400), 'shop@example.com',
       printf('Subject %d', i), 'snippet', 2000, printf('raw/2026/11/m%05d.eml', i),
       i % 3 != 0, i % 7 = 0, k = 3, k = 2, CASE k WHEN 2 THEN ?3 + i * ?4 END,
       k = 1, CASE k WHEN 1 THEN ?3 + i * ?4 END, printf('s%d@example.org', i % 400),
       ?3 + i * ?4
     FROM k`,
  )
    .bind(N, JSON.stringify(kinds.map((k) => code[k])), T0, STEP)
    .run();
  await env.DB.prepare(
    `INSERT INTO messages_fts (message_id, subject, sender, body)
     SELECT id, subject, from_hdr, substr(replace(hex(randomblob(600)), 'A', ' '), 1, 1100)
     FROM messages`,
  ).run();
}

async function sparseRows() {
  const insert = env.DB.prepare(
    `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to, raw_size,
       r2_key, trashed, trashed_at, spam, spam_at, received_at)
     VALUES (?, ?, 'in', 'parsed', 'a@b.c', 'shop@example.com', 1, ?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch([
    insert.bind("sparse-inbox", SPARSE, "raw/si", 0, null, 0, null, T0),
    insert.bind("sparse-trash", SPARSE, "raw/st", 1, T0, 0, null, T0),
    insert.bind("sparse-spam", SPARSE, "raw/ss", 0, null, 1, T0, T0),
  ]);
}

const watermark = async () =>
  (
    await env.DB.prepare("SELECT value FROM counters WHERE name = 'messages_seq'").first<{
      value: number;
    }>()
  )?.value ?? 0;

// --- budgets (REQUIREMENTS.md, "Numbers": D1 rows read per call) ------------------------------

/** A list page: the page and its look-ahead row, with room for rows the filter skips. */
const LIST_BUDGET = 4 * (PAGE_MAX + 1);
/** Rows of the view plus the counter reads. */
const viewBudget = (rows: number) => rows + 5;
/** A folder PATCH call: one pass over its index range, plus 12 rows per message it changes. */
const patchBudget = (range: number) => (result: unknown) =>
  range + 5 + 12 * ((result as D1Result).results?.length ?? 0);
/** A purge call without its FTS delete. */
const PURGE_BUDGET = 6 * PURGE_MAX + 10;
const CONTACT_BUDGET = SCAN_ROWS + MATCH_ROWS + 5;
/** The scheduled handler's binding calls: Workers Free allows 50 subrequests per invocation. */
const CRON_CALLS = 45;

const countWhere = async (where: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).first<{ n: number }>())
    ?.n ?? 0;

// --- operations -----------------------------------------------------------------------------

const listPage = (folder: Folder) => (e: Env) =>
  e.DB.prepare(
    `SELECT id, address_id, from_hdr, subject, snippet, received_at, read, starred, archived,
       trashed, spam FROM messages WHERE ${FOLDERS[folder]}
     ORDER BY received_at DESC, id DESC LIMIT ?`,
  )
    .bind(PAGE_MAX + 1)
    .all();

const unreadCounts = (e: Env) => e.DB.batch(unreadStatements(e.DB));

const contactScan = (e: Env) => e.DB.batch([receivedContacts(e.DB, "%s1%")]);

const folderPatch = (folder: Folder, addressId?: number) => async (e: Env) =>
  flagStatement(
    e.DB,
    folderTarget(folder, addressId, await watermark(), undefined),
    { read: true },
    NOW,
    "seq",
  ).all();

const purge = (folder: DeletableFolder, w: number, asOf: number, addressId?: number) => (e: Env) =>
  purgeFolder(e, folder, { addressId, watermark: w, before: asOf }, { event: "bench", now: asOf });

// --- runs -----------------------------------------------------------------------------------

/** Folder of message i in the mixed fixture. */
const MIXED = [
  "spam",
  "trash",
  "archive",
  "sent",
  "inbox",
  "inbox",
  "inbox",
  "inbox",
  "inbox",
  "inbox",
] as const;
const mixed = (i: number) => MIXED[i % 10] as Kind;

it("measures the folder statements", async () => {
  await seed(mixed);
  await sparseRows();
  const w = await watermark();
  const total = await countWhere("1");
  const unread = await countWhere("read = 0");
  const range = await countWhere("trashed = 0 AND archived = 0 AND spam = 0");
  await measure("mixed", "Inbox list page", LIST_BUDGET, listPage("inbox"));
  await measure("mixed", "Spam list page", LIST_BUDGET, listPage("spam"));
  await measure("mixed", "unread counts", 3 * unread + range, unreadCounts);
  await measure("mixed", "count route, Inbox", viewBudget(range), (e) =>
    countStatement(e.DB, "inbox").all(),
  );
  await measure("mixed", "count route, Trash", viewBudget(await countWhere(FOLDERS.trash)), (e) =>
    countStatement(e.DB, "trash").all(),
  );
  await measure("mixed", "count route, Spam, sparse address", viewBudget(3), (e) =>
    countStatement(e.DB, "spam", SPARSE).all(),
  );
  await measure("mixed", "contact scan", CONTACT_BUDGET, contactScan);
  await measure("mixed", "folder PATCH call, Inbox", patchBudget(range), folderPatch("inbox"));
  await measure(
    "mixed",
    "folder PATCH call, Inbox, address with 1 row",
    patchBudget(3),
    folderPatch("inbox", SPARSE),
  );
  await measure(
    "mixed",
    "folder PATCH call, Inbox, address with 0 rows",
    patchBudget(0),
    folderPatch("inbox", EMPTY),
  );
  await measure("mixed", "purge call, Trash", PURGE_BUDGET, purge("trash", w, NOW));
  await measure("mixed", "purge call, Spam", PURGE_BUDGET, purge("spam", w, NOW));
  await measure(
    "mixed",
    "purge call, Trash, address with 1 row",
    PURGE_BUDGET,
    purge("trash", w, NOW, SPARSE),
  );
  await measure(
    "mixed",
    "purge call, Trash, address with 0 rows",
    PURGE_BUDGET,
    purge("trash", w, NOW, EMPTY),
  );

  // The cron with 100 due in Trash, 100 due in Spam and an export starting.
  await seed(mixed);
  const cron = await measure("mixed", "scheduled handler", 0, (e) =>
    handleScheduled({ scheduledTime: NOW } as ScheduledController, e),
  );
  expect(await countWhere("1")).toBe(total - 3 - 2 * TRASH_EXPIRE_MAX);

  await seed(() => "trash");
  const wd = await watermark();
  const loop = { purges: 0, calls: 0, read: 0, fts: 0, written: 0, ms: 0, maxRead: 0 };
  for (let more = true; more && loop.purges < 100; ) {
    const row = await measure("dense", "purge call", PURGE_BUDGET, async (e) => {
      const done = await purge("trash", wd, NOW + DAY)(e);
      more = done.hasMore;
      return done;
    });
    loop.purges++;
    loop.calls += row.calls;
    loop.read += row.read;
    loop.fts += row.fts;
    loop.written += row.written;
    loop.ms += row.ms;
    loop.maxRead = Math.max(loop.maxRead, row.read);
    if (loop.purges > 1) table.pop();
  }
  expect(await countWhere("1")).toBe(0);

  await seed((i) => (i >= N - 2000 ? "spam" : mixed(i) === "spam" ? "inbox" : mixed(i)));
  const skewedRange = await countWhere("trashed = 0 AND archived = 0 AND spam = 0");
  await measure("skewed", "Inbox list page", LIST_BUDGET, listPage("inbox"));
  await measure("skewed", "Starred list page", LIST_BUDGET, listPage("starred"));
  await measure("skewed", "count route, Inbox", viewBudget(skewedRange), (e) =>
    countStatement(e.DB, "inbox").all(),
  );
  await measure("skewed", "contact scan", CONTACT_BUDGET, contactScan);
  await measure(
    "skewed",
    "unread counts",
    3 * (await countWhere("read = 0")) + skewedRange,
    unreadCounts,
  );

  for (const r of table) {
    console.log(
      `${r.fixture} | ${r.operation} | calls ${r.calls} | read ${r.read} | FTS delete ${r.fts} | ` +
        `written ${r.written} | ${r.ms.toFixed(1)} ms | budget ${r.budget || "-"}\n    ` +
        [...new Set(r.plans)].join("\n    "),
    );
  }
  console.log(
    `dense Empty Trash: ${loop.purges} purge calls, ${loop.calls} binding calls, ` +
      `${loop.read} rows read (max ${loop.maxRead} per call) and ${loop.fts} by the FTS delete, ` +
      `${loop.written} written, ${loop.ms.toFixed(0)} ms`,
  );
  const over = table.filter((r) => r.budget > 0 && r.read > r.budget);
  const scans = table.filter((r) => r.plans.some(isScan));
  console.log(
    `over budget: ${over.map((r) => `${r.fixture}/${r.operation}`).join(", ") || "none"}`,
  );
  console.log(
    `table scans: ${scans.map((r) => `${r.fixture}/${r.operation}`).join(", ") || "none"}`,
  );
  expect(cron.calls).toBeLessThanOrEqual(CRON_CALLS);
  expect(over).toEqual([]);
  expect(scans).toEqual([]);
});
