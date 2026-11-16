import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, ORIGIN, setupOwner, totpCode } from "./helpers";
import { seedMessage } from "./mailbox-helpers";
import { signedIn } from "./send-helpers";
import {
  botError,
  CHAT,
  callback,
  cardFor,
  cardRows,
  message,
  query,
  SECRET,
  seedTelegram,
  stubTelegram,
  telegramRow,
  webhook,
} from "./telegram-helpers";

// POST /api/webhooks/telegram (docs/M5b-telegram.md, "Webhook handling", "Binding", "Actions"),
// against a real D1, with the Bot API stubbed.

const open: WebSocket[] = [];
afterEach(() => {
  for (const ws of open.splice(0)) ws.close();
});

describe("telegram webhook authentication", () => {
  it("answers 404 without a binding, 401 for a wrong or missing secret, 200 for the right one", async () => {
    expect((await webhook({ update_id: 1 })).status).toBe(404);
    await seedTelegram();
    expect((await webhook({ update_id: 1 }, "wrong")).status).toBe(401);
    expect((await webhook({ update_id: 1 }, null)).status).toBe(401);
    expect((await webhook({ update_id: 1 }, `${SECRET}x`)).status).toBe(401);
    const res = await webhook({ update_id: 1 });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("ignores an oversized body and invalid JSON with 200 and no effect", async () => {
    await seedTelegram({ chatId: null, code: "code-1" });
    const big = JSON.stringify({ ...message("/start code-1"), pad: "x".repeat(70_000) });
    const res = await webhook(big);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    const declared = await exports.default.fetch(`${ORIGIN}/api/webhooks/telegram`, {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": SECRET, "content-length": "70000" },
      body: JSON.stringify(message("/start code-1")),
    });
    expect(declared.status).toBe(200);
    // A chunked body declares no length; the bytes read are counted too.
    const bytes = new TextEncoder().encode(big);
    const chunked = await exports.default.fetch(`${ORIGIN}/api/webhooks/telegram`, {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    });
    expect(chunked.status).toBe(200);
    expect(await chunked.text()).toBe("");
    expect((await webhook("{not json")).status).toBe(200);
    expect((await telegramRow())?.chatId).toBeNull();
  });
});

describe("binding a chat", () => {
  it("binds the owner's private chat with a valid code, once", async () => {
    await seedTelegram({ chatId: null, code: "code-1" });
    const res = await webhook(message("/start code-1", {}, { language_code: "zh-hans" }));
    expect(await res.json()).toEqual({
      method: "sendMessage",
      chat_id: CHAT,
      text: "已连接。新邮件会显示在这里。",
    });
    expect(await telegramRow()).toMatchObject({
      chatId: CHAT,
      chatLabel: "@owner",
      language: "zh-CN",
      codeHash: null,
    });
    const again = await webhook(
      message("/start code-1", { id: 222 }, { id: 222, language_code: "ja" }),
    );
    expect(((await again.json()) as { text: string }).text).toMatch(
      /^このコードは無効か期限切れです。/,
    );
    expect((await telegramRow())?.chatId).toBe(CHAT);
  });

  it("binds one chat when two chats use the same code at once", async () => {
    await seedTelegram({ chatId: null, code: "code-1" });
    const replies = await Promise.all(
      [CHAT, 222].map(async (id) => {
        const res = await webhook(message("/start code-1", { id }, { id }));
        return ((await res.json()) as { text: string }).text;
      }),
    );
    expect(replies.filter((text) => text === "Connected. New mail will appear here.")).toHaveLength(
      1,
    );
    expect(replies.filter((text) => text.startsWith("This code is invalid"))).toHaveLength(1);
    expect([CHAT, 222]).toContain((await telegramRow())?.chatId);
  });

  it("refuses expired and wrong codes, groups and another sender with the one reply", async () => {
    const invalid =
      "This code is invalid or expired. Create a new one in MelodyMail: Settings > Notifications.";
    await seedTelegram({ chatId: null, code: "code-1", expiresAt: Date.now() + 600_000 });
    const updates = [
      message("/start wrong"),
      message("/start"),
      message("/start code-1", { type: "group", id: -5 }, { id: CHAT }),
      message("/start code-1", {}, { id: CHAT + 1 }),
    ];
    for (const update of updates) {
      const res = await webhook(update);
      expect(((await res.json()) as { text: string }).text).toBe(invalid);
    }
    expect((await webhook(message("hello"))).status).toBe(200);
    expect(await (await webhook(message("hello"))).text()).toBe("");
    await env.DB.prepare("UPDATE telegram SET link_expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    const late = await webhook(message("/start code-1"));
    expect(((await late.json()) as { text: string }).text).toBe(invalid);
    expect((await telegramRow())?.chatId).toBeNull();
  });

  it("drops the old chat's cards when another chat binds", async () => {
    await seedTelegram({ chatId: 999, code: "code-2" });
    await seedMessage({ id: "m1" });
    await cardFor("m1", 5, 999);
    await webhook(message("/start code-2"));
    expect((await telegramRow())?.chatId).toBe(CHAT);
    expect(await cardRows()).toEqual([]);
  });

  it("is removed by an account recovery", async () => {
    const owner = await setupOwner();
    await seedTelegram();
    await seedMessage({ id: "m1" });
    await cardFor("m1");
    const res = await new Client().request("POST", "/api/auth/recover", {
      recoveryKey: owner.recoveryKey,
      totpCode: await totpCode(owner.totpSecret, 1),
    });
    expect(res.status).toBe(200);
    expect(await telegramRow()).toBeNull();
    expect(await cardRows()).toEqual([]);
  });
});

describe("card buttons", () => {
  async function socket(): Promise<string[]> {
    const client = await signedIn();
    const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await exports.default.fetch(`${ORIGIN}/api/events`, {
      headers: { upgrade: "websocket", origin: ORIGIN, cookie },
    });
    const ws = res.webSocket;
    if (!ws) throw new Error("no socket");
    ws.accept();
    open.push(ws);
    const events: string[] = [];
    ws.addEventListener("message", (e) => {
      events.push(String(e.data));
    });
    return events;
  }

  const flags = (id: string) =>
    env.DB.prepare("SELECT read, archived, starred FROM messages WHERE id = ?").bind(id).first();

  it("sets exactly the tapped flag, edits the card and answers with all three", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1", subject: "Hello", from: "Alice <alice@example.org>" });
    await cardFor("m1");
    const events = await socket();
    const steps: [string, Record<string, number>][] = [
      ["read:1", { read: 1, archived: 0, starred: 0 }],
      ["arch:1", { read: 1, archived: 1, starred: 0 }],
      ["star:1", { read: 1, archived: 1, starred: 1 }],
      ["read:0", { read: 0, archived: 1, starred: 1 }],
      ["arch:0", { read: 0, archived: 0, starred: 1 }],
      ["star:0", { read: 0, archived: 0, starred: 0 }],
    ];
    for (const [data, want] of steps) {
      const calls = stubTelegram();
      const res = await webhook(query(data));
      expect(await flags("m1"), data).toEqual(want);
      expect(await res.json()).toEqual({
        method: "answerWidgetQuery",
        widget_query_id: "q-1",
        data: JSON.stringify({ r: want.read, a: want.archived, st: want.starred }),
      });
      expect(calls.map((c) => c.method)).toEqual(["editMessageWidgetData"]);
      const edit = calls[0]?.body ?? {};
      expect(edit).toMatchObject({ chat_id: CHAT, message_id: 42 });
      expect(JSON.parse(String(edit.chat_data))).toEqual({
        v: 1,
        f: "Alice",
        s: "Hello",
        t: "shop@example.com",
        u: `${ORIGIN}/?m=m1`,
        r: want.read,
        a: want.archived,
        st: want.starred,
      });
    }
    await expect.poll(() => events.length).toBe(steps.length);
    expect(events[0]).toBe(JSON.stringify({ type: "changed", id: "m1" }));
  });

  it("changes nothing and answers unbound for another chat, a group or another sender", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1" });
    await cardFor("m1");
    const calls = stubTelegram();
    for (const update of [
      query("read:1", 42, { id: 7 }, { id: 7 }),
      query("read:1", 42, { type: "group" }),
      query("read:1", 42, {}, { id: 7 }),
    ]) {
      const res = await webhook(update);
      expect(JSON.parse(((await res.json()) as { data: string }).data)).toEqual({ e: "unbound" });
    }
    await env.DB.prepare("UPDATE telegram SET chat_id = NULL").run();
    const res = await webhook(query("read:1"));
    expect(JSON.parse(((await res.json()) as { data: string }).data)).toEqual({ e: "unbound" });
    expect(await flags("m1")).toEqual({ read: 0, archived: 0, starred: 0 });
    expect(calls).toEqual([]);
  });

  it("answers bad for unknown data", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1" });
    await cardFor("m1");
    stubTelegram();
    for (const data of ["trash:1", "read:2", "read:1:m2", "read"]) {
      const res = await webhook(query(data));
      expect(JSON.parse(((await res.json()) as { data: string }).data), data).toEqual({ e: "bad" });
    }
    expect(await flags("m1")).toEqual({ read: 0, archived: 0, starred: 0 });
  });

  it("marks a card of a deleted message as gone", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1", trashed: true });
    await cardFor("m1");
    await env.DB.prepare("DELETE FROM messages WHERE id = 'm1'").run();
    expect(await cardRows()).toEqual([]);
    const calls = stubTelegram();
    const res = await webhook(query("star:1"));
    expect(JSON.parse(((await res.json()) as { data: string }).data)).toEqual({ e: "gone" });
    expect(calls).toMatchObject([
      { method: "editMessageWidgetData", body: { chat_data: '{"v":1,"g":1}' } },
    ]);
  });

  it("takes message is not modified as done and still answers after a failed edit", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1" });
    await cardFor("m1");
    for (const [status, description] of [
      [400, "Bad Request: message is not modified"],
      [500, "Internal"],
    ] as const) {
      stubTelegram(() => botError(status, description));
      const warn = vi.spyOn(console, "warn");
      const res = await webhook(query("read:1"));
      // Not modified is a success: logged as info, not as a warning.
      expect(warn.mock.calls.length > 0, String(status)).toBe(status === 500);
      expect(JSON.parse(((await res.json()) as { data: string }).data)).toEqual({
        r: 1,
        a: 0,
        st: 0,
      });
    }
  });

  // The plain message's buttons (addendum, owner ruling 7): the same checks, a notice as the answer.
  const notice = async (res: Response) => ((await res.json()) as { text: string }).text;

  it("toggles each flag both ways from the plain message and redraws its keyboard", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1" });
    await cardFor("m1");
    const events = await socket();
    const steps: [string, Record<string, number>, string][] = [
      ["read:1", { read: 1, archived: 0, starred: 0 }, "Marked as read"],
      ["arch:1", { read: 1, archived: 1, starred: 0 }, "Archived"],
      ["star:1", { read: 1, archived: 1, starred: 1 }, "Starred"],
      ["read:0", { read: 0, archived: 1, starred: 1 }, "Marked as unread"],
      ["arch:0", { read: 0, archived: 0, starred: 1 }, "Moved to Inbox"],
      ["star:0", { read: 0, archived: 0, starred: 0 }, "Star removed"],
    ];
    for (const [data, want, text] of steps) {
      const calls = stubTelegram();
      const res = await webhook(callback(data));
      expect(await flags("m1"), data).toEqual(want);
      expect(await res.json()).toEqual({
        method: "answerCallbackQuery",
        callback_query_id: "cb-1",
        text,
      });
      expect(calls).toMatchObject([
        { method: "editMessageReplyMarkup", body: { chat_id: CHAT, message_id: 42 } },
      ]);
      expect(calls[0]?.body.reply_markup).toEqual({
        inline_keyboard: [
          [
            { text: "Open", url: `${ORIGIN}/?m=m1` },
            want.read
              ? { text: "Mark as unread", callback_data: "read:0" }
              : { text: "Mark as read", callback_data: "read:1" },
          ],
          [
            want.archived
              ? { text: "Move to Inbox", callback_data: "arch:0" }
              : { text: "Archive", callback_data: "arch:1" },
            want.starred
              ? { text: "Remove star", callback_data: "star:0" }
              : { text: "Star", callback_data: "star:1" },
          ],
        ],
      });
    }
    await expect.poll(() => events.length).toBe(steps.length);
    expect(events[0]).toBe(JSON.stringify({ type: "changed", id: "m1" }));
    // A failed edit is logged; the flag is set and the notice still goes out.
    stubTelegram(() => botError(500, "Internal"));
    expect(await notice(await webhook(callback("star:1")))).toBe("Starred");
    expect(await flags("m1")).toEqual({ read: 0, archived: 0, starred: 1 });
  });

  it("refuses another chat, another sender, a group and an inline message on the plain message", async () => {
    await seedTelegram({ language: "ja-JP" });
    await seedMessage({ id: "m1" });
    await cardFor("m1");
    const calls = stubTelegram();
    for (const update of [
      callback("read:1", { chat: { id: 7 }, from: { id: 7 } }),
      callback("read:1", { chat: { type: "group" } }),
      callback("read:1", { from: { id: 7 } }),
      callback("read:1", { message: null }),
    ]) {
      expect(await notice(await webhook(update))).toBe(
        "Telegram と MelodyMail の接続は解除されています。",
      );
    }
    await env.DB.prepare("UPDATE telegram SET chat_id = NULL").run();
    expect(await notice(await webhook(callback("read:1")))).toMatch(/^Telegram と/);
    expect(await flags("m1")).toEqual({ read: 0, archived: 0, starred: 0 });
    expect(calls).toEqual([]);
  });

  it("answers bad data and a missing card with a notice and edits nothing", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1" });
    await cardFor("m1");
    await seedMessage({ id: "m2" });
    // A card whose send result was lost: the row has no Telegram message id.
    await env.DB.prepare(
      "INSERT INTO telegram_cards (message_id, chat_id, created_at) VALUES ('m2', ?, 0)",
    )
      .bind(CHAT)
      .run();
    const calls = stubTelegram();
    for (const data of ["trash:1", "read:2", "read:1:m2", ""]) {
      expect(await notice(await webhook(callback(data))), data).toBe(
        "MelodyMail didn't answer. Try again.",
      );
    }
    for (const messageId of [43, 0]) {
      expect(await notice(await webhook(callback("read:1", { messageId })))).toBe(
        "This message was deleted in MelodyMail.",
      );
    }
    expect(await flags("m1")).toEqual({ read: 0, archived: 0, starred: 0 });
    expect(await flags("m2")).toEqual({ read: 0, archived: 0, starred: 0 });
    expect(calls).toEqual([]);
  });
});
