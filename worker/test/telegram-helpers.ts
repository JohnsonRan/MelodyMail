import { env, exports } from "cloudflare:workers";
import { vi } from "vitest";
import { sha256Hex } from "../src/auth/crypto";
import { type Client, ORIGIN } from "./helpers";
import { signedIn } from "./send-helpers";

// Shared set-up for the Telegram suites (docs/M5b-telegram.md, "Proof"). The Bot API is never
// reached: `stubTelegram` answers every request to TELEGRAM_API_URL (an .invalid host) and records
// it; any other outbound request still fails.

export const SECRET = "test_webhook_secret-0123456789abcdefghijklmn";
export const CHAT = 111_111_111;

export type BotCall = { method: string; url: string; body: Record<string, unknown> };

export const ok = (result: unknown = true) => Response.json({ ok: true, result });
export const botError = (status: number, description: string) =>
  Response.json(
    { ok: false, error_code: status, description: `${description} UPSTREAM-TEXT` },
    { status },
  );

/** Answers Bot API calls with `answer(method, n)` and records each one. */
export function stubTelegram(
  answer: (method: string, n: number) => Response = (method) =>
    method === "getMe" ? ok({ id: 1, is_bot: true, username: "melody_test_bot" }) : ok(),
) {
  const calls: BotCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (!req.url.startsWith(env.TELEGRAM_API_URL))
      throw new Error("outbound fetch is off in tests");
    const method = req.url.split("/").pop() ?? "";
    calls.push({ method, url: req.url, body: (await req.json()) as Record<string, unknown> });
    return answer(method, calls.length - 1);
  });
  return calls;
}

/** A signed-in client whose session has a fresh Passkey assertion (requireFreshAuth passes). */
export async function freshClient(): Promise<Client> {
  const client = await signedIn();
  await env.DB.prepare("UPDATE sessions SET reauth_at = ?").bind(Date.now()).run();
  return client;
}

/** A Connect that already ran: webhook secret stored, optionally a chat bound or a code pending. */
export async function seedTelegram(
  options: { chatId?: number | null; code?: string; expiresAt?: number; language?: string } = {},
) {
  await env.DB.prepare(
    `INSERT INTO telegram (id, bot_username, origin, webhook_secret_hash, link_code_hash,
       link_expires_at, chat_id, chat_label, language, bound_at, updated_at)
     VALUES (1, 'melody_test_bot', ?, ?, ?, ?, ?, '@owner', ?, ?, ?)`,
  )
    .bind(
      ORIGIN,
      await sha256Hex(SECRET),
      options.code ? await sha256Hex(options.code) : null,
      options.code ? (options.expiresAt ?? Date.now() + 600_000) : null,
      options.chatId === undefined ? CHAT : options.chatId,
      options.language ?? "en",
      Date.now(),
      Date.now(),
    )
    .run();
}

/** A request from Telegram to the webhook. */
export function webhook(update: unknown, secret: string | null = SECRET) {
  return exports.default.fetch(`${ORIGIN}/api/webhooks/telegram`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === null ? {} : { "x-telegram-bot-api-secret-token": secret }),
    },
    body: typeof update === "string" ? update : JSON.stringify(update),
  });
}

/** A private-chat message from the owner's account. */
export const message = (text: string, chat: Record<string, unknown> = {}, from = {}) => ({
  update_id: 1,
  message: {
    message_id: 1,
    text,
    chat: { id: CHAT, type: "private", ...chat },
    from: { id: CHAT, is_bot: false, first_name: "Owner", username: "owner", ...from },
  },
});

/** A tap on a card button. */
export const query = (
  data: string,
  messageId = 42,
  chat: Record<string, unknown> = {},
  from = {},
) => ({
  update_id: 2,
  widget_query: {
    id: "q-1",
    from: { id: CHAT, is_bot: false, first_name: "Owner", ...from },
    chat: { id: CHAT, type: "private", ...chat },
    message_id: messageId,
    chat_instance: "1",
    type: { type: "data" },
    data,
  },
});

export async function cardFor(messageId: string, tgMessageId = 42, chatId = CHAT) {
  await env.DB.prepare(
    "INSERT INTO telegram_cards (message_id, chat_id, tg_message_id, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(messageId, chatId, tgMessageId, Date.now())
    .run();
}

export function telegramRow() {
  return env.DB.prepare(
    `SELECT chat_id AS chatId, chat_label AS chatLabel, language, link_code_hash AS codeHash,
       last_error AS lastError FROM telegram WHERE id = 1`,
  ).first<Record<string, unknown>>();
}

export async function cardRows() {
  const { results } = await env.DB.prepare(
    "SELECT message_id AS messageId, chat_id AS chatId, tg_message_id AS tgMessageId FROM telegram_cards",
  ).all();
  return results;
}

/** Runs the Hub's new-mail notification as the queue consumer does after a parse. */
export function notifyNewMail(id: string) {
  return env.HUB.getByName("hub").notify({ type: "message", id });
}

/** A request from the owner's browser on another origin (an http: dev server, another port). */
export function requestAt(client: Client, origin: string, method: string, path: string) {
  return exports.default.fetch(`${origin}${path}`, {
    method,
    headers: {
      origin,
      cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      "content-type": "application/json",
    },
    body: method === "GET" ? undefined : "{}",
  });
}
