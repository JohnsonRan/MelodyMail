import type { Env } from "../env";
import { errorText, log } from "../http";
import { removeOldWebhookEvents, removeStaleUploads } from "../send/cleanup";
import { notifyHub } from "./hub";
import { type ParsedHeaders, parseSlice, SLICE_BYTES, threadKey } from "./parse";

// The inbound queue consumer and the cron step that feeds it again. Each job is { id } of a
// messages row; a job for a row that is not "stored" is a duplicate and is dropped.

export const RETRY_DELAY_SECONDS = 60;
export const STUCK_AFTER_MS = 15 * 60 * 1000;
export const REQUEUE_MAX = 100;
/** Parse tries per message (owner ruling 2026-11-16); then it becomes parse_failed. */
export const MAX_ATTEMPTS = 5;

type Row = {
  r2_key: string;
  envelope_from: string;
  attempts: number;
  read: number;
  archived: number;
  trashed: number;
};

/** Marks the row parse_failed; the browser still parses the raw message (M4). */
function markFailed(env: Env, id: string) {
  return env.DB.prepare(
    "UPDATE messages SET status = 'parse_failed' WHERE id = ? AND status = 'stored'",
  )
    .bind(id)
    .run();
}

function saveParsed(env: Env, id: string, row: Row, p: ParsedHeaders) {
  // The FTS row is written only while the message is still "stored", and before the UPDATE
  // that ends that, so a duplicate delivery adds no second FTS row.
  return env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages_fts (message_id, subject, sender, body)
       SELECT id, ?, ?, ? FROM messages WHERE id = ? AND status = 'stored'`,
    ).bind(p.subject ?? "", p.from ?? row.envelope_from, p.text, id),
    env.DB.prepare(
      `UPDATE messages SET status = 'parsed', message_id_hdr = ?, in_reply_to = ?,
         references_hdr = ?, thread_key = ?, subject = ?, from_hdr = ?, to_hdr = ?, cc_hdr = ?,
         date_hdr = ?, snippet = ?, has_attachments = ?
       WHERE id = ? AND status = 'stored'`,
    ).bind(
      p.messageId,
      p.inReplyTo,
      p.references,
      threadKey(p, id),
      p.subject,
      p.from,
      p.to,
      p.cc,
      p.date,
      p.snippet,
      p.hasAttachments ? 1 : 0,
      id,
    ),
  ]);
}

async function processJob(env: Env, id: string): Promise<void> {
  // Counted before the parse, in its own write, so a try that the CPU limit kills still counts.
  const row = await env.DB.prepare(
    `UPDATE messages SET attempts = attempts + 1 WHERE id = ? AND status = 'stored'
     RETURNING r2_key, envelope_from, attempts, read, archived, trashed`,
  )
    .bind(id)
    .first<Row>();
  if (!row) return;
  await parseRow(env, id, row);
  // Open mailbox pages refetch; a failed notify is logged and never fails the parse. Mail that a
  // rule marked read, archived or moved to Trash refreshes pages but sends no Web Push and no
  // Telegram card (docs/M6-rules-api.md, owner ruling 1); a starred message still notifies.
  const filtered = row.read === 1 || row.archived === 1 || row.trashed === 1;
  await notifyHub(env, { type: filtered ? "changed" : "message", id });
}

async function parseRow(env: Env, id: string, row: Row): Promise<void> {
  if (row.attempts > MAX_ATTEMPTS) {
    log("warn", "mail_parse_gave_up", { messageId: id, attempts: row.attempts });
    await markFailed(env, id);
    return;
  }
  const object = await env.MAIL.get(row.r2_key, { range: { offset: 0, length: SLICE_BYTES } });
  if (!object) {
    log("warn", "mail_raw_missing", { messageId: id });
    await markFailed(env, id);
    return;
  }
  const slice = new Uint8Array(await object.arrayBuffer());
  let parsed: ParsedHeaders;
  try {
    parsed = await parseSlice(slice);
  } catch (err) {
    log("warn", "mail_parse_failed", { messageId: id, error: errorText(err) });
    await markFailed(env, id);
    return;
  }
  await saveParsed(env, id, row, parsed);
}

/** Ends a message that has used its last try; true when it did. */
async function giveUp(env: Env, id: string): Promise<boolean> {
  const { meta } = await env.DB.prepare(
    "UPDATE messages SET status = 'parse_failed' WHERE id = ? AND status = 'stored' AND attempts >= ?",
  )
    .bind(id, MAX_ATTEMPTS)
    .run();
  return meta.changes > 0;
}

export async function handleQueue(batch: MessageBatch<InboundJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processJob(env, message.body.id);
      message.ack();
    } catch (err) {
      // D1 or R2 unavailable: try again later, unless this was the last try.
      log("warn", "mail_parse_retry", { messageId: message.body.id, error: errorText(err) });
      if (await giveUp(env, message.body.id).catch(() => false)) message.ack();
      else message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }
}

/**
 * Re-enqueues messages still "stored" after STUCK_AFTER_MS, at most REQUEUE_MAX per run. A
 * message that used all its tries (the last one killed before it could give up) becomes
 * parse_failed here instead.
 */
export async function requeueStored(env: Env, now: number): Promise<number> {
  const cutoff = now - STUCK_AFTER_MS;
  const [, stuck] = await env.DB.batch<{ id: string }>([
    env.DB.prepare(
      "UPDATE messages SET status = 'parse_failed' WHERE status = 'stored' AND received_at <= ? AND attempts >= ?",
    ).bind(cutoff, MAX_ATTEMPTS),
    env.DB.prepare(
      "SELECT id FROM messages WHERE status = 'stored' AND received_at <= ? ORDER BY received_at LIMIT ?",
    ).bind(cutoff, REQUEUE_MAX),
  ]);
  const results = stuck?.results ?? [];
  if (results.length > 0) {
    await env.INBOUND.sendBatch(results.map((r) => ({ body: { id: r.id } })));
    log("info", "mail_requeued", { count: results.length });
  }
  return results.length;
}

/**
 * The one cron trigger. Each job is contained (worker/AGENTS.md, Background work): a failing
 * job is logged with its name and the others still run; the invocation then fails, so the
 * failure shows in the Cron Events log. M7 adds the R2 orphan sweep and trash clean-up here.
 */
export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  const jobs: [string, () => Promise<unknown>][] = [
    ["requeue_stored", () => requeueStored(env, controller.scheduledTime)],
    ["remove_stale_uploads", () => removeStaleUploads(env, controller.scheduledTime)],
    ["remove_old_webhook_events", () => removeOldWebhookEvents(env, controller.scheduledTime)],
  ];
  let failed = 0;
  for (const [job, run] of jobs) {
    try {
      await run();
    } catch (err) {
      failed++;
      log("error", "cron_job_failed", { job, error: errorText(err) });
    }
  }
  if (failed > 0) throw new Error(`${failed} cron job(s) failed`);
}
