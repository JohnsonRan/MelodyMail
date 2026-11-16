import {
  rawPayload,
  sendPushNotification,
  type VapidConfig,
  WebPushError,
} from "@mmmike/web-push/send";
import { SESSION_IDLE_MS } from "../auth/session";
import type { Env } from "../env";
import { log } from "../http";

// Sending Web Push (docs/M4b-pwa.md, "Sending"). The payload is encrypted end to end
// (aes128gcm); the push service sees only its size and timing. Logs carry the subscription id
// and the push service status, never an endpoint, a key or the payload.

/** Push services keep an undelivered message this long (24 hours). */
export const PUSH_TTL_SECONDS = 86_400;
/** Subscriptions reached per send; also the most kept (oldest dropped on PUT). */
export const MAX_SUBSCRIPTIONS = 10;
const PUSH_TIMEOUT_MS = 10_000;
const SUBJECT_MAX = 200;
const NAME_MAX = 200;
const ADDRESS_MAX = 320;

/** What the service worker receives; it localizes the fallbacks for a missing field. */
export type PushMessage =
  | { type: "message"; id: string; from: string; subject: string | null; to: string }
  | { type: "test" };

export type Outcome = "delivered" | "gone" | "failed";

type Row = { id: string; endpoint: string; p256dh: string; auth: string };

/** The VAPID key pair and subject, or null while push is not set up. */
export function vapidConfig(env: Env): VapidConfig | null {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = env;
  const subject = env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

/** Cuts by code point, so a surrogate pair is never split. */
function cut(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join("") : value;
}

/** The display name of a From header, else its address, else the envelope sender. */
export function senderLabel(fromHdr: string | null, envelopeFrom: string): string {
  if (!fromHdr?.trim()) return envelopeFrom;
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(fromHdr);
  if (!match) return fromHdr.trim();
  return (match[1] ?? "").trim() || (match[2] ?? "").trim() || envelopeFrom;
}

/** Sends one message to one subscription; a gone subscription (404, 410) is deleted. */
export async function sendTo(
  env: Env,
  vapid: VapidConfig,
  row: Row,
  message: PushMessage,
): Promise<Outcome> {
  try {
    const accepted = await sendPushNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      rawPayload(JSON.stringify(message)),
      vapid,
      { ttl: PUSH_TTL_SECONDS, urgency: "normal", timeoutMs: PUSH_TIMEOUT_MS },
    );
    if (accepted) return "delivered";
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(row.id).run();
    log("info", "push_subscription_gone", { subscriptionId: row.id });
    return "gone";
  } catch (err) {
    // The error's own text can carry the endpoint; only its kind and the status are logged.
    log("warn", "push_failed", {
      subscriptionId: row.id,
      status: err instanceof WebPushError ? err.statusCode : null,
      error: err instanceof Error ? err.name : "unknown",
    });
    return "failed";
  }
}

/**
 * Tells the device of every live session about a new message, except the sessions in
 * `skipSessions`, which have a mailbox page open. A failure is logged per subscription and never
 * thrown.
 */
export async function pushNewMail(
  env: Env,
  messageId: string,
  skipSessions: string[] = [],
  now = Date.now(),
): Promise<void> {
  const vapid = vapidConfig(env);
  if (!vapid) return;
  const [mail, subs] = await env.DB.batch([
    env.DB.prepare(
      "SELECT subject, from_hdr AS fromHdr, envelope_from AS envelopeFrom, envelope_to AS envelopeTo FROM messages WHERE id = ?",
    ).bind(messageId),
    // Joined on live sessions: an expired session that the sweep has not deleted yet gets nothing.
    env.DB.prepare(
      `SELECT p.id, p.endpoint, p.p256dh, p.auth FROM push_subscriptions p
       JOIN sessions s ON s.id = p.session_id
       WHERE s.expires_at > ? AND s.last_seen_at > ?
         AND p.session_id NOT IN (SELECT value FROM json_each(?))
       ORDER BY p.created_at DESC LIMIT ?`,
    ).bind(now, now - SESSION_IDLE_MS, JSON.stringify(skipSessions), MAX_SUBSCRIPTIONS),
  ]);
  const row = mail?.results[0] as
    | { subject: string | null; fromHdr: string | null; envelopeFrom: string; envelopeTo: string }
    | undefined;
  const targets = (subs?.results ?? []) as Row[];
  if (!row || targets.length === 0) return;
  const message: PushMessage = {
    type: "message",
    id: messageId,
    from: cut(senderLabel(row.fromHdr, row.envelopeFrom), NAME_MAX),
    subject: row.subject === null ? null : cut(row.subject, SUBJECT_MAX),
    to: cut(row.envelopeTo, ADDRESS_MAX),
  };
  await Promise.all(targets.map((t) => sendTo(env, vapid, t, message)));
}
