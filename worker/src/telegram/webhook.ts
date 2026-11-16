import type { Context, Hono } from "hono";
import { hashMatches, sha256Hex } from "../auth/crypto";
import { audit } from "../auth/store";
import type { AppEnv } from "../env";
import { fail, log } from "../http";
import { signedWebhookRoute } from "../routing";
import {
  act,
  type CallbackQuery,
  type Chat,
  type Config,
  tapButton,
  type User,
  type WidgetQuery,
} from "./actions";
import { copy, languageOf } from "./card";

// POST /api/webhooks/telegram (docs/M5b-telegram.md, "Routes"). Public: Telegram sends the
// secret_token given to setWebhook in a header, and only its SHA-256 is stored. Every handled or
// ignored update answers 2xx so Telegram does not repeat it; only an internal failure answers
// 500. Replies (sendMessage, answerWidgetQuery, answerCallbackQuery) ride in the response body.

/** The updates M5b uses are under 2 KB; anything over this is ignored. */
export const UPDATE_MAX = 64 * 1024;

type Update = {
  message?: { text?: unknown; chat?: Chat; from?: User };
  widget_query?: WidgetQuery;
  callback_query?: CallbackQuery;
};

function ignored(c: Context<AppEnv>, reason: string) {
  log("info", "telegram_update_ignored", { reason });
  return c.body(null, 200);
}

export function registerTelegramWebhook(app: Hono<AppEnv>): void {
  signedWebhookRoute(app, "/webhooks/telegram", async (c) => {
    const config = c.env.TELEGRAM_BOT_TOKEN
      ? await c.env.DB.prepare(
          `SELECT chat_id AS chatId, origin, language, webhook_secret_hash AS secretHash
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
    if (update?.callback_query) return tapButton(c, config, update.callback_query);
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
