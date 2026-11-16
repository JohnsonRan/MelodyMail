import { auditRow } from "../auth/store";
import type { Env } from "../env";
import { errorText, log } from "../http";
import { type Decision, evaluateRules, loadRules, type Rule } from "../rules/evaluate";

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
//    message back to the sender rather than being retried. By owner ruling (2026-11-16) an
//    address with targets then forwards instead (forwardInstead); otherwise the handler throws
//    and the sender is told. Either way nothing is forwarded twice.

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
    // address_forwards (address, target) is the primary key and target emails are unique, so
    // no target repeats.
    targets: results.flatMap((row) => (row.target ? [row.target] : [])),
  };
}

/**
 * At most this many distinct targets per message: Workers Free allows 50 subrequests per
 * invocation, and whether forward() counts as one is not documented (docs/M6-rules-api.md).
 */
export const FORWARD_MAX = 10;

/**
 * Where this message is forwarded: the address's default targets, then the targets of matching
 * rules in rule order, each once (stored targets are lowercase), cut to FORWARD_MAX. `total` is
 * the number of distinct targets before the cut.
 */
function forwardTargets(address: Address, ruleTargets: string[]) {
  const all = [...new Set([...address.targets, ...ruleTargets])];
  return { targets: all.slice(0, FORWARD_MAX), total: all.length };
}

const NO_RULES: Decision = {
  targets: [],
  read: false,
  starred: false,
  archived: false,
  trashed: false,
};

/**
 * Runs the enabled rules once for this message (Decision 1). A failed rule read or evaluation is
 * logged and the message is handled as if no rule matched: it is still stored and forwarded to the
 * defaults, never bounced because of a rule.
 */
async function decide(
  env: Env,
  message: ForwardableEmailMessage,
  recipient: Recipient,
  addressId: number,
): Promise<Decision> {
  let rules: Rule[];
  try {
    rules = await loadRules(env.DB);
  } catch (err) {
    log("error", "rules_load_failed", { addressId, error: errorText(err) });
    return NO_RULES;
  }
  if (rules.length === 0) return NO_RULES;
  try {
    return evaluateRules(rules, {
      envelopeFrom: message.from,
      headers: message.headers,
      recipient: `${recipient.localPart}@${recipient.domain}`,
      tag: recipient.tag,
    });
  } catch (err) {
    log("error", "rules_eval_failed", { addressId, error: errorText(err) });
    return NO_RULES;
  }
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

/**
 * Forwards a message that could not be stored. Returns when at least one forward went out;
 * rethrows the storage error when none did, so the sender is told. A raw object written before
 * the D1 failure is named in the audit row for the M7 orphan sweep.
 */
async function forwardInstead(
  env: Env,
  message: ForwardableEmailMessage,
  targets: string[],
  addressId: number,
  now: number,
  orphanKey: string | null,
  storageError: unknown,
): Promise<void> {
  const sent = targets.length - (await forwardAll(message, targets, addressId));
  if (sent === 0) throw storageError;
  const orphan = orphanKey ? `; orphan ${orphanKey}` : "";
  try {
    await auditRow(
      env.DB,
      "mail_forwarded_unstored",
      now,
      `address ${addressId}: ${sent}/${targets.length}${orphan}`,
    ).run();
  } catch (err) {
    // Throwing now would make a retry forward again.
    log("error", "mail_audit_failed", { addressId, error: errorText(err) });
  }
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
  const rules = await decide(env, message, recipient, address.id);
  // A message MelodyMail forwarded earlier is kept, never forwarded again, rule targets included.
  const looped = message.headers.has(FORWARDED_HEADER);
  const { targets, total } = looped
    ? { targets: [], total: 0 }
    : forwardTargets(address, rules.targets);
  if (total > targets.length) {
    try {
      await auditRow(env.DB, "mail_forward_capped", now, `address ${address.id}: ${total}`).run();
    } catch (err) {
      log("error", "mail_audit_failed", { addressId: address.id, error: errorText(err) });
    }
  }

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

  // Storage. Nothing has been forwarded yet unless every forward of a forward-only address failed.
  const id = crypto.randomUUID();
  const key = rawKey(id, now);
  let rawStored = false;
  try {
    const { readable, writable } = new FixedLengthStream(message.rawSize);
    await Promise.all([env.MAIL.put(key, readable), message.raw.pipeTo(writable)]);
    rawStored = true;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
           subaddress_tag, raw_size, r2_key, forward_failed, read, starred, archived, trashed,
           received_at)
         VALUES (?, ?, 'in', 'stored', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        address.id,
        message.from,
        message.to,
        recipient.tag,
        message.rawSize,
        key,
        forwardFailed,
        Number(rules.read),
        Number(rules.starred),
        Number(rules.archived),
        Number(rules.trashed),
        now,
      ),
      env.DB.prepare("UPDATE addresses SET last_received_at = ? WHERE id = ?").bind(
        now,
        address.id,
      ),
    ]);
  } catch (err) {
    // Owner ruling (2026-11-16): an address with targets forwards instead of throwing, so the
    // message still arrives somewhere. Nothing is stored, so no later step forwards again.
    // Without a target that could still work (none, the loop header, or a forward-only address
    // whose forwards all failed already) the error is thrown and the sender gets the bounce;
    // forwardInstead rethrows when no forward goes out.
    if (address.forwardOnly) throw err;
    log("warn", "mail_store_failed", {
      addressId: address.id,
      messageId: id,
      error: errorText(err),
    });
    await forwardInstead(env, message, targets, address.id, now, rawStored ? key : null, err);
    return;
  }

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
