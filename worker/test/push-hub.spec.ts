import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_IDLE_MS } from "../src/auth/session";
import { handleQueue } from "../src/mail/consumer";
import { type Client, ORIGIN, setupOwner } from "./helpers";
import { messageRows } from "./mail-helpers";
import {
  browserSubscription,
  decryptPush,
  insertSession,
  insertSubscription,
  pushRows,
  stubPushService,
} from "./push-helpers";

// The Hub sends Web Push for a new message only when it reached no open page
// (docs/M4b-pwa.md, "Sending"). fetch is stubbed: no request reaches a real push service.

const open: WebSocket[] = [];
afterEach(() => {
  for (const ws of open.splice(0)) ws.close();
});

async function storeRow(id: string, headers: string) {
  const key = `raw/2026/11/${id}.eml`;
  await env.MAIL.put(key, `${headers}\r\n\r\nBody text that never leaves the Worker\r\n`);
  await env.DB.prepare(
    `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
       raw_size, r2_key, received_at) VALUES (?, 1, 'in', 'stored', 'env@example.org', 'shop@example.com', 10, ?, ?)`,
  )
    .bind(id, key, Date.now())
    .run();
}

async function parse(id: string) {
  const message = { body: { id }, ack: vi.fn(), retry: vi.fn() };
  await handleQueue({ messages: [message] } as unknown as MessageBatch<InboundJob>, env);
  return message;
}

async function subscribe(client: Client) {
  const sub = await browserSubscription();
  expect((await client.request("PUT", "/api/push/subscription", sub.json)).status).toBe(200);
  return sub;
}

async function connect(client: Client) {
  const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await exports.default.fetch(`${ORIGIN}/api/events`, {
    headers: { upgrade: "websocket", origin: ORIGIN, cookie },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error("no socket");
  ws.accept();
  open.push(ws);
}

describe("push for new mail", () => {
  it("sends sender, subject and address, and no body, when no page is open", async () => {
    const { client } = await setupOwner();
    const sub = await subscribe(client);
    const sent = stubPushService(201);
    await storeRow("p1", "From: Alice Example <alice@example.org>\r\nSubject: Lunch?");
    const message = await parse("p1");
    expect(message.ack).toHaveBeenCalledOnce();
    expect(sent.map((s) => s.url)).toEqual([sub.json.endpoint]);
    const payload = await decryptPush(sent[0]?.body ?? new Uint8Array(), sub);
    expect(payload).toEqual({
      type: "message",
      id: "p1",
      from: "Alice Example",
      subject: "Lunch?",
      to: "shop@example.com",
    });
    expect(JSON.stringify(payload)).not.toContain("Body text");
  });

  it("falls back to the address, sends a null subject, and cuts a long subject at 200", async () => {
    const { client } = await setupOwner();
    const sub = await subscribe(client);
    const sent = stubPushService(201);
    await storeRow("p2", "From: <bob@example.org>");
    await parse("p2");
    await storeRow("p3", `From: carol@example.org\r\nSubject: ${"長".repeat(250)}`);
    await parse("p3");
    const [first, second] = await Promise.all(sent.map((s) => decryptPush(s.body, sub)));
    expect(first).toMatchObject({ from: "bob@example.org", subject: null });
    expect(second).toMatchObject({ from: "carol@example.org", subject: "長".repeat(200) });
  });

  it("sends nothing when a page is open", async () => {
    const { client } = await setupOwner();
    await subscribe(client);
    await connect(client);
    const sent = stubPushService(201);
    await storeRow("p4", "Subject: Seen live");
    await parse("p4");
    expect(sent).toEqual([]);
  });

  it("sends nothing to an expired or idle session that was not swept yet", async () => {
    const { client } = await setupOwner();
    await subscribe(client);
    const sent = stubPushService(201);
    await env.DB.prepare("UPDATE sessions SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    await storeRow("p5", "Subject: Expired");
    await parse("p5");
    await env.DB.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ?")
      .bind(Date.now() + 86_400_000, Date.now() - SESSION_IDLE_MS - 1)
      .run();
    await storeRow("p6", "Subject: Idle");
    await parse("p6");
    expect(sent).toEqual([]);
    expect(await pushRows()).toHaveLength(1);
  });

  it("sends to the 10 newest live subscriptions at most", async () => {
    await setupOwner();
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      await insertSession(`d${i}`, now);
      await insertSubscription(`d${i}`, `https://fcm.googleapis.com/fcm/send/d${i}`, now + i);
    }
    const sent = stubPushService(201);
    await storeRow("p11", "Subject: Many devices");
    await parse("p11");
    expect(sent.map((s) => s.url.split("/").pop()).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `d${i + 2}`).sort(),
    );
  });

  it("deletes a subscription the push service reports gone", async () => {
    const { client } = await setupOwner();
    await subscribe(client);
    stubPushService(410);
    await storeRow("p7", "Subject: Gone");
    await parse("p7");
    expect(await pushRows()).toEqual([]);
  });

  it("does not fail the parse when the push fails", async () => {
    const { client } = await setupOwner();
    await subscribe(client);
    const warn = vi.spyOn(console, "warn");
    for (const [id, answer] of [
      ["p8", () => Promise.resolve(new Response(null, { status: 500 }))],
      ["p9", () => Promise.reject(new TypeError("network down"))],
    ] as const) {
      stubPushService(answer);
      await storeRow(id, "Subject: Still parsed");
      const message = await parse(id);
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect((await messageRows()).map((r) => r.status)).toEqual(["parsed", "parsed"]);
    expect(await pushRows()).toHaveLength(1);
    const events = warn.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(events.filter((e) => e.event === "push_failed")).toHaveLength(2);
    for (const line of warn.mock.calls) expect(String(line[0])).not.toContain("googleapis");
  });

  it("does not fail the parse when reading the subscriptions fails", async () => {
    const { client } = await setupOwner();
    await subscribe(client);
    stubPushService(201);
    await storeRow("p10", "Subject: D1 trouble");
    await env.DB.exec("ALTER TABLE push_subscriptions RENAME TO push_subscriptions_gone");
    try {
      const warn = vi.spyOn(console, "warn");
      const message = await parse("p10");
      expect(message.ack).toHaveBeenCalledOnce();
      expect(warn.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toContain(
        "push_new_mail_failed",
      );
    } finally {
      await env.DB.exec("ALTER TABLE push_subscriptions_gone RENAME TO push_subscriptions");
    }
  });
});
