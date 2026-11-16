import type { Context, Hono } from "hono";
import type { AppEnv } from "../env";
import { fail, log, readJson } from "../http";
import { notifyHub } from "../mail/hub";
import { prepare, type SentCopy } from "./outgoing";
import { callResend, type Quota, type SendError } from "./resend";
import { type Existing, failedUpdate, markFailed, retryExisting } from "./retry";
import { signedBlobUrl } from "./signed-url";
import { idempotencyKey } from "./validate";

// POST /api/messages/send (docs/M5-sending.md, "Sending"). The idempotency key is the client's,
// one per compose session; it is unique on messages and is passed to Resend, whose own 24-hour
// idempotency covers a retry of a send whose answer was lost.

const SNIPPET_MAX = 200;

const HTTP_STATUS: Record<SendError, 422 | 429 | 502> = {
  daily_quota_exceeded: 429,
  monthly_quota_exceeded: 429,
  rate_limited: 429,
  send_rejected: 422,
  send_failed: 502,
};

function sentKey(id: string, now: number): string {
  const d = new Date(now);
  return `sent/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${id}.json`;
}

export function quotaUpsert(db: D1Database, quota: Quota, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO send_quota (id, daily_used, monthly_used, seen_at) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET daily_used = excluded.daily_used,
         monthly_used = excluded.monthly_used, seen_at = excluded.seen_at`,
    )
    .bind(quota.dailyUsed, quota.monthlyUsed, now);
}

/** Inserts the "sending" row; null when a row with this key already exists. */
async function insertSending(
  c: Context<AppEnv>,
  key: string,
  copy: SentCopy,
  threadKey: string | null,
): Promise<{ id: string; r2Key: string } | null> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const r2Key = sentKey(id, now);
  const json = JSON.stringify(copy);
  const row = await c.env.DB.prepare(
    `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
       thread_key, in_reply_to, references_hdr, subject, from_hdr, to_hdr, cc_hdr, bcc_hdr,
       snippet, raw_size, has_attachments, r2_key, read, received_at, idempotency_key,
       first_attempt_at)
     VALUES (?, ?, 'out', 'sending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
  )
    .bind(
      id,
      copy.addressId,
      copy.from,
      [...copy.to, ...copy.cc, ...copy.bcc].join(", "),
      threadKey ?? id,
      copy.headers["In-Reply-To"] ?? null,
      copy.headers.References ?? null,
      copy.subject,
      copy.from,
      copy.to.join(", ") || null,
      copy.cc.join(", ") || null,
      copy.bcc.join(", ") || null,
      copy.text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX),
      new TextEncoder().encode(json).byteLength,
      copy.attachments.length > 0 ? 1 : 0,
      r2Key,
      now,
      key,
      now,
    )
    .first<{ id: string }>();
  if (!row) return null;
  // Written before the call, so a retry sends exactly this copy again.
  await c.env.MAIL.put(r2Key, json, { httpMetadata: { contentType: "application/json" } });
  if (copy.attachments.length > 0) {
    await c.env.DB.prepare(
      `UPDATE uploads SET message_id = ?
       WHERE id IN (SELECT value FROM json_each(?)) AND message_id IS NULL`,
    )
      .bind(id, JSON.stringify(copy.attachments.map((a) => a.uploadId)))
      .run();
  }
  return { id, r2Key };
}

async function deliver(c: Context<AppEnv>, id: string, key: string, copy: SentCopy) {
  const env = c.env;
  const db = env.DB;
  const apiKey = env.RESEND_API_KEY as string;
  const secret = env.UPLOAD_URL_KEY;
  if (copy.attachments.length > 0 && !secret) {
    await markFailed(db, id, "send_failed");
    return fail(c, 503, "attachments_not_configured");
  }
  const attachments = await Promise.all(
    copy.attachments.map(async (a) => ({
      filename: a.filename,
      path: await signedBlobUrl(
        copy.attachmentsOrigin,
        secret as string,
        a.uploadId,
        copy.attachmentsExpireAt,
      ),
    })),
  );
  const outcome = await callResend(
    env,
    apiKey,
    {
      from: copy.from,
      to: copy.to,
      cc: copy.cc.length > 0 ? copy.cc : undefined,
      bcc: copy.bcc.length > 0 ? copy.bcc : undefined,
      subject: copy.subject,
      text: copy.text,
      html: copy.html ?? undefined,
      headers: Object.keys(copy.headers).length > 0 ? copy.headers : undefined,
      attachments,
    },
    key,
  );
  const now = Date.now();
  const quota = outcome.quota ? [quotaUpsert(db, outcome.quota, now)] : [];
  if (!outcome.ok) {
    const fields = { messageId: id, status: outcome.status, name: outcome.name };
    if (outcome.code === "send_in_progress") {
      // Marking the row failed could overwrite the first request's success, which only updates
      // a row still "sending". After SENDING_STALE_MS a repeat may claim the row again.
      log("warn", "send_in_progress", fields);
      return fail(c, 409, "send_in_progress");
    }
    log("warn", "send_failed", fields);
    // A final rejection hands the attachments back to the draft for the corrected message.
    const release =
      outcome.code === "send_rejected"
        ? [db.prepare("UPDATE uploads SET message_id = NULL WHERE message_id = ?").bind(id)]
        : [];
    const unknown = outcome.code === "send_failed";
    await db.batch([...quota, failedUpdate(db, id, outcome.code, unknown), ...release]);
    await notifyHub(env, { type: "changed", id });
    return c.json({ error: outcome.code, id }, HTTP_STATUS[outcome.code]);
  }
  await db.batch([
    // The search row only while the row is still "sending", so a repeat adds no second one.
    db
      .prepare(
        `INSERT INTO messages_fts (message_id, subject, sender, body)
         SELECT id, ?, ?, ? FROM messages WHERE id = ? AND status = 'sending'`,
      )
      .bind(copy.subject, [...copy.to, ...copy.cc, ...copy.bcc].join(", "), copy.text, id),
    db
      .prepare(
        "UPDATE messages SET status = 'sent', resend_id = ?, error = NULL WHERE id = ? AND status = 'sending'",
      )
      .bind(outcome.resendId, id),
    ...quota,
    db.prepare("DELETE FROM drafts WHERE idempotency_key = ?").bind(key),
  ]);
  log("info", "send_ok", { messageId: id });
  await notifyHub(env, { type: "changed", id });
  return c.json({ message: { id, status: "sent" } });
}

/**
 * Sends `body` (the M5 send body) under idempotency key `key`, or repeats the send already made
 * under it. POST /api/messages/send and POST /api/v1/messages/send both end here, after checking
 * that RESEND_API_KEY is set.
 */
export async function sendMessage(c: Context<AppEnv>, body: Record<string, unknown>, key: string) {
  const db = c.env.DB;
  const findExisting = () =>
    db
      .prepare(
        `SELECT id, status, error, r2_key AS key, first_attempt_at AS firstAttemptAt,
           maybe_accepted AS maybeAccepted FROM messages WHERE idempotency_key = ?`,
      )
      .bind(key)
      .first<Existing>();

  let existing = await findExisting();
  if (!existing) {
    const prepared = await prepare(c, body);
    if ("error" in prepared) return fail(c, prepared.status, prepared.error);
    const inserted = await insertSending(c, key, prepared.copy, prepared.threadKey);
    if (inserted) return deliver(c, inserted.id, key, prepared.copy);
    // A concurrent request inserted the same key first.
    existing = await findExisting();
    if (!existing) return fail(c, 409, "send_in_progress");
  }

  const retry = await retryExisting(c, existing);
  return retry instanceof Response ? retry : deliver(c, existing.id, key, retry);
}

export function registerSendRoute(messages: Hono<AppEnv>): void {
  messages.post("/send", async (c) => {
    if (!c.env.RESEND_API_KEY) return fail(c, 503, "send_not_configured");
    const body = await readJson(c);
    const key = idempotencyKey(body?.idempotencyKey);
    if (!body || !key) return fail(c, 400, "bad_request");
    return sendMessage(c, body, key);
  });
}
