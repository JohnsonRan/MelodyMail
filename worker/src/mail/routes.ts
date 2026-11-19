import type { Context, Hono } from "hono";
import type { AppEnv } from "../env";
import { clientInfo, fail, readJson } from "../http";
import { registerBulkRoutes } from "./bulk";
import { parseFlags, SESSION_FLAGS, updateMessageFlags } from "./flags";
import { FOLDERS, type Folder, isFolder } from "./folders";
import { searchFilter } from "./search";
import { deletePermanently } from "./trash";

// The mailbox API (docs/M4-mailbox.md, docs/M8-mailbox-ux.md). The Worker runs indexed queries
// and streams raw mail; it never parses or renders a message. The session routes and the /api/v1/
// routes (worker/src/api/v1.ts) share the read handlers; each side has its own PATCH handlers.

type Ctx = Context<AppEnv>;
type IdCtx = Context<AppEnv, "/:id">;

export const PAGE_MAX = 50;
export const BULK_MAX = 100;
const THREAD_MAX = 100;
const QUERY_MAX = 200;
const ID_MAX = 64;

const LIST_COLUMNS = `id, address_id AS addressId, subaddress_tag AS tag,
  COALESCE(from_hdr, envelope_from) AS "from", subject, snippet, received_at AS receivedAt,
  date_hdr AS date, raw_size AS size, read, starred, archived, trashed, spam,
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
  spam: number;
  hasAttachments: number;
} & Record<string, unknown>;

const toItem = (r: ListRow) => ({
  ...r,
  read: r.read === 1,
  starred: r.starred === 1,
  archived: r.archived === 1,
  trashed: r.trashed === 1,
  spam: r.spam === 1,
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

/** An address id from the query string: undefined when absent, null when malformed. */
export function parseAddress(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
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

export const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= ID_MAX;

export async function listMessages(c: Ctx) {
  const folder = c.req.query("folder") ?? "inbox";
  const cursor = parseCursor(c.req.query("cursor"));
  const limit = parseLimit(c.req.query("limit"));
  const addressId = parseAddress(c.req.query("address"));
  if (!isFolder(folder) || cursor === null || limit === null || addressId === null) {
    return fail(c, 400, "bad_request");
  }
  const where: string[] = [FOLDERS[folder]];
  const params: number[] = [];
  if (addressId !== undefined) {
    where.push("address_id = ?");
    params.push(addressId);
  }
  return page(c, where, params, cursor, limit);
}

export async function getMessage(c: IdCtx) {
  const row = await c.env.DB.prepare(`SELECT ${DETAIL_COLUMNS} FROM messages WHERE id = ?`)
    .bind(c.req.param("id"))
    .first<ListRow>();
  return row ? c.json({ message: toItem(row) }) : fail(c, 404, "not_found");
}

/** The folder a message is shown in for its thread: Trash, then Spam, else the others. */
const THREAD_FOLDER = `CASE WHEN trashed = 1 THEN 'trash' WHEN spam = 1 THEN 'spam' ELSE '' END`;

// Oldest first. A thread shows the messages of the same kind of folder as the one opened: Trash
// with Trash, Spam with Spam, and outside both neither.
export async function getThread(c: IdCtx) {
  const id = c.req.param("id");
  const db = c.env.DB;
  const self = await db
    .prepare(
      `SELECT thread_key AS threadKey, ${THREAD_FOLDER} AS folder FROM messages WHERE id = ?`,
    )
    .bind(id)
    .first<{ threadKey: string | null; folder: string }>();
  if (!self) return fail(c, 404, "not_found");
  const { results } = await db
    .prepare(
      `SELECT ${DETAIL_COLUMNS} FROM messages
       WHERE id = ? OR (thread_key = ? AND ${THREAD_FOLDER} = ?)
       ORDER BY received_at, id LIMIT ?`,
    )
    .bind(id, self.threadKey, self.folder, THREAD_MAX)
    .all<ListRow>();
  return c.json({ messages: results.map(toItem) });
}

// The raw message, streamed from R2 without being read in JS. The headers make a browser that
// opens this URL directly download the bytes instead of rendering them in this origin.
export async function getRaw(c: IdCtx) {
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
}

/**
 * The reader's flag change. `spam: true` is Report spam and `spam: false` is Not spam: the
 * sender is learned or forgotten in the same batch (docs/M8-mailbox-ux.md, "Filing").
 */
async function patchMessage(c: IdCtx) {
  const body = await readJson(c);
  const flags = body && parseFlags(body, SESSION_FLAGS);
  if (!flags) return fail(c, 400, "bad_request");
  const result = await updateMessageFlags(c.env, [c.req.param("id")], flags, { learn: true });
  return result.meta.changes > 0 ? c.json({ ok: true }) : fail(c, 404, "not_found");
}

// Permanent delete of one message, from Trash or Spam only.
async function deleteMessage(c: IdCtx) {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(`SELECT ${THREAD_FOLDER} AS folder FROM messages WHERE id = ?`)
    .bind(id)
    .first<{ folder: string }>();
  if (!row) return fail(c, 404, "not_found");
  if (row.folder !== "trash" && row.folder !== "spam") return fail(c, 409, "not_in_trash");
  const { deleted } = await deletePermanently(c.env, row.folder, [id], {
    audit: { event: "message_deleted", now: Date.now(), client: clientInfo(c), detail: id },
  });
  // Moved out of the folder between the read and the delete.
  if (deleted.length === 0) return fail(c, 409, "not_in_trash");
  return c.json({ ok: true });
}

// Search leaves Trash and Spam out, like the folder lists outside them, and pages newest first.
export async function searchMessages(c: Ctx) {
  const q = c.req.query("q") ?? "";
  const cursor = parseCursor(c.req.query("cursor"));
  const filter = q.length <= QUERY_MAX ? searchFilter(q) : null;
  if (!filter || cursor === null) return fail(c, 400, "bad_request");
  return page(
    c,
    [
      "trashed = 0 AND spam = 0",
      `id IN (SELECT message_id FROM messages_fts WHERE ${filter.where})`,
    ],
    filter.params,
    cursor,
    PAGE_MAX,
  );
}

/** Unread counts per folder, and per address for the inbox; both read messages_unread only. */
export function unreadStatements(db: D1Database) {
  const sum = (folder: Folder) => `COALESCE(SUM(${FOLDERS[folder]}), 0) AS ${folder}`;
  return [
    db.prepare(
      `SELECT ${sum("inbox")}, ${sum("starred")}, ${sum("archive")}, ${sum("spam")}, ${sum("trash")}
       FROM messages INDEXED BY messages_unread WHERE read = 0`,
    ),
    db.prepare(
      `SELECT address_id AS addressId, COUNT(*) AS unread FROM messages INDEXED BY messages_unread
       WHERE read = 0 AND trashed = 0 AND archived = 0 AND spam = 0 GROUP BY address_id`,
    ),
  ];
}

// Unread counts per folder, and per address for the inbox.
async function counts(c: Ctx) {
  const [folders, addresses] = await c.env.DB.batch(unreadStatements(c.env.DB));
  const perAddress: Record<string, number> = {};
  for (const r of (addresses?.results ?? []) as { addressId: number; unread: number }[]) {
    perAddress[r.addressId] = r.unread;
  }
  return c.json({ folders: folders?.results[0], addresses: perAddress });
}

export function registerMessageRoutes(messages: Hono<AppEnv>): void {
  messages.get("/", listMessages);
  // Before "/:id", so "count" and "purge" are not read as ids.
  registerBulkRoutes(messages);
  messages.get("/:id", getMessage);
  messages.get("/:id/thread", getThread);
  messages.get("/:id/raw", getRaw);
  messages.patch("/:id", patchMessage);
  messages.delete("/:id", deleteMessage);
}

export function registerMailboxRoutes(app: Hono<AppEnv>): void {
  app.get("/search", searchMessages);
  app.get("/counts", counts);
}
