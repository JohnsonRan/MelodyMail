import type { Context, Hono } from "hono";
import type { AppEnv } from "../env";
import { fail, readJson } from "../http";
import { parseFlags, updateMessageFlags, V1_FLAGS } from "../mail/flags";
import { notifyHub } from "../mail/hub";
import {
  BULK_MAX,
  getMessage,
  getRaw,
  getThread,
  listMessages,
  searchMessages,
  validId,
} from "../mail/routes";
import { apiRoute } from "../routing";
import { sendMessage } from "../send/send";
import { idempotencyKey } from "../send/validate";

// REST API v1 (docs/M6-rules-api.md, "REST API v1"): API keys only, the same handlers as the
// session routes. Every route here is documented in worker/src/api/openapi.json; the worker suite
// checks both directions and every response body the tests receive.

type Ctx = Context<AppEnv>;

const SEND_FIELDS = new Set(["from", "to", "cc", "bcc", "subject", "text", "html", "replyTo"]);

const badRequest = (c: Ctx, path: string) => c.json({ error: "bad_request", path }, 400);

/** The first field of a v1 send body that has the wrong type, as a path such as `to.2`. */
function invalidSendField(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) if (!SEND_FIELDS.has(key)) return key;
  if (!Number.isSafeInteger(body.from)) return "from";
  for (const key of ["to", "cc", "bcc"]) {
    const list = body[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return key;
    const bad = list.findIndex((item) => typeof item !== "string");
    if (bad !== -1) return `${key}.${bad}`;
  }
  if (typeof body.text !== "string") return "text";
  for (const key of ["subject", "html", "replyTo"]) {
    if (body[key] !== undefined && typeof body[key] !== "string") return key;
  }
  return null;
}

async function send(c: Ctx) {
  if (!c.env.RESEND_API_KEY) return fail(c, 503, "send_not_configured");
  const header = c.req.header("idempotency-key");
  if (header === undefined) return fail(c, 400, "idempotency_key_required");
  const key = idempotencyKey(header);
  if (!key) return badRequest(c, "Idempotency-Key");
  const body = await readJson(c);
  if (!body) return fail(c, 400, "bad_request");
  const invalid = invalidSendField(body);
  if (invalid !== null) return badRequest(c, invalid);
  // The M5 body: no attachments, and a reply when replyTo names a stored message.
  return sendMessage(
    c,
    {
      fromAddressId: body.from,
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      text: body.text,
      html: body.html,
      ...(body.replyTo === undefined ? {} : { sourceId: body.replyTo, sourceKind: "reply" }),
    },
    key,
  );
}

/**
 * Fields the session PATCH accepts and a key may not use: a key cannot change Spam or move a whole
 * folder (docs/M8-mailbox-ux.md, decision 5).
 */
const SESSION_ONLY = ["spam", "folder", "address", "watermark", "after"];

/** The four flags of a v1 PATCH body; null for a session-only field or a bad value. */
function v1Flags(body: Record<string, unknown> | null) {
  if (!body || SESSION_ONLY.some((key) => body[key] !== undefined)) return null;
  return parseFlags(body, V1_FLAGS);
}

/**
 * A Spam row is never changed through a key (`spam = 0`), so an archive or a move to Trash cannot
 * pull it out of Spam and stop its clock; it counts as not found.
 */
const NOT_SPAM = { only: "spam = 0" };

/**
 * A script's flag change tells open pages to refresh, as a Telegram button does. One event per
 * request: pages refresh whole lists on any "changed", and a bulk change of 100 ids must not cost
 * 100 Durable Object calls.
 */
async function patchOne(c: Context<AppEnv, "/:id">) {
  const flags = v1Flags(await readJson(c));
  if (!flags) return fail(c, 400, "bad_request");
  const id = c.req.param("id");
  const result = await updateMessageFlags(c.env, [id], flags, NOT_SPAM);
  if (result.meta.changes === 0) return fail(c, 404, "not_found");
  await notifyHub(c.env, { type: "changed", id });
  return c.json({ ok: true });
}

async function patchMany(c: Ctx) {
  const body = await readJson(c);
  const flags = v1Flags(body);
  const ids = body?.ids;
  if (!flags || !Array.isArray(ids) || ids.length === 0 || !ids.every(validId)) {
    return fail(c, 400, "bad_request");
  }
  if (ids.length > BULK_MAX) return fail(c, 400, "too_many_ids");
  const result = await updateMessageFlags(c.env, ids, flags, NOT_SPAM);
  await notifyHub(c.env, { type: "changed", id: ids[0] as string });
  return c.json({ updated: result.meta.changes });
}

/** Every address with whether its domain may send; a key picks `from` here. */
async function addresses(c: Ctx) {
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.local_part || '@' || a.domain AS address, a.display_name AS displayName,
       a.enabled, d.send_enabled AS canSend
     FROM addresses a JOIN domains d ON d.name = a.domain ORDER BY a.domain, a.local_part`,
  ).all<{ id: number; address: string; displayName: string; enabled: number; canSend: number }>();
  return c.json({
    addresses: results.map((a) => ({
      ...a,
      enabled: a.enabled === 1,
      canSend: a.canSend === 1,
    })),
  });
}

export function registerApiV1(v1: Hono<AppEnv>): void {
  const read = ["mail:read"] as const;
  const write = ["mail:write"] as const;
  apiRoute(v1, "GET", "/messages", read, listMessages);
  apiRoute(v1, "GET", "/messages/:id", read, getMessage);
  apiRoute(v1, "GET", "/messages/:id/thread", read, getThread);
  apiRoute(v1, "GET", "/messages/:id/raw", read, getRaw);
  apiRoute(v1, "GET", "/search", read, searchMessages);
  // A send-only key needs the address ids for `from` (docs/M6-rules-api.md, "Scopes").
  apiRoute(v1, "GET", "/addresses", ["mail:read", "mail:send"], addresses);
  apiRoute(v1, "PATCH", "/messages", write, patchMany);
  apiRoute(v1, "PATCH", "/messages/:id", write, patchOne);
  apiRoute(v1, "POST", "/messages/send", ["mail:send"], send);
}
