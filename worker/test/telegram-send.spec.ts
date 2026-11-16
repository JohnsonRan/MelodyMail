import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copy } from "../src/telegram/card";
import html from "../src/telegram/card.html";
import { telegramNewMail } from "../src/telegram/send";
import { ORIGIN } from "./helpers";
import { seedMessage } from "./mailbox-helpers";
import { signedIn } from "./send-helpers";
import {
  botError,
  CHAT,
  callback,
  cardRows,
  message,
  notifyNewMail,
  ok,
  query,
  SECRET,
  seedTelegram,
  stubTelegram,
  telegramRow,
  webhook,
} from "./telegram-helpers";

// A card for each new message from the Hub (docs/M5b-telegram.md, "Sending"), with the Bot API
// stubbed. The Hub runs as the queue consumer calls it after a parse.

const open: WebSocket[] = [];
afterEach(() => {
  for (const ws of open.splice(0)) ws.close();
});

const sentWidget = () => ok({ message_id: 42, chat: { id: CHAT } });

describe("telegram cards for new mail", () => {
  it("sends one card per message with the template, the flags and the content", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1", subject: "Lunch?", from: '"Alice Example" <alice@example.org>' });
    const calls = stubTelegram(sentWidget);
    await notifyNewMail("m1");
    await notifyNewMail("m1");
    expect(calls.map((c) => c.method)).toEqual(["sendWidget"]);
    expect(calls[0]?.timed).toBe(true);
    const body = calls[0]?.body ?? {};
    expect(body).toMatchObject({
      chat_id: CHAT,
      html,
      allow_queries: true,
      protect_content: true,
      caption: "Alice Example\nLunch?",
    });
    expect(body).not.toHaveProperty("parse_mode");
    expect(JSON.parse(String(body.chat_data))).toEqual({
      v: 1,
      f: "Alice Example",
      s: "Lunch?",
      t: "shop@example.com",
      u: `${ORIGIN}/?m=m1`,
      r: 0,
      a: 0,
      st: 0,
    });
    expect(await cardRows()).toEqual([{ messageId: "m1", chatId: CHAT, tgMessageId: 42 }]);
  });

  it("sends one card when the same message is notified twice at once", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1" });
    const calls = stubTelegram(sentWidget);
    await Promise.all([notifyNewMail("m1"), notifyNewMail("m1")]);
    expect(calls.map((c) => c.method)).toEqual(["sendWidget"]);
    expect(await cardRows()).toHaveLength(1);
  });

  it("cuts long fields to keep chat_data within 1024 bytes and the link within 256", async () => {
    const id = crypto.randomUUID();
    await seedTelegram({ language: "ja-JP" });
    await seedMessage({
      id,
      subject: `${"長い件名".repeat(200)}`,
      from: `"${'山田\\"太郎'.repeat(60)}" <yamada@example.jp>`,
    });
    await env.DB.prepare("UPDATE messages SET envelope_to = ? WHERE id = ?")
      .bind(`${"a".repeat(64)}@${"b".repeat(250)}.jp`, id)
      .run();
    const calls = stubTelegram(sentWidget);
    await notifyNewMail(id);
    const body = calls[0]?.body ?? {};
    const data = String(body.chat_data);
    expect(new TextEncoder().encode(data).byteLength).toBeLessThanOrEqual(1024);
    const parsed = JSON.parse(data);
    expect(parsed.s.length).toBeLessThan(200 * 4);
    expect(parsed.t.length).toBe(200);
    expect(parsed.u.length).toBeLessThanOrEqual(256);
    expect(String(body.caption).length).toBeLessThanOrEqual(1024);
  });

  it("names the missing subject in the bound language", async () => {
    await seedTelegram({ language: "zh-CN" });
    await seedMessage({ id: "m1", subject: null, from: null });
    const calls = stubTelegram(sentWidget);
    await notifyNewMail("m1");
    expect(calls[0]?.body.caption).toBe("env@example.org\n（无主题）");
  });

  it("sends nothing without a bound chat or without a token", async () => {
    const warn = vi.spyOn(console, "warn");
    await seedTelegram({ chatId: null });
    await seedMessage({ id: "m1" });
    const calls = stubTelegram(sentWidget);
    await notifyNewMail("m1");
    await env.DB.prepare("UPDATE telegram SET chat_id = ?").bind(CHAT).run();
    await telegramNewMail({ ...env, TELEGRAM_BOT_TOKEN: undefined }, "m1");
    expect(calls).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(await cardRows()).toEqual([]);
  });

  it("still sends the card while a mailbox page is open", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1" });
    const client = await signedIn();
    const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await exports.default.fetch(`${ORIGIN}/api/events`, {
      headers: { upgrade: "websocket", origin: ORIGIN, cookie },
    });
    res.webSocket?.accept();
    if (res.webSocket) open.push(res.webSocket);
    const calls = stubTelegram(sentWidget);
    expect(await notifyNewMail("m1")).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(["sendWidget"]);
  });

  it("falls back to a plain message with the four buttons when the widget is refused", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1", subject: "Hi", starred: true });
    const calls = stubTelegram((method) =>
      method === "sendWidget"
        ? botError(400, "Bad Request: INPUT_MEDIA_WIDGET_NOT_ALLOWED")
        : ok({ message_id: 9 }),
    );
    await notifyNewMail("m1");
    expect(calls.map((c) => c.method)).toEqual(["sendWidget", "sendMessage"]);
    expect(calls[1]?.body).toEqual({
      chat_id: CHAT,
      text: "Sender\nHi",
      protect_content: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Open", url: `${ORIGIN}/?m=m1` },
            { text: "Mark as read", callback_data: "read:1" },
          ],
          [
            { text: "Archive", callback_data: "arch:1" },
            { text: "Remove star", callback_data: "star:0" },
          ],
        ],
      },
    });
    expect(await cardRows()).toEqual([{ messageId: "m1", chatId: CHAT, tgMessageId: 9 }]);
    expect((await telegramRow())?.lastError).toBeNull();
  });

  it("records 403 and 429 for the panel and sends nothing else", async () => {
    await seedTelegram();
    for (const [i, [status, want]] of (
      [
        [403, "blocked"],
        [429, "rate_limited"],
        [502, "failed"],
      ] as const
    ).entries()) {
      await seedMessage({ id: `m${i}` });
      const calls = stubTelegram(() => botError(status, "Too Many Requests: retry after 3"));
      await notifyNewMail(`m${i}`);
      expect(calls.map((c) => c.method)).toEqual(["sendWidget"]);
      expect((await telegramRow())?.lastError).toBe(want);
    }
    await seedMessage({ id: "m9" });
    stubTelegram(sentWidget);
    await notifyNewMail("m9");
    expect((await telegramRow())?.lastError).toBeNull();
  });

  it("records a 200 without a Bot API answer as a failure", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1" });
    stubTelegram(() => new Response("{}"));
    await notifyNewMail("m1");
    expect((await telegramRow())?.lastError).toBe("failed");
    expect(await cardRows()).toEqual([{ messageId: "m1", chatId: CHAT, tgMessageId: null }]);
  });

  it("never fails the notification when Telegram cannot be reached", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    await expect(notifyNewMail("m1")).resolves.toBe(0);
    expect((await telegramRow())?.lastError).toBe("failed");
  });
});

describe("plain message copy", () => {
  it("repeats the card's labels and lines word for word", () => {
    const block = { en: "en", "zh-CN": "zh", "ja-JP": "ja" };
    for (const [language, key] of Object.entries(block)) {
      const words = copy(language);
      const card = html.slice(html.indexOf(`${key}: {`)).split("},")[0] ?? "";
      for (const [id, pair] of [
        ["r", words.read],
        ["a", words.arch],
        ["x", words.star],
      ] as const) {
        expect(card, language).toContain(`${id}:${JSON.stringify(pair)}`);
      }
      for (const [id, line] of [
        ["o", words.open],
        ["g", words.gone],
        ["u", words.unbound],
        ["f", words.failed],
      ]) {
        expect(card, language).toContain(`${id}:${JSON.stringify(line)}`);
      }
    }
  });
});

describe("telegram logs", () => {
  it("carry no token, chat id, code, secret, subject, sender or address", async () => {
    const lines: string[] = [];
    for (const level of ["debug", "info", "warn", "error", "log"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    await seedTelegram({ chatId: null, code: "secret-code-1" });
    await webhook(message("/start secret-code-1"));
    await webhook(message("/start secret-code-2"));
    await seedMessage({
      id: "m1",
      subject: "PLANTED-SUBJECT",
      from: "Planted <planted@example.org>",
    });
    stubTelegram(() => botError(403, "Forbidden: bot was blocked"));
    await notifyNewMail("m1");
    stubTelegram(() => {
      throw new TypeError(`fetch failed for ${env.TELEGRAM_BOT_TOKEN}`);
    });
    await env.DB.prepare(
      "INSERT INTO telegram_cards (message_id, chat_id, tg_message_id, created_at) VALUES ('m1', ?, 42, 0) ON CONFLICT (message_id) DO UPDATE SET tg_message_id = 42",
    )
      .bind(CHAT)
      .run();
    await webhook(query("read:1"));
    await webhook(callback("read:0"));
    await webhook({ update_id: 3 }, "wrong-secret");
    const logged = lines.join("\n");
    expect(logged).toContain("telegram_call_failed");
    for (const value of [
      env.TELEGRAM_BOT_TOKEN ?? "",
      "123456",
      String(CHAT),
      "secret-code",
      SECRET,
      "PLANTED-SUBJECT",
      "planted@example.org",
      "Planted",
      "shop@example.com",
      "UPSTREAM-TEXT",
    ]) {
      expect(logged, value).not.toContain(value);
    }
  });
});
