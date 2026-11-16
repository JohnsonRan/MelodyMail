import type { Env } from "../env";
import { senderLabel } from "../push/send";
import { type CallResult, callBot, type Failure } from "./api";
import { type CardMail, caption, chatData, keyboard, messageLink } from "./card";
import html from "./card.html";

// Sending cards (docs/M5b-telegram.md, "Sending"). The Hub calls telegramNewMail for every new
// message, next to Web Push. No retry and no sleep: a retry after a timeout could post the card
// twice. A failure records a short code for the panel and is never thrown.

export type Binding = { chatId: number; origin: string; language: string | null };

/** The code the panel shows for a failed send. */
type LastError = "blocked" | "rate_limited" | "failed";

const lastErrorOf = (kind: Failure): LastError =>
  kind === "blocked" || kind === "rate_limited" ? kind : "failed";

/** `mail` gives the plain message its action buttons; the test card has none. */
type Card = { chatData: string; caption: string; url: string; mail?: CardMail };

/**
 * Sends one card. When Telegram refuses the widget (400), the caption goes out as a plain message
 * with an inline keyboard instead (owner rulings 6 and 7). Returns the Telegram message id of
 * either, or the failure.
 */
export async function sendCard(
  env: Env,
  binding: Binding,
  card: Card,
  messageId?: string,
): Promise<{ ok: true; tgMessageId: number } | { ok: false; error: LastError }> {
  const sent: CallResult<{ message_id: number }> = await callBot(
    env,
    "sendWidget",
    {
      chat_id: binding.chatId,
      html,
      chat_data: card.chatData,
      caption: card.caption,
      allow_queries: true,
      protect_content: true,
    },
    { messageId },
  );
  if (sent.ok) return { ok: true, tgMessageId: sent.result.message_id };
  if (sent.status !== 400) return { ok: false, error: lastErrorOf(sent.kind) };
  const plain: CallResult<{ message_id: number }> = await callBot(
    env,
    "sendMessage",
    {
      chat_id: binding.chatId,
      text: card.caption,
      protect_content: true,
      reply_markup: keyboard(binding.language, card.url, card.mail),
    },
    { messageId },
  );
  return plain.ok
    ? { ok: true, tgMessageId: plain.result.message_id }
    : { ok: false, error: lastErrorOf(plain.kind) };
}

/** Records the outcome of a send for the panel: a failure's code, or cleared on success. */
export function recordOutcome(env: Env, error: LastError | null) {
  return env.DB.prepare("UPDATE telegram SET last_error = ?, last_error_at = ? WHERE id = 1").bind(
    error,
    error ? Date.now() : null,
  );
}

/** The card for a new message, at most once per message. Never throws for a Telegram failure. */
export async function telegramNewMail(env: Env, id: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const db = env.DB;
  const [bound, mail] = await db.batch([
    db.prepare(
      `SELECT chat_id AS chatId, origin, language FROM telegram
       WHERE id = 1 AND chat_id IS NOT NULL`,
    ),
    db
      .prepare(
        `SELECT subject, from_hdr AS fromHdr, envelope_from AS envelopeFrom,
           envelope_to AS envelopeTo, read, archived, starred FROM messages WHERE id = ?`,
      )
      .bind(id),
  ]);
  const binding = bound?.results[0] as Binding | undefined;
  const row = mail?.results[0] as CardMail | undefined;
  if (!binding || !row) return;
  const claimed = await db
    .prepare(
      `INSERT INTO telegram_cards (message_id, chat_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING message_id`,
    )
    .bind(id, binding.chatId, Date.now())
    .first();
  if (!claimed) return;
  const outcome = await sendCard(
    env,
    binding,
    {
      chatData: chatData(row, binding.origin, id),
      caption: caption(senderLabel(row.fromHdr, row.envelopeFrom), row.subject, binding.language),
      url: messageLink(binding.origin, id),
      mail: row,
    },
    id,
  );
  if (!outcome.ok) {
    await recordOutcome(env, outcome.error).run();
    return;
  }
  await db.batch([
    db
      .prepare("UPDATE telegram_cards SET tg_message_id = ? WHERE message_id = ?")
      .bind(outcome.tgMessageId, id),
    recordOutcome(env, null),
  ]);
}
