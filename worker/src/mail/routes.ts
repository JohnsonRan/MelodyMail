import type { Context, Hono } from "hono";
import { audit } from "../auth/store";
import { parseFlag } from "../domains/validate";
import type { AppEnv } from "../env";
import { errorText, fail, log, readJson } from "../http";
import { searchFilter } from "./search";

// The mailbox API (docs/M4-mailbox.md). The Worker runs indexed queries and streams raw mail; it
// never parses or renders a message. Every route here is guarded by the session middleware.

export const PAGE_MAX = 50;
export const BULK_MAX = 100;
const THREAD_MAX = 100;
const QUERY_MAX = 200;
const ID_MAX = 64;

const FOLDERS = {
  inbox: "direction = 'in' AND trashed = 0 AND archived = 0",
  sent: "direction = 'out' AND trashed = 0",
  starred: "starred = 1 AND trashed = 0",
  archive: "archived = 1 AND trashed = 0",
  trash: "trashed = 1",
} as const;

const LIST_COLUMNS = `id, address_id AS addressId, subaddress_tag AS tag,
  COALESCE(from_hdr, envelope_from) AS "from", subject, snippet, received_at AS receivedAt,
  date_hdr AS date, raw_size AS size, read, starred, archived, trashed,
  has_attachments AS hasAttachments, status, thread_key AS threadKey, direction,
  to_hdr AS "to", error`;

const DETAIL_COLUMNS = `${LIST_COLUMNS}, cc_hdr AS cc, bcc_hdr AS bcc,
  idempotency_key AS idempotencyKey, first_attempt_at AS firstAttemptAt,
  maybe_accepted AS maybeAccepted,
  envelope_from AS envelopeFrom, envelope_to AS envelopeTo, forward_failed AS forwardFailed`;

type ListRow = {
  id: string;
  receivedAt: number;
  read: number;
  starred: number;
  archived: number;
  trashed: number;
  hasAttachments: number;
} & Record<string, unknown>;

const toItem = (r: ListRow) => ({
  ...r,
  read: r.read === 1,
  starred: r.starred === 1,
  archived: r.archived === 1,
  trashed: r.trashed === 1,
  hasAttachments: r.hasAttachments === 1,
});

type Cursor = { receivedAt: number; id: string };

/** The cursor is the last row's (received_at, id), the keyset the lists are ordered by. */
function encodeCursor(row: Cursor): string {
  return `${row.receivedAt}:${row.id}`;
}

function parseCursor(value: string | undefined): Cursor | null | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{1,15}):([\w-]{1,64})$/.exec(value);
  return match ? { receivedAt: Number(match[1]), id: match[2] as string } : null;
}

function parseLimit(value: string | undefined): number | null {
  if (value === undefined) return PAGE_MAX;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= PAGE_MAX ? n : null;
}

/** Reads `limit + 1` rows after the cursor, so the page knows whether another follows. */
async function page(
  c: Context<AppEnv>,
  where: string[],
  params: (string | number)[],
  cursor: Cursor | undefined,
  limit: number,
) {
  const clauses = [...where];
  const binds = [...params];
  if (cursor) {
    clauses.push("(received_at < ? OR (received_at = ? AND id < ?))");
    binds.push(cursor.receivedAt, cursor.receivedAt, cursor.id);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT ${LIST_COLUMNS} FROM messages WHERE ${clauses.join(" AND ")}
     ORDER BY received_at DESC, id DESC LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<ListRow>();
  const rows = results.slice(0, limit);
  const last = rows.at(-1);
  return c.json({
    messages: rows.map(toItem),
    nextCursor: results.length > limit && last ? encodeCursor(last) : null,
  });
}

type Flags = { read?: boolean; starred?: boolean; archived?: boolean; trashed?: boolean };

function parseFlags(body: Record<string, unknown>): Flags | null {
  const flags: Flags = {};
  for (const key of ["read", "starred", "archived", "trashed"] as const) {
    const parsed = parseFlag(body[key]);
    if (!parsed.ok) return null;
    if (parsed.value !== undefined) flags[key] = parsed.value;
  }
  return Object.keys(flags).length > 0 ? flags : null;
}

const flag = (value: boolean | undefined) => (value === undefined ? null : Number(value));

/** One UPDATE for any number of ids; a flag left out keeps its value. */
function updateFlags(c: Context<AppEnv>, ids: string[], flags: Flags) {
  return c.env.DB.prepare(
    `UPDATE messages SET read = COALESCE(?, read), starred = COALESCE(?, starred),
       archived = COALESCE(?, archived), trashed = COALESCE(?, trashed)
     WHERE id IN (SELECT value FROM json_each(?))`,
  )
    .bind(
      flag(flags.read),
      flag(flags.starred),
      flag(flags.archived),
      flag(flags.trashed),
      JSON.stringify(ids),
    )
    .run();
}

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= ID_MAX;

export function registerMessageRoutes(messages: Hono<AppEnv>): void {
  messages.get("/", async (c) => {
    const folder = c.req.query("folder") ?? "inbox";
    const cursor = parseCursor(c.req.query("cursor"));
    const limit = parseLimit(c.req.query("limit"));
    const address = c.req.query("address");
    const addressId = address === undefined ? undefined : Number(address);
    if (
      !Object.hasOwn(FOLDERS, folder) ||
      cursor === null ||
      limit === null ||
      (addressId !== undefined && !Number.isSafeInteger(addressId))
    ) {
      return fail(c, 400, "bad_request");
    }
    const where: string[] = [FOLDERS[folder as keyof typeof FOLDERS]];
    const params: number[] = [];
    if (addressId !== undefined) {
      where.push("address_id = ?");
      params.push(addressId);
    }
    return page(c, where, params, cursor, limit);
  });

  messages.patch("/", async (c) => {
    const body = await readJson(c);
    const flags = body && parseFlags(body);
    const ids = body?.ids;
    if (!flags || !Array.isArray(ids) || ids.length === 0 || !ids.every(validId)) {
      return fail(c, 400, "bad_request");
    }
    if (ids.length > BULK_MAX) return fail(c, 400, "too_many_ids");
    // A repeated id matches its row once: IN (json_each) is a set test.
    const result = await updateFlags(c, ids, flags);
    return c.json({ updated: result.meta.changes });
  });

  messages.get("/:id", async (c) => {
    const row = await c.env.DB.prepare(`SELECT ${DETAIL_COLUMNS} FROM messages WHERE id = ?`)
      .bind(c.req.param("id"))
      .first<ListRow>();
    return row ? c.json({ message: toItem(row) }) : fail(c, 404, "not_found");
  });

  // Oldest first. Outside Trash the thread leaves trashed messages out; in Trash it shows them.
  messages.get("/:id/thread", async (c) => {
    const id = c.req.param("id");
    const db = c.env.DB;
    const self = await db
      .prepare("SELECT thread_key AS threadKey, trashed FROM messages WHERE id = ?")
      .bind(id)
      .first<{ threadKey: string | null; trashed: number }>();
    if (!self) return fail(c, 404, "not_found");
    const { results } = await db
      .prepare(
        `SELECT ${DETAIL_COLUMNS} FROM messages
         WHERE id = ? OR (thread_key = ? AND trashed = ?)
         ORDER BY received_at, id LIMIT ?`,
      )
      .bind(id, self.threadKey, self.trashed, THREAD_MAX)
      .all<ListRow>();
    return c.json({ messages: results.map(toItem) });
  });

  // The raw message, streamed from R2 without being read in JS. The headers make a browser that
  // opens this URL directly download the bytes instead of rendering them in this origin.
  messages.get("/:id/raw", async (c) => {
    const row = await c.env.DB.prepare("SELECT r2_key AS key FROM messages WHERE id = ?")
      .bind(c.req.param("id"))
      .first<{ key: string }>();
    if (!row) return fail(c, 404, "not_found");
    const object = await c.env.MAIL.get(row.key);
    if (!object) return fail(c, 404, "not_found");
    return new Response(object.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="message.eml"',
        "content-length": String(object.size),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });

  messages.patch("/:id", async (c) => {
    const body = await readJson(c);
    const flags = body && parseFlags(body);
    if (!flags) return fail(c, 400, "bad_request");
    const result = await updateFlags(c, [c.req.param("id")], flags);
    return result.meta.changes > 0 ? c.json({ ok: true }) : fail(c, 404, "not_found");
  });

  // Permanent delete, only from Trash. The row and its search text go in one batch; the raw
  // object goes afterwards, so a failed R2 delete leaves an orphan for the M7 sweep rather than
  // a row whose raw message is gone.
  messages.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const db = c.env.DB;
    const [, deleted] = await db.batch<{ key: string }>([
      db
        .prepare(
          `DELETE FROM messages_fts WHERE message_id = ?
             AND EXISTS (SELECT 1 FROM messages WHERE id = ? AND trashed = 1)`,
        )
        .bind(id, id),
      db
        .prepare("DELETE FROM messages WHERE id = ? AND trashed = 1 RETURNING r2_key AS key")
        .bind(id),
    ]);
    const key = deleted?.results[0]?.key;
    if (key === undefined) {
      const exists = await db
        .prepare("SELECT 1 AS one FROM messages WHERE id = ?")
        .bind(id)
        .first();
      return exists ? fail(c, 409, "not_in_trash") : fail(c, 404, "not_found");
    }
    await audit(c, "message_deleted", Date.now(), id).run();
    try {
      await c.env.MAIL.delete(key);
    } catch (err) {
      log("warn", "mail_raw_delete_failed", { messageId: id, error: errorText(err) });
    }
    return c.json({ ok: true });
  });
}

export function registerMailboxRoutes(app: Hono<AppEnv>): void {
  // Search leaves Trash out, like the folder lists outside Trash, and pages newest first.
  app.get("/search", async (c) => {
    const q = c.req.query("q") ?? "";
    const cursor = parseCursor(c.req.query("cursor"));
    const filter = q.length <= QUERY_MAX ? searchFilter(q) : null;
    if (!filter || cursor === null) return fail(c, 400, "bad_request");
    return page(
      c,
      ["trashed = 0", `id IN (SELECT message_id FROM messages_fts WHERE ${filter.where})`],
      filter.params,
      cursor,
      PAGE_MAX,
    );
  });

  // Unread counts per folder, and per address for the inbox.
  app.get("/counts", async (c) => {
    const db = c.env.DB;
    const [folders, addresses] = await db.batch([
      db.prepare(
        `SELECT COALESCE(SUM(direction = 'in' AND trashed = 0 AND archived = 0), 0) AS inbox,
           COALESCE(SUM(starred = 1 AND trashed = 0), 0) AS starred,
           COALESCE(SUM(archived = 1 AND trashed = 0), 0) AS archive,
           COALESCE(SUM(trashed = 1), 0) AS trash
         FROM messages WHERE read = 0`,
      ),
      db.prepare(
        `SELECT address_id AS addressId, COUNT(*) AS unread FROM messages
         WHERE read = 0 AND trashed = 0 AND archived = 0 GROUP BY address_id`,
      ),
    ]);
    const perAddress: Record<string, number> = {};
    for (const r of (addresses?.results ?? []) as { addressId: number; unread: number }[]) {
      perAddress[r.addressId] = r.unread;
    }
    return c.json({ folders: folders?.results[0], addresses: perAddress });
  });
}
