import type { Env } from "../env";
import { callBot } from "../telegram/api";
import { copy } from "../telegram/card";

// Backup alerts (docs/M7-ops.md, "Failure and alerting"): at most one a day, as a plain Telegram
// message to the owner's chat when Telegram is connected. The message names no data.

/** The newest complete export older than this is stale. */
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
export const ALERT_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Claims the day's alert on the newest export row and, when Telegram is connected, sends it.
 * Returns false when an alert went out in the last 24 hours, so the caller logs nothing more.
 */
export async function alertOwner(env: Env, now: number, kind: "stale" | "failed") {
  const db = env.DB;
  const claimed = await db
    .prepare(
      `UPDATE backup_exports SET alerted_at = ?1
       WHERE id = (SELECT id FROM backup_exports ORDER BY started_at DESC LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM backup_exports WHERE alerted_at > ?2)
       RETURNING id`,
    )
    .bind(now, now - ALERT_EVERY_MS)
    .first();
  if (!claimed) return false;
  if (!env.TELEGRAM_BOT_TOKEN) return true;
  const chat = await db
    .prepare(
      "SELECT chat_id AS chatId, language FROM telegram WHERE id = 1 AND chat_id IS NOT NULL",
    )
    .first<{ chatId: number; language: string | null }>();
  if (chat) {
    const text = copy(chat.language)[kind === "stale" ? "backupStale" : "backupFailed"];
    await callBot(env, "sendMessage", { chat_id: chat.chatId, text });
  }
  return true;
}
