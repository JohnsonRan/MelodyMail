import type { Context, Hono } from "hono";
import { hashMatches, sha256Hex } from "../auth/crypto";
import { audit } from "../auth/store";
import type { AppEnv } from "../env";
import { fail, log } from "../http";
import { notifyHub } from "../mail/hub";
import { updateMessageFlags } from "../mail/routes";
import { signedWebhookRoute } from "../routing";
import { callBot } from "./api";
import { type CardMail, chatData, copy, GONE, languageOf } from "./card";

// POST /api/webhooks/telegram (docs/M5b-telegram.md, "Routes"). Public: Telegram sends the
// secret_token given to setWebhook in a header, and only its SHA-256 is stored. Every handled or
// ignored update answers 2xx so Telegram does not repeat it; only an internal failure answers
// 500. Replies (sendMessage, answerWidgetQuery) ride in the response body.

/** The updates M5b uses are under 2 KB; anything over this is ignored. */
export const UPDATE_MAX = 64 * 1024;
/** The edit runs before the answer, which must reach Telegram within 15 seconds. */
const EDIT_TIMEOUT_MS = 5_000;

type User = { id?: unknown; username?: unknown; first_name?: unknown; language_code?: unknown };
type Chat = { id?: unknown; type?: unknown };
type Update = {
  message?: { text?: unknown; chat?: Chat; from?: User };
  widget_query?: { id?: unknown; from?: User; chat?: Chat; message_id?: unknown; data?: unknown };
};

type Config = { chatId: number | null; origin: string; secretHash: string };

const ACTIONS = { read: "read", arch: "archived", star: "starred" } as const;
const ACTION_DATA = /^(read|arch|star):([01])$/;

function ignored(c: Context<AppEnv>, reason: string) {
  log("info", "telegram_update_ignored", { reason });
  return c.body(null, 200);
}

export function registerTelegramWebhook(app: Hono<AppEnv>): void {
  signedWebhookRoute(app, "/webhooks/telegram", async (c) => {
    const config = c.env.TELEGRAM_BOT_TOKEN
      ? await c.env.DB.prepare(
          `SELECT chat_id AS chatId, origin, webhook_secret_hash AS secretHash
           FROM telegram WHERE id = 1`,
        ).first<Config>()
      : null;
    if (!config) return fail(c, 404, "not_found");
    const token = c.req.header("x-telegram-bot-api-secret-token") ?? "";
    if (!(await hashMatches(token, config.secretHash))) return fail(c, 401, "unauthorized");
    if (Number(c.req.header("content-length")) > UPDATE_MAX) {
      return ignored(c, "telegram_update_too_large");
    }
    const body = await c.req.arrayBuffer();
    if (body.byteLength > UPDATE_MAX) return ignored(c, "telegram_update_too_large");
    let update: Update;
    try {
      update = JSON.parse(new TextDecoder().decode(body)) as Update;
    } catch {
      return ignored(c, "telegram_update_invalid");
    }
    if (update?.message) return bind(c, update.message);
    if (update?.widget_query) return act(c, config, update.widget_query);
    return c.body(null, 200);
  });
}

/** `/start <code>` from the owner's private chat binds it; any other `/start` gets one reply. */
async function bind(c: Context<AppEnv>, message: NonNullable<Update["message"]>) {
  const text = typeof message.text === "string" ? message.text : "";
  const chatId = message.chat?.id;
  const from = message.from ?? {};
  if (!/^\/start(\s|$)/.test(text) || typeof chatId !== "number") return c.body(null, 200);
  const language = languageOf(from.language_code);
  const code = text.slice("/start".length).trim();
  const now = Date.now();
  const label =
    typeof from.username === "string" && from.username
      ? `@${from.username}`
      : typeof from.first_name === "string"
        ? from.first_name
        : "";
  let bound = false;
  if (message.chat?.type === "private" && from.id === chatId && code) {
    const hash = await sha256Hex(code);
    const db = c.env.DB;
    const pending = "id = 1 AND link_code_hash = ? AND link_expires_at > ?";
    // One transaction: the old chat's cards go only if this update wins the code, and of two
    // updates with the same code one binds.
    const [, claimed] = await db.batch([
      db
        .prepare(
          `DELETE FROM telegram_cards WHERE EXISTS (SELECT 1 FROM telegram WHERE ${pending})`,
        )
        .bind(hash, now),
      db
        .prepare(
          `UPDATE telegram SET chat_id = ?, chat_label = ?, language = ?, bound_at = ?,
             link_code_hash = NULL, link_expires_at = NULL, last_error = NULL,
             last_error_at = NULL, updated_at = ?
           WHERE ${pending} RETURNING id`,
        )
        .bind(chatId, Array.from(label).slice(0, 64).join(""), language, now, now, hash, now),
    ]);
    bound = (claimed?.results.length ?? 0) > 0;
    if (bound) await audit(c, "telegram_connected", now).run();
  }
  log("info", "telegram_start", { bound });
  const words = copy(language);
  return c.json({
    method: "sendMessage",
    chat_id: chatId,
    text: bound ? words.connected : words.invalidCode,
  });
}

/** A card button: sets one flag on the card's own message and answers with all three. */
async function act(c: Context<AppEnv>, config: Config, query: NonNullable<Update["widget_query"]>) {
  const answer = (data: Record<string, number | string>) =>
    c.json({
      method: "answerWidgetQuery",
      widget_query_id: String(query.id ?? ""),
      data: JSON.stringify(data),
    });
  const chatId = query.chat?.id;
  if (
    query.chat?.type !== "private" ||
    chatId !== config.chatId ||
    query.from?.id !== config.chatId
  ) {
    return answer({ e: "unbound" });
  }
  const match = ACTION_DATA.exec(typeof query.data === "string" ? query.data : "");
  const tgMessageId = query.message_id;
  if (!match || typeof tgMessageId !== "number") return answer({ e: "bad" });
  const db = c.env.DB;
  const card = await db
    .prepare("SELECT message_id AS id FROM telegram_cards WHERE chat_id = ? AND tg_message_id = ?")
    .bind(chatId, tgMessageId)
    .first<{ id: string }>();
  const flag = ACTIONS[match[1] as keyof typeof ACTIONS];
  const changed = card
    ? (await updateMessageFlags(c.env, [card.id], { [flag]: match[2] === "1" })).meta.changes
    : 0;
  const mail =
    card && changed > 0
      ? await db
          .prepare(
            `SELECT subject, from_hdr AS fromHdr, envelope_from AS envelopeFrom,
               envelope_to AS envelopeTo, read, archived, starred FROM messages WHERE id = ?`,
          )
          .bind(card.id)
          .first<CardMail>()
      : null;
  const edit = (data: string) =>
    callBot(
      c.env,
      "editMessageWidgetData",
      { chat_id: chatId, message_id: tgMessageId, chat_data: data },
      { timeoutMs: EDIT_TIMEOUT_MS, messageId: card?.id },
    );
  if (!card || !mail) {
    await edit(GONE);
    return answer({ e: "gone" });
  }
  // A failed edit is logged by callBot; the answer still carries the true flags.
  await edit(chatData(mail, config.origin, card.id));
  await notifyHub(c.env, { type: "changed", id: card.id });
  log("info", "telegram_action", { messageId: card.id, action: match[1] });
  return answer({ r: mail.read ? 1 : 0, a: mail.archived ? 1 : 0, st: mail.starred ? 1 : 0 });
}
