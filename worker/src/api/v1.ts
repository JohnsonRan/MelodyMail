import type { Context, Hono } from "hono";
import type { AppEnv } from "../env";
import { fail, readJson } from "../http";
import {
  getMessage,
  getRaw,
  getThread,
  listMessages,
  patchMessage,
  patchMessages,
  searchMessages,
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
  apiRoute(v1, "PATCH", "/messages", write, patchMessages);
  apiRoute(v1, "PATCH", "/messages/:id", write, patchMessage);
  apiRoute(v1, "POST", "/messages/send", ["mail:send"], send);
}
