import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { randomBytes, sha256Hex } from "../auth/crypto";
import { requireFreshAuth } from "../auth/session";
import { audit } from "../auth/store";
import type { AppEnv } from "../env";
import { fail } from "../http";
import { callBot } from "./api";
import { caption, copy, testChatData } from "./card";
import { type Binding, recordOutcome, sendCard } from "./send";

// Settings > Notifications > Telegram (docs/M5b-telegram.md, "Routes"). None is public. Connect
// registers the webhook on the origin of the owner's own request and hands out a single-use code
// for the deep link; only the code's and the webhook secret's SHA-256 are stored.

export const LINK_TTL_MS = 10 * 60_000;
/** Telegram's webhook ports; 443 is the https default, so it shows as no port. */
const WEBHOOK_PORTS = new Set(["", "88", "8443"]);
/** Keeps a card's link (origin + "/?m=" + a 36-character id) inside openLink's 256 characters. */
const ORIGIN_MAX = 160;
export const ALLOWED_UPDATES = ["message", "widget_query"];

/** The request's origin when Telegram can deliver a webhook to it, else null. */
export function webhookOrigin(c: Context<AppEnv>): string | null {
  const url = new URL(c.req.url);
  if (url.protocol !== "https:" || !WEBHOOK_PORTS.has(url.port)) return null;
  return url.origin.length <= ORIGIN_MAX ? url.origin : null;
}

type Row = {
  linkExpiresAt: number | null;
  chatId: number | null;
  chatLabel: string | null;
  boundAt: number | null;
  lastError: string | null;
  origin: string;
  language: string | null;
};

function readRow(c: Context<AppEnv>) {
  return c.env.DB.prepare(
    `SELECT link_expires_at AS linkExpiresAt, chat_id AS chatId, chat_label AS chatLabel,
       bound_at AS boundAt, last_error AS lastError, origin, language FROM telegram WHERE id = 1`,
  ).first<Row>();
}

const configured: MiddlewareHandler<AppEnv> = async (c, next) =>
  c.env.TELEGRAM_BOT_TOKEN ? next() : fail(c, 404, "telegram_not_configured");

/** Abuse guard on Connect and the test card, per session (see wrangler.jsonc). */
const limited: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { success } = await c.env.TELEGRAM_LIMITER.limit({ key: c.get("sessionId") });
  return success ? next() : fail(c, 429, "rate_limited");
};

export function registerTelegramRoutes(tg: Hono<AppEnv>): void {
  tg.get("/", async (c) => {
    if (!c.env.TELEGRAM_BOT_TOKEN) return c.json({ state: "notConfigured" });
    const row = await readRow(c);
    if (row?.chatId != null) {
      return c.json({
        state: "on",
        chatLabel: row.chatLabel,
        boundAt: row.boundAt,
        lastError: row.lastError,
      });
    }
    if (!webhookOrigin(c)) return c.json({ state: "httpsRequired" });
    // The code itself is not stored; the panel keeps the one Connect returned.
    if (row?.linkExpiresAt && row.linkExpiresAt > Date.now()) {
      return c.json({ state: "pending", expiresAt: row.linkExpiresAt });
    }
    return c.json({ state: "off" });
  });

  tg.post("/link", configured, requireFreshAuth, limited, async (c) => {
    const origin = webhookOrigin(c);
    if (!origin) return fail(c, 409, "telegram_needs_https");
    const me = await callBot<{ username?: string }>(c.env, "getMe", {});
    if (!me.ok || !me.result.username) return fail(c, 502, "telegram_failed");
    const secret = isoBase64URL.fromBuffer(randomBytes(32));
    const hook = await callBot(c.env, "setWebhook", {
      url: `${origin}/api/webhooks/telegram`,
      secret_token: secret,
      allowed_updates: ALLOWED_UPDATES,
      drop_pending_updates: true,
    });
    if (!hook.ok) return fail(c, 502, "telegram_failed");
    const code = isoBase64URL.fromBuffer(randomBytes(16));
    const now = Date.now();
    const expiresAt = now + LINK_TTL_MS;
    const db = c.env.DB;
    await db.batch([
      db
        .prepare(
          `INSERT INTO telegram (id, bot_username, origin, webhook_secret_hash, link_code_hash,
             link_expires_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET bot_username = excluded.bot_username,
             origin = excluded.origin, webhook_secret_hash = excluded.webhook_secret_hash,
             link_code_hash = excluded.link_code_hash, link_expires_at = excluded.link_expires_at,
             updated_at = excluded.updated_at`,
        )
        .bind(
          me.result.username,
          origin,
          await sha256Hex(secret),
          await sha256Hex(code),
          expiresAt,
          now,
        ),
      audit(c, "telegram_link_created", now),
    ]);
    return c.json({ url: `https://t.me/${me.result.username}?start=${code}`, code, expiresAt });
  });

  tg.delete("/link", async (c) => {
    await c.env.DB.prepare(
      "UPDATE telegram SET link_code_hash = NULL, link_expires_at = NULL, updated_at = ? WHERE id = 1",
    )
      .bind(Date.now())
      .run();
    return c.json({ ok: true });
  });

  // With the row gone the webhook answers 404, so even a failed deleteWebhook leaves no public
  // route that acts on anything.
  tg.delete("/", async (c) => {
    if (c.env.TELEGRAM_BOT_TOKEN) {
      await callBot(c.env, "deleteWebhook", { drop_pending_updates: true });
    }
    const db = c.env.DB;
    await db.batch([
      db.prepare("DELETE FROM telegram_cards"),
      db.prepare("DELETE FROM telegram"),
      audit(c, "telegram_disconnected", Date.now()),
    ]);
    return c.json({ ok: true });
  });

  tg.post("/test", configured, limited, async (c) => {
    const row = await readRow(c);
    if (row?.chatId == null) return fail(c, 409, "telegram_not_connected");
    const binding: Binding = { chatId: row.chatId, origin: row.origin, language: row.language };
    const outcome = await sendCard(c.env, binding, {
      chatData: testChatData(row.origin, row.language),
      caption: caption("MelodyMail", copy(row.language).testSubject, row.language),
      url: `${row.origin}/`,
    });
    await recordOutcome(c.env, outcome.ok ? null : outcome.error).run();
    return outcome.ok ? c.json({ ok: true }) : fail(c, 502, "telegram_failed");
  });
}
