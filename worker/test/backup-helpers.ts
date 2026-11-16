import { env } from "cloudflare:workers";
import { runExport } from "../src/backup/export";
import { type Manifest, manifestKey } from "../src/backup/sql";
import { EXPORTED } from "../src/backup/tables";
import { seedMessage } from "./mailbox-helpers";

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** 2026-11-18 03:00 UTC, the first daily start after the seeds below. */
export const START = Date.UTC(2026, 10, 18, 3);

/** Values only the left-out tables hold; no part may contain one. */
export const PLANTED = {
  totp: "PLANTEDTOTPSECRET234567",
  recovery: "planted-recovery-hash",
  passkey: "planted-public-key",
  session: "planted-session-hash",
  challenge: "PLANTEDCHALLENGESECRET",
  pushAuth: "planted-push-auth",
  apiKey: "planted-api-key-hash",
  webhook: "planted-webhook-hash",
};

/**
 * About 512 K UTF-16 units of CJK, quotes, newlines and surrogate pairs. The 7-unit pattern puts
 * a chunk boundary inside a surrogate pair at 81,920 units.
 */
export const LONG_TEXT = "中文'草\n😀".repeat(Math.floor((512 * 1024) / 7));

/** A row in every table, exported and left out, with NULLs and integers above 2^31. */
export async function seedAll(): Promise<void> {
  const db = env.DB;
  const t = 1_700_000_000_000;
  await db.batch([
    db
      .prepare(
        "INSERT INTO domains (name, receive_enabled, send_enabled, created_at) VALUES ('example.com', 1, 0, ?)",
      )
      .bind(t),
    db
      .prepare(
        "INSERT INTO forward_targets (id, email, note, created_at) VALUES (7, 'fwd@dest.example', 'it''s a note', ?)",
      )
      .bind(t),
    db
      .prepare(
        `INSERT INTO addresses (id, local_part, domain, note, display_name, enabled, forward_only, last_received_at, created_at)
       VALUES (1, 'shop', 'example.com', '', '店铺', 1, 0, NULL, ?)`,
      )
      .bind(t),
    db.prepare("INSERT INTO address_forwards (address_id, target_id) VALUES (1, 7)"),
    db
      .prepare(
        `INSERT INTO rules (id, name, enabled, position, match, conditions, created_at, updated_at)
       VALUES (3, '规则', 1, 1, 'all', '[{"field":"subject","op":"contains","value":"发票"}]', ?, ?)`,
      )
      .bind(t, t),
    db.prepare("INSERT INTO rule_forwards (rule_id, target_id) VALUES (3, 7)"),
    db.prepare("INSERT INTO settings (id, quiet_foreground, updated_at) VALUES (1, 1, ?)").bind(t),
    db
      .prepare(
        "INSERT INTO send_quota (id, daily_used, monthly_used, seen_at) VALUES (1, 5, 50, ?)",
      )
      .bind(t),
    db
      .prepare(
        `INSERT INTO drafts (id, address_id, subject, text, idempotency_key, created_at, updated_at)
       VALUES ('short-draft', NULL, '', 'x', 'key-short-01', ?, ?),
         ('mid-draft', NULL, '', ?, 'key-mid-0001', ?, ?),
         ('long-draft', 1, '长草稿', ?, 'key-long-0001', ?, ?)`,
      )
      // Oversized rows after a short one, one of them under a page: each starts its own page.
      .bind(t, t, "b".repeat(100_000), t, t, LONG_TEXT, t, t),
    db
      .prepare(
        `INSERT INTO uploads (id, r2_key, filename, content_type, size, created_at, draft_id, message_id)
       VALUES ('up1', 'uploads/up1', '附件.pdf', 'application/pdf', 3000000000, ?, 'long-draft', NULL)`,
      )
      .bind(t),
    db
      .prepare(
        "INSERT INTO audit_log (event, created_at, detail) VALUES ('message_deleted', ?, 'line one\nline two')",
      )
      .bind(t),
    // Left out: each holds a planted value.
    db
      .prepare(
        "INSERT INTO owner (id, totp_secret, recovery_key_hash, created_at) VALUES (1, ?, ?, ?)",
      )
      .bind(PLANTED.totp, PLANTED.recovery, t),
    db
      .prepare(
        "INSERT INTO passkeys (id, public_key, counter, label, created_at) VALUES ('pk', ?, 0, 'key', ?)",
      )
      .bind(PLANTED.passkey, t),
    db
      .prepare(
        "INSERT INTO sessions (id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?)",
      )
      .bind(PLANTED.session, t, t, t),
    db
      .prepare(
        "INSERT INTO auth_challenges (id, purpose, challenge, totp_secret, expires_at) VALUES ('c', 'setup', 'ch', ?, ?)",
      )
      .bind(PLANTED.challenge, t),
    db
      .prepare(
        "INSERT INTO push_subscriptions (id, session_id, endpoint, p256dh, auth, created_at) VALUES ('ps', ?, 'https://push.invalid/1', 'p', ?, ?)",
      )
      .bind(PLANTED.session, PLANTED.pushAuth, t),
    db
      .prepare(
        "INSERT INTO api_keys (public_id, token_hash, label, scopes, created_at) VALUES ('pub', ?, 'k', '[]', ?)",
      )
      .bind(PLANTED.apiKey, t),
    db
      .prepare(
        "INSERT INTO telegram (id, bot_username, origin, webhook_secret_hash, updated_at) VALUES (1, 'bot', 'https://mail.test', ?, ?)",
      )
      .bind(PLANTED.webhook, t),
    db.prepare("INSERT INTO login_attempts (scope, created_at) VALUES ('recovery', ?)").bind(t),
    db.prepare("INSERT INTO webhook_events (svix_id, received_at) VALUES ('msg_1', ?)").bind(t),
  ]);
  for (let i = 0; i < 30; i++) {
    await seedMessage({
      id: `m${String(i).padStart(2, "0")}`,
      receivedAt: t + i,
      subject: i % 2 ? `发票 ${i}` : null,
      from: i === 0 ? null : `寄件人 ${i} <s${i}@example.org>`,
      body: `中文搜索正文 ${i} it's\nline`,
      trashed: i === 1,
    });
  }
  await db.batch([
    db
      .prepare("UPDATE messages SET raw_size = 3000000000, trashed_at = ? WHERE id = 'm01'")
      .bind(t),
    db
      .prepare(
        "INSERT INTO telegram_cards (message_id, chat_id, tg_message_id, created_at) VALUES ('m02', -1001234567890, NULL, ?)",
      )
      .bind(t),
  ]);
}

export async function latestState() {
  return env.DB.prepare("SELECT * FROM backup_exports ORDER BY started_at DESC LIMIT 1").first<
    Record<string, unknown> & { id: string; status: string }
  >();
}

/** Cron runs 15 minutes apart from `from` until the export completes; returns the run count. */
export async function exportUntilComplete(from = START, max = 40): Promise<number> {
  for (let run = 0; run < max; run++) {
    await runExport(env, from + run * 15 * MINUTE);
    if ((await latestState())?.status === "complete") return run + 1;
  }
  throw new Error("export did not complete");
}

export async function readManifest(exportId: string): Promise<Manifest | null> {
  const object = await env.MAIL.get(manifestKey(exportId));
  return object ? ((await object.json()) as Manifest) : null;
}

/** Splits SQL text into statements at `;` + newline outside string literals. */
export function statements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") quoted = !quoted;
    else if (ch === ";" && !quoted && sql[i + 1] === "\n") {
      out.push(sql.slice(start, i + 1));
      start = i + 2;
    }
  }
  return out;
}

/** Every part of an export, in manifest order. */
export async function partTexts(manifest: Manifest): Promise<string[]> {
  const texts: string[] = [];
  for (const table of manifest.tables) {
    for (const part of table.parts)
      texts.push((await (await env.MAIL.get(part.key))?.text()) ?? "");
  }
  return texts;
}

/** Loads an export into `db` (migrated), as `wrangler d1 execute --file` would. */
export async function loadExport(db: D1Database, manifest: Manifest): Promise<void> {
  const sql = (await partTexts(manifest)).flatMap(statements);
  await db.batch(["PRAGMA defer_foreign_keys = on", ...sql].map((s) => db.prepare(s)));
}

/** Every exported table's rows, ordered by key, from `db`. */
export async function exportedRows(db: D1Database) {
  const rows: Record<string, unknown[]> = {};
  for (const table of EXPORTED) {
    const { results } = await db
      .prepare(
        `SELECT ${table.columns.join(", ")} FROM ${table.name} ORDER BY ${table.key.join(", ")}`,
      )
      .all();
    rows[table.name] = results;
  }
  return rows;
}
