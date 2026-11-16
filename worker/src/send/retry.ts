import type { Context } from "hono";
import type { AppEnv } from "../env";
import { fail } from "../http";
import type { SentCopy } from "./outgoing";
import { SIGNED_URL_TTL_S } from "./signed-url";

// A repeat of POST /api/messages/send under a key that already has a row: the retry window and
// the claim (docs/M5-sending.md, "Sending"; owner rulings 9, 10, 11 and 13).

/** A send still "sending" after this long is taken to have died and may be retried. */
export const SENDING_STALE_MS = 60_000;
/** Resend keeps an idempotency key 24 hours from the first request it stored under it. */
const RESEND_IDEMPOTENCY_MS = 24 * 3600_000;
/** Kept off the end of Resend's window, for clock skew and a slow first request. */
export const RETRY_WINDOW_MARGIN_MS = 5 * 60_000;
/**
 * A same-key retry is sent only this long after the first attempt (owner ruling 13). Later, a
 * row whose outcome is unknown is refused: Resend no longer dedupes the key, so it could send a
 * second email. A row Resend definitely refused every time (429) is sent as a fresh attempt.
 */
export const RETRY_WINDOW_MS = RESEND_IDEMPOTENCY_MS - RETRY_WINDOW_MARGIN_MS;

/** Delivered, or on its way: a repeat returns the message and calls nobody. */
const DONE = new Set([
  "sent",
  "delayed",
  "delivered",
  "bounced",
  "complained",
  "suppressed",
  "delivery_failed",
]);

export type Existing = {
  id: string;
  status: string;
  error: string | null;
  key: string;
  firstAttemptAt: number;
  maybeAccepted: number;
};

/**
 * `unknown`: Resend was called and gave no definite refusal (a network error, a timeout, a 5xx),
 * so it may have accepted the message. The mark is never cleared.
 */
export function failedUpdate(db: D1Database, id: string, code: string, unknown = false) {
  return db
    .prepare(
      `UPDATE messages SET status = 'failed', error = ?,
         maybe_accepted = CASE WHEN ? THEN 1 ELSE maybe_accepted END
       WHERE id = ? AND status = 'sending'`,
    )
    .bind(code, unknown ? 1 : 0, id);
}

export function markFailed(db: D1Database, id: string, code: string) {
  return failedUpdate(db, id, code).run();
}

/**
 * Claims a failed or stale row for another try; false when another request holds it or the row
 * is final. A rejection (send_rejected) is final: the corrected message is a new send under a
 * new key, and the rejected copy's attachments have gone back to the draft.
 *
 * Inside the window the same request goes out again and Resend dedupes it. Past the window only
 * a failed row that Resend refused on every attempt is claimed, as a fresh first attempt; the
 * maybe_accepted test repeats the route's check against a concurrent attempt that ended unknown.
 */
async function claimRetry(
  c: Context<AppEnv>,
  id: string,
  now: number,
  fresh: boolean,
): Promise<boolean> {
  const db = c.env.DB;
  const statement = fresh
    ? db
        .prepare(
          `UPDATE messages SET status = 'sending', error = NULL, received_at = ?,
             first_attempt_at = ?
           WHERE id = ? AND maybe_accepted = 0
             AND status = 'failed' AND error IS NOT 'send_rejected'`,
        )
        .bind(now, now, id)
    : db
        .prepare(
          // Taking over an attempt that never answered: its outcome is unknown.
          `UPDATE messages SET status = 'sending', error = NULL, received_at = ?,
             maybe_accepted = CASE WHEN status = 'sending' THEN 1 ELSE maybe_accepted END
           WHERE id = ? AND ((status = 'failed' AND error IS NOT 'send_rejected')
               OR (status = 'sending' AND received_at <= ?))`,
        )
        .bind(now, id, now - SENDING_STALE_MS);
  const { meta } = await statement.run();
  return meta.changes > 0;
}

/**
 * Decides a repeat on an existing row: the answer to return, or the stored copy to send again
 * after the row was claimed.
 */
export async function retryExisting(
  c: Context<AppEnv>,
  existing: Existing,
): Promise<Response | SentCopy> {
  if (DONE.has(existing.status)) {
    return c.json({ message: { id: existing.id, status: existing.status } });
  }
  const now = Date.now();
  const pastWindow = existing.firstAttemptAt <= now - RETRY_WINDOW_MS;
  const unknown = existing.status === "sending" || existing.maybeAccepted === 1;
  if (pastWindow && unknown && existing.error !== "send_rejected") {
    // Resend may have sent it and no longer dedupes the key: only a new message may follow.
    return c.json({ error: "send_status_unknown", id: existing.id }, 409);
  }
  if (!(await claimRetry(c, existing.id, now, pastWindow))) {
    return existing.status === "failed" && existing.error === "send_rejected"
      ? c.json({ error: "send_rejected", id: existing.id }, 422)
      : fail(c, 409, "send_in_progress");
  }
  // A retry sends the stored copy, so Resend sees the same request under the same key.
  const object = await c.env.MAIL.get(existing.key);
  if (!object) {
    await markFailed(c.env.DB, existing.id, "send_failed");
    return fail(c, 500, "internal");
  }
  let copy = await object.json<SentCopy>();
  if (pastWindow && copy.attachments.length > 0) {
    // A fresh first attempt: Resend refused every earlier one, so a new expiry cannot make a
    // second email. Written back, so retries inside the new window stay byte-identical (owner
    // rulings 9 and 13). Inside the window the stored URLs are never re-signed.
    copy = { ...copy, attachmentsExpireAt: Math.floor(now / 1000) + SIGNED_URL_TTL_S };
    await c.env.MAIL.put(existing.key, JSON.stringify(copy), {
      httpMetadata: { contentType: "application/json" },
    });
  }
  return copy;
}
