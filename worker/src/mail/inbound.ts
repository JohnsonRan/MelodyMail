import { auditRow } from "../auth/store";
import type { Env } from "../env";
import { errorText, log } from "../http";

// The email() handler (docs/M3-inbound.md). It never reads message content in JS: the raw
// message is piped natively into R2 and parsed later by the queue consumer.
//
// Two platform facts it depends on, checked against the Cloudflare docs on 2026-11-16:
//
// 1. forward() works after message.raw has been read. The official local-development example
//    reads the whole raw stream (`new Response(message.raw).arrayBuffer()`) and then calls
//    message.forward(): https://developers.cloudflare.com/email-service/local-development/routing/
//    So the design's order holds: store first, then forward.
// 2. What a thrown error does at the sending server is not documented. The Workers API page
//    (https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) documents
//    only setReject() ("a permanent SMTP error"); community reports describe a thrown error as
//    "521 5.3.0 Upstream error", also permanent. So a storage failure most likely bounces the
//    message back to the sender rather than being retried. The handler still throws then: the
//    sender is told, and nothing has been forwarded, so no retry can forward twice. Recorded as
//    an open question in docs/STATE.md.

/** Marks a message MelodyMail forwarded, so a forward that comes back is not forwarded again. */
export const FORWARDED_HEADER = "X-MelodyMail-Forwarded";

export type Recipient = { localPart: string; domain: string; tag: string | null };

/** The envelope recipient, lowercased, with its sub-address tag split off at the first "+". */
export function parseRecipient(to: string): Recipient | null {
  const address = to.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  const local = address.slice(0, at);
  const plus = local.indexOf("+");
  return {
    localPart: plus === -1 ? local : local.slice(0, plus),
    domain: address.slice(at + 1),
    tag: plus === -1 ? null : local.slice(plus + 1) || null,
  };
}

type AddressRow = {
  id: number;
  enabled: number;
  forward_only: number;
  receive_enabled: number;
  target: string | null;
};

type Address = { id: number; forwardOnly: boolean; targets: string[] };

/** One indexed lookup on addresses (domain, local_part); null when the address may not receive. */
async function findAddress(db: D1Database, r: Recipient): Promise<Address | null> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.enabled, a.forward_only, d.receive_enabled, t.email AS target
         FROM addresses a
         JOIN domains d ON d.name = a.domain
         LEFT JOIN address_forwards f ON f.address_id = a.id
         LEFT JOIN forward_targets t ON t.id = f.target_id
        WHERE a.domain = ? AND a.local_part = ?`,
    )
    .bind(r.domain, r.localPart)
    .all<AddressRow>();
  const first = results[0];
  if (!first?.enabled || !first.receive_enabled) return null;
  return {
    id: first.id,
    forwardOnly: Boolean(first.forward_only),
    targets: [...new Set(results.flatMap((row) => (row.target ? [row.target] : [])))],
  };
}

/**
 * Where this message is forwarded. M3 has the address's default targets only; M6 adds the
 * targets of matching forwarding rules here (envelope and headers only, no body).
 */
function forwardTargets(address: Address): string[] {
  return address.targets;
}

/** Forwards to each target once; returns how many failed. A failure never throws. */
async function forwardAll(
  message: ForwardableEmailMessage,
  targets: string[],
  addressId: number,
): Promise<number> {
  let failed = 0;
  for (const target of targets) {
    try {
      await message.forward(target, new Headers({ [FORWARDED_HEADER]: "1" }));
    } catch (err) {
      failed++;
      log("warn", "mail_forward_failed", { addressId, error: errorText(err) });
    }
  }
  return failed;
}

function rawKey(id: string, now: number): string {
  const d = new Date(now);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `raw/${d.getUTCFullYear()}/${month}/${id}.eml`;
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const recipient = parseRecipient(message.to);
  const address = recipient && (await findAddress(env.DB, recipient));
  if (!recipient || !address) {
    message.setReject("Address not found");
    return;
  }
  const now = Date.now();
  // A message MelodyMail forwarded earlier is kept, never forwarded again.
  const targets = message.headers.has(FORWARDED_HEADER) ? [] : forwardTargets(address);

  let forwardFailed = 0;
  if (address.forwardOnly && targets.length > 0) {
    forwardFailed = await forwardAll(message, targets, address.id);
    const sent = targets.length - forwardFailed;
    try {
      await auditRow(
        env.DB,
        "mail_forwarded",
        now,
        `address ${address.id}: ${sent}/${targets.length}`,
      ).run();
    } catch (err) {
      // Throwing now would make a retry forward again.
      log("error", "mail_audit_failed", { addressId: address.id, error: errorText(err) });
    }
    if (sent > 0) return;
    // Every forward failed: keep the message below instead of losing it.
  }

  // Storage. Either step may throw; nothing has been forwarded yet unless every forward failed.
  const id = crypto.randomUUID();
  const key = rawKey(id, now);
  const { readable, writable } = new FixedLengthStream(message.rawSize);
  await Promise.all([env.MAIL.put(key, readable), message.raw.pipeTo(writable)]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
         subaddress_tag, raw_size, r2_key, forward_failed, received_at)
       VALUES (?, ?, 'in', 'stored', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      address.id,
      message.from,
      message.to,
      recipient.tag,
      message.rawSize,
      key,
      forwardFailed,
      now,
    ),
    env.DB.prepare("UPDATE addresses SET last_received_at = ? WHERE id = ?").bind(now, address.id),
  ]);

  // Forward and keep: the row exists, so nothing below may throw (a retry would forward twice).
  if (!address.forwardOnly && targets.length > 0) {
    const failed = await forwardAll(message, targets, address.id);
    if (failed > 0) {
      try {
        await env.DB.prepare("UPDATE messages SET forward_failed = ? WHERE id = ?")
          .bind(failed, id)
          .run();
      } catch (err) {
        log("error", "mail_forward_record_failed", { messageId: id, error: errorText(err) });
      }
    }
  }

  try {
    await env.INBOUND.send({ id });
  } catch (err) {
    // The cron step re-enqueues messages still "stored" after 15 minutes.
    log("warn", "mail_enqueue_failed", { messageId: id, error: errorText(err) });
  }
}
