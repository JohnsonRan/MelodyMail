import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/crypto";
import { ORIGIN } from "./helpers";
import { fetchWith, seedMessage } from "./mailbox-helpers";
import { signedIn } from "./send-helpers";
import {
  botError,
  CHAT,
  cardFor,
  cardRows,
  freshClient,
  ok,
  requestAt,
  seedTelegram,
  stubTelegram,
  telegramRow,
  webhook,
} from "./telegram-helpers";

// Settings > Notifications > Telegram routes (docs/M5b-telegram.md, "Routes"), with the Bot API
// stubbed (telegram-helpers.ts).

describe("telegram status and connect", () => {
  it("reports not set up without a token, and off, pending and on with one", async () => {
    const client = await signedIn();
    const req = new Request(`${ORIGIN}/api/telegram`, {
      headers: { cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    const bare = await fetchWith(req.clone(), { TELEGRAM_BOT_TOKEN: undefined });
    expect(await bare.json()).toEqual({ state: "notConfigured" });
    expect(await client.json("GET", "/api/telegram")).toEqual({ state: "off" });
    const http = await requestAt(client, "http://mail.test", "GET", "/api/telegram");
    expect(await http.json()).toEqual({ state: "httpsRequired" });
    const expiresAt = Date.now() + 60_000;
    await seedTelegram({ chatId: null, code: "abc", expiresAt });
    expect(await client.json("GET", "/api/telegram")).toEqual({ state: "pending", expiresAt });
    await env.DB.prepare("UPDATE telegram SET link_expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    expect(await client.json("GET", "/api/telegram")).toEqual({ state: "off" });
    await env.DB.prepare("UPDATE telegram SET chat_id = ?, last_error = 'blocked'")
      .bind(CHAT)
      .run();
    expect(await client.json("GET", "/api/telegram")).toMatchObject({
      state: "on",
      chatLabel: "@owner",
      lastError: "blocked",
    });
  });

  it("needs a fresh Passkey assertion to connect", async () => {
    const calls = stubTelegram();
    const client = await signedIn();
    expect(await client.json("POST", "/api/telegram/link", {}, 403)).toEqual({
      error: "reauth_required",
    });
    expect(calls).toEqual([]);
  });

  it("registers the webhook on the request origin with a generated secret and a code", async () => {
    const calls = stubTelegram();
    const client = await freshClient();
    const link = await client.json("POST", "/api/telegram/link", {});
    expect(calls.map((c) => c.method)).toEqual(["getMe", "setWebhook"]);
    const hook = calls[1]?.body ?? {};
    expect(hook.url).toBe(`${ORIGIN}/api/webhooks/telegram`);
    expect(hook.allowed_updates).toEqual(["message", "widget_query", "callback_query"]);
    expect(hook.drop_pending_updates).toBe(true);
    const secret = String(hook.secret_token);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const code = String(link.code);
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(link.url).toBe(`https://t.me/melody_test_bot?start=${code}`);
    expect(Number(link.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    const row = await env.DB.prepare(
      "SELECT webhook_secret_hash AS s, link_code_hash AS c, origin FROM telegram",
    ).first();
    expect(row).toEqual({ s: await sha256Hex(secret), c: await sha256Hex(code), origin: ORIGIN });
    // The stored hash is the one the webhook checks.
    expect((await webhook({ update_id: 1 }, secret)).status).toBe(200);
    expect(await client.json("GET", "/api/telegram")).toMatchObject({ state: "pending" });
  });

  it("refuses an origin Telegram cannot reach, and answers 404 without a token", async () => {
    const calls = stubTelegram();
    const client = await freshClient();
    for (const origin of ["http://mail.test", "https://mail.test:8080"]) {
      const res = await requestAt(client, origin, "POST", "/api/telegram/link");
      expect(res.status, origin).toBe(409);
      expect(await res.json()).toEqual({ error: "telegram_needs_https" });
    }
    expect(calls).toEqual([]);
    expect(
      (await requestAt(client, "https://mail.test:8443", "POST", "/api/telegram/link")).status,
    ).toBe(200);
    const req = new Request(`${ORIGIN}/api/telegram/link`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
    });
    const bare = await fetchWith(req, { TELEGRAM_BOT_TOKEN: undefined });
    expect(bare.status).toBe(404);
    expect(await bare.json()).toEqual({ error: "telegram_not_configured" });
  });

  it("answers telegram_failed without upstream text when Telegram refuses", async () => {
    stubTelegram((method) => (method === "getMe" ? botError(401, "Unauthorized") : ok()));
    const client = await freshClient();
    const res = await client.request("POST", "/api/telegram/link", {});
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('{"error":"telegram_failed"}');
    expect(await telegramRow()).toBeNull();
  });

  it("stores nothing when setWebhook fails", async () => {
    const calls = stubTelegram((method) =>
      method === "getMe" ? ok({ username: "melody_test_bot" }) : botError(400, "Bad Request"),
    );
    const res = await (await freshClient()).request("POST", "/api/telegram/link", {});
    expect(res.status).toBe(502);
    expect(calls.map((c) => c.method)).toEqual(["getMe", "setWebhook"]);
    expect(await telegramRow()).toBeNull();
  });

  it("refuses an origin too long for a card link", async () => {
    const calls = stubTelegram();
    const host = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(30)}.test`;
    const res = await requestAt(
      await freshClient(),
      `https://${host}`,
      "POST",
      "/api/telegram/link",
    );
    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
  });

  it("cancels a pending code", async () => {
    await seedTelegram({ chatId: null, code: "abc" });
    const client = await signedIn();
    await client.json("DELETE", "/api/telegram/link");
    expect((await telegramRow())?.codeHash).toBeNull();
  });
});

describe("telegram disconnect and test card", () => {
  it("deletes the webhook, the binding and the cards; the webhook then answers 404", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1" });
    await cardFor("m1");
    const calls = stubTelegram();
    const client = await signedIn();
    await client.json("DELETE", "/api/telegram");
    expect(calls).toMatchObject([
      { method: "deleteWebhook", body: { drop_pending_updates: true } },
    ]);
    expect(await telegramRow()).toBeNull();
    expect(await cardRows()).toEqual([]);
    expect((await webhook({ update_id: 1 })).status).toBe(404);
  });

  it("disconnects even when deleteWebhook fails", async () => {
    await seedTelegram();
    stubTelegram(() => botError(500, "Internal"));
    await (await signedIn()).json("DELETE", "/api/telegram");
    expect(await telegramRow()).toBeNull();
  });

  it("sends a test card to the bound chat and records a failure for the panel", async () => {
    const client = await signedIn();
    stubTelegram();
    expect(await client.json("POST", "/api/telegram/test", {}, 409)).toEqual({
      error: "telegram_not_connected",
    });
    await seedTelegram({ chatId: null });
    expect(await client.json("POST", "/api/telegram/test", {}, 409)).toEqual({
      error: "telegram_not_connected",
    });
    await env.DB.prepare("DELETE FROM telegram").run();
    await seedTelegram({ language: "ja-JP" });
    const calls = stubTelegram((method) =>
      method === "sendWidget" ? ok({ message_id: 7 }) : ok(),
    );
    await client.json("POST", "/api/telegram/test", {});
    const sent = calls[0]?.body ?? {};
    expect(sent.chat_id).toBe(CHAT);
    expect(JSON.parse(String(sent.chat_data))).toEqual({
      v: 1,
      x: 1,
      f: "MelodyMail",
      s: "テスト通知",
      t: null,
      u: `${ORIGIN}/`,
    });
    expect(await cardRows()).toEqual([]);
    // Refused as a widget, the test card is a plain message with Open only: it names no mail.
    const plain = stubTelegram((method) =>
      method === "sendWidget"
        ? botError(400, "Bad Request: INPUT_MEDIA_WIDGET_NOT_ALLOWED")
        : ok({ message_id: 8 }),
    );
    await client.json("POST", "/api/telegram/test", {});
    expect(plain[1]?.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: "開く", url: `${ORIGIN}/` }]],
    });
    expect(await cardRows()).toEqual([]);
    stubTelegram(() => botError(403, "Forbidden: bot was blocked by the user"));
    expect(await client.json("POST", "/api/telegram/test", {}, 502)).toEqual({
      error: "telegram_failed",
    });
    expect((await telegramRow())?.lastError).toBe("blocked");
  });

  it("limits Connect and the test card per session", async () => {
    await seedTelegram();
    const calls = stubTelegram();
    const client = await freshClient();
    const limiter = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    for (const path of ["/api/telegram/test", "/api/telegram/link"]) {
      const req = new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
      });
      expect((await fetchWith(req, { TELEGRAM_LIMITER: limiter })).status, path).toBe(429);
    }
    expect(calls).toEqual([]);
  });
});
