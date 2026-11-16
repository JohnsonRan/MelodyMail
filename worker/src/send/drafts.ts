import type { Hono } from "hono";
import type { AppEnv } from "../env";
import { fail, readJson } from "../http";
import {
  byteLength,
  clientId,
  idempotencyKey,
  RECIPIENTS_MAX,
  SUBJECT_MAX_BYTES,
  stringList,
  TEXT_MAX,
} from "./validate";

// Drafts (docs/M5-sending.md, "Data"). The browser chooses the draft id and the idempotency key
// when compose opens and saves with PUT, debounced by at least 2 s. Sending deletes the draft.

const LIST_MAX = 100;
const SNIPPET_MAX = 200;
const KINDS = new Set(["reply", "replyAll", "forward"]);

type DraftRow = {
  id: string;
  addressId: number | null;
  toList: string;
  ccList: string;
  bccList: string;
  subject: string;
  text: string;
  sourceId: string | null;
  sourceKind: string | null;
  idempotencyKey: string;
  updatedAt: number;
};

const COLUMNS = `id, address_id AS addressId, to_list AS toList, cc_list AS ccList,
  bcc_list AS bccList, subject, text, source_id AS sourceId, source_kind AS sourceKind,
  idempotency_key AS idempotencyKey, updated_at AS updatedAt`;

function toDraft(r: DraftRow) {
  return {
    id: r.id,
    addressId: r.addressId,
    to: JSON.parse(r.toList) as string[],
    cc: JSON.parse(r.ccList) as string[],
    bcc: JSON.parse(r.bccList) as string[],
    subject: r.subject,
    text: r.text,
    sourceId: r.sourceId,
    sourceKind: r.sourceKind,
    idempotencyKey: r.idempotencyKey,
    updatedAt: r.updatedAt,
  };
}

/** A draft body; recipients need not be valid yet, only bounded. */
function parseDraft(body: Record<string, unknown>) {
  const to = stringList(body.to, RECIPIENTS_MAX);
  const cc = stringList(body.cc, RECIPIENTS_MAX);
  const bcc = stringList(body.bcc, RECIPIENTS_MAX);
  const subject = body.subject ?? "";
  const text = body.text ?? "";
  const addressId = body.addressId ?? null;
  const sourceId = body.sourceId ?? null;
  const sourceKind = body.sourceKind ?? null;
  const key = idempotencyKey(body.idempotencyKey);
  if (
    !to ||
    !cc ||
    !bcc ||
    !key ||
    typeof subject !== "string" ||
    byteLength(subject) > SUBJECT_MAX_BYTES ||
    typeof text !== "string" ||
    text.length > TEXT_MAX ||
    (addressId !== null && !Number.isSafeInteger(addressId)) ||
    (sourceId !== null && !clientId(sourceId)) ||
    (sourceKind !== null && !KINDS.has(sourceKind as string))
  ) {
    return null;
  }
  return {
    to,
    cc,
    bcc,
    subject,
    text,
    addressId: addressId as number | null,
    sourceId: sourceId as string | null,
    sourceKind: sourceKind as string | null,
    key,
  };
}

export function registerDraftRoutes(drafts: Hono<AppEnv>): void {
  drafts.get("/", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT ${COLUMNS} FROM drafts ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
      .bind(LIST_MAX)
      .all<DraftRow>();
    return c.json({
      drafts: results.map((r) => {
        const { text, ...rest } = toDraft(r);
        return { ...rest, snippet: text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX) };
      }),
    });
  });

  drafts.get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = c.env.DB;
    const [draft, files] = await db.batch([
      db.prepare(`SELECT ${COLUMNS} FROM drafts WHERE id = ?`).bind(id),
      db
        .prepare(
          `SELECT id, filename, content_type AS contentType, size FROM uploads
           WHERE draft_id = ? AND message_id IS NULL ORDER BY created_at, id`,
        )
        .bind(id),
    ]);
    const row = draft?.results[0] as DraftRow | undefined;
    if (!row) return fail(c, 404, "not_found");
    return c.json({ draft: { ...toDraft(row), attachments: files?.results ?? [] } });
  });

  drafts.put("/:id", async (c) => {
    const id = clientId(c.req.param("id"));
    const body = await readJson(c);
    const draft = body && parseDraft(body);
    if (!id || !draft) return fail(c, 400, "bad_request");
    const db = c.env.DB;
    // A message already sent with this key means another tab sent it; saving again would bring
    // the draft back.
    const sent = await db
      .prepare("SELECT 1 AS one FROM messages WHERE idempotency_key = ?")
      .bind(draft.key)
      .first();
    if (sent) return fail(c, 409, "already_sent");
    const now = Date.now();
    let changes = 0;
    try {
      const result = await db
        .prepare(
          `INSERT INTO drafts (id, address_id, to_list, cc_list, bcc_list, subject, text,
             source_id, source_kind, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET address_id = excluded.address_id,
             to_list = excluded.to_list, cc_list = excluded.cc_list, bcc_list = excluded.bcc_list,
             subject = excluded.subject, text = excluded.text, updated_at = excluded.updated_at
           WHERE drafts.idempotency_key = excluded.idempotency_key`,
        )
        .bind(
          id,
          draft.addressId,
          JSON.stringify(draft.to),
          JSON.stringify(draft.cc),
          JSON.stringify(draft.bcc),
          draft.subject,
          draft.text,
          draft.sourceId,
          draft.sourceKind,
          draft.key,
          now,
          now,
        )
        .run();
      changes = result.meta.changes;
    } catch {
      // The key belongs to another draft.
    }
    // No change: the key belongs to another draft, or this draft has a different key.
    if (changes === 0) return fail(c, 409, "draft_conflict");
    return c.json({ ok: true, updatedAt: now });
  });

  drafts.delete("/:id", async (c) => {
    // Its uploads are left to the cron, which removes uploads of a draft that is gone.
    const result = await c.env.DB.prepare("DELETE FROM drafts WHERE id = ?")
      .bind(c.req.param("id"))
      .run();
    return result.meta.changes > 0 ? c.json({ ok: true }) : fail(c, 404, "not_found");
  });
}
