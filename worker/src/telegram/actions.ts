import type { Context } from "hono";
import type { AppEnv } from "../env";
import { log } from "../http";
import { notifyHub } from "../mail/hub";
import { updateMessageFlags } from "../mail/routes";
import { callBot } from "./api";
import { type Action, type CardMail, chatData, copy, GONE, keyboard, messageLink } from "./card";

// Card buttons (docs/M5b-telegram.md, "Actions from widget_query", and its addendum, "Actions
// from callback_query"). Both kinds pass the same checks and change the flag the same way; they
// differ only in how the card is redrawn and how the answer looks.

/** The edit runs before the answer, which must reach Telegram within 15 seconds. */
const EDIT_TIMEOUT_MS = 5_000;

export type User = {
  id?: unknown;
  username?: unknown;
  first_name?: unknown;
  language_code?: unknown;
};
export type Chat = { id?: unknown; type?: unknown };
export type WidgetQuery = {
  id?: unknown;
  from?: User;
  chat?: Chat;
  message_id?: unknown;
  data?: unknown;
};
export type CallbackQuery = {
  id?: unknown;
  from?: User;
  message?: { message_id?: unknown; chat?: Chat };
  data?: unknown;
};
export type Config = {
  chatId: number | null;
  origin: string;
  language: string | null;
  secretHash: string;
};

const ACTIONS: Record<Action, "read" | "archived" | "starred"> = {
  read: "read",
  arch: "archived",
  star: "starred",
};
const ACTION_DATA = /^(read|arch|star):([01])$/;

type Tap = { chat?: Chat; from?: User; messageId?: unknown; data?: unknown };
type Tapped =
  | { e: "unbound" }
  | { e: "bad" }
  | { e: "gone"; chatId: unknown; tgMessageId: number }
  | { e: null; chatId: unknown; tgMessageId: number; id: string; action: Action; mail: CardMail };

/**
 * What both kinds of card button share: the sender checks, then one flag on the card's own
 * message. The message comes from the card row found by (chat id, Telegram message id), never
 * from the data.
 */
async function perform(env: AppEnv["Bindings"], config: Config, tap: Tap): Promise<Tapped> {
  const chatId = tap.chat?.id;
  if (tap.chat?.type !== "private" || chatId !== config.chatId || tap.from?.id !== config.chatId) {
    return { e: "unbound" };
  }
  const match = ACTION_DATA.exec(typeof tap.data === "string" ? tap.data : "");
  const tgMessageId = tap.messageId;
  if (!match || typeof tgMessageId !== "number") return { e: "bad" };
  const db = env.DB;
  const card = await db
    .prepare("SELECT message_id AS id FROM telegram_cards WHERE chat_id = ? AND tg_message_id = ?")
    .bind(chatId, tgMessageId)
    .first<{ id: string }>();
  const action = match[1] as Action;
  const changed = card
    ? (await updateMessageFlags(env, [card.id], { [ACTIONS[action]]: match[2] === "1" })).meta
        .changes
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
  if (!card || !mail) return { e: "gone", chatId, tgMessageId };
  return { e: null, chatId, tgMessageId, id: card.id, action, mail };
}

/** A widget button: answers with all three flags; the widget redraws from the answer. */
export async function act(c: Context<AppEnv>, config: Config, query: WidgetQuery) {
  const answer = (data: Record<string, number | string>) =>
    c.json({
      method: "answerWidgetQuery",
      widget_query_id: String(query.id ?? ""),
      data: JSON.stringify(data),
    });
  const done = await perform(c.env, config, {
    chat: query.chat,
    from: query.from,
    messageId: query.message_id,
    data: query.data,
  });
  if (done.e === "unbound" || done.e === "bad") return answer({ e: done.e });
  const edit = (data: string) =>
    callBot(
      c.env,
      "editMessageWidgetData",
      { chat_id: done.chatId, message_id: done.tgMessageId, chat_data: data },
      { timeoutMs: EDIT_TIMEOUT_MS, messageId: done.e === "gone" ? undefined : done.id },
    );
  if (done.e === "gone") {
    await edit(GONE);
    return answer({ e: "gone" });
  }
  const { mail } = done;
  // A failed edit is logged by callBot; the answer still carries the true flags.
  await edit(chatData(mail, config.origin, done.id));
  await notifyHub(c.env, { type: "changed", id: done.id });
  log("info", "telegram_action", { messageId: done.id, action: done.action });
  return answer({ r: mail.read ? 1 : 0, a: mail.archived ? 1 : 0, st: mail.starred ? 1 : 0 });
}

/**
 * A button on the plain message (owner ruling 7): the same checks, a short notice in the answer,
 * and the keyboard redrawn with the new labels. A missing card gets the notice only: no edit, so
 * a card whose send result was lost is not marked deleted.
 */
export async function tapButton(c: Context<AppEnv>, config: Config, query: CallbackQuery) {
  const words = copy(config.language);
  const answer = (text: string) =>
    c.json({ method: "answerCallbackQuery", callback_query_id: String(query.id ?? ""), text });
  // A query from an inline message has no `message`, so it fails the chat checks.
  const done = await perform(c.env, config, {
    chat: query.message?.chat,
    from: query.from,
    messageId: query.message?.message_id,
    data: query.data,
  });
  if (done.e === "unbound") return answer(words.unbound);
  if (done.e === "bad") return answer(words.failed);
  if (done.e === "gone") return answer(words.gone);
  const { mail } = done;
  // A failed edit is logged by callBot; `message is not modified` counts as done.
  await callBot(
    c.env,
    "editMessageReplyMarkup",
    {
      chat_id: done.chatId,
      message_id: done.tgMessageId,
      reply_markup: keyboard(config.language, messageLink(config.origin, done.id), mail),
    },
    { timeoutMs: EDIT_TIMEOUT_MS, messageId: done.id },
  );
  await notifyHub(c.env, { type: "changed", id: done.id });
  log("info", "telegram_action", { messageId: done.id, action: done.action });
  return answer(words.done[done.action][mail[ACTIONS[done.action]] ? 1 : 0]);
}
