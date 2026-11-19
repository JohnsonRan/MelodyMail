import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";

import { BULK_MAX } from "../src/mail/routes";
import { Client, ORIGIN, setupOwner } from "./helpers";
import { fetchWith, rawKey, seedMany, seedMessage } from "./mailbox-helpers";

type Item = Record<string, unknown> & { id: string };

async function ids(client: Client, path: string): Promise<string[]> {
  const data = await client.json("GET", path);
  return (data.messages as Item[]).map((m) => m.id);
}

/** Runs the app with a replaced env, as the owner's browser would call it. */
async function callWith(client: Client, method: string, path: string, overrides: Partial<Env>) {
  const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  return fetchWith(
    new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, cookie } }),
    overrides,
  );
}

describe("message lists", () => {
  it("filters each folder", async () => {
    const { client } = await setupOwner();
    await seedMany([
      { id: "inbox" },
      { id: "inbox-starred", starred: true },
      { id: "archived", archived: true },
      { id: "archived-starred", archived: true, starred: true },
      { id: "trashed", trashed: true },
      { id: "trashed-starred", trashed: true, starred: true },
      { id: "trashed-archived", trashed: true, archived: true },
    ]);
    const sorted = async (folder: string) =>
      (await ids(client, `/api/messages?folder=${folder}`)).sort();
    expect(await sorted("inbox")).toEqual(["inbox", "inbox-starred"]);
    expect(await sorted("starred")).toEqual(["archived-starred", "inbox-starred"]);
    expect(await sorted("archive")).toEqual(["archived", "archived-starred"]);
    expect(await sorted("trash")).toEqual(["trashed", "trashed-archived", "trashed-starred"]);
    expect((await ids(client, "/api/messages")).sort()).toEqual(["inbox", "inbox-starred"]);
  });

  it("filters by address", async () => {
    const { client } = await setupOwner();
    await seedMany([
      { id: "a1", addressId: 1 },
      { id: "a2", addressId: 2 },
      { id: "a2-archived", addressId: 2, archived: true },
    ]);
    expect(await ids(client, "/api/messages?address=2")).toEqual(["a2"]);
    expect(await ids(client, "/api/messages?folder=archive&address=2")).toEqual(["a2-archived"]);
  });

  it("returns the list fields newest first", async () => {
    const { client } = await setupOwner();
    await seedMany([
      { id: "old", receivedAt: 1000, subject: "Old", snippet: "first", read: true },
      { id: "new", receivedAt: 2000, from: null, status: "parse_failed", starred: true },
    ]);
    const data = await client.json("GET", "/api/messages");
    expect(data.nextCursor).toBeNull();
    expect(data.messages).toEqual([
      {
        id: "new",
        addressId: 1,
        tag: null,
        from: "env@example.org",
        subject: null,
        snippet: null,
        receivedAt: 2000,
        date: null,
        size: expect.any(Number),
        read: false,
        starred: true,
        archived: false,
        trashed: false,
        spam: false,
        hasAttachments: false,
        status: "parse_failed",
        threadKey: null,
        direction: "in",
        to: "shop@example.com",
        error: null,
      },
      expect.objectContaining({
        id: "old",
        from: "Sender <sender@example.org>",
        subject: "Old",
        snippet: "first",
        read: true,
        status: "parsed",
      }),
    ]);
  });

  it("pages with no gaps or duplicates when times repeat", async () => {
    const { client } = await setupOwner();
    const count = 61;
    // Three rows share each received_at, so the id decides the order inside a time.
    const rows = Array.from({ length: count }, (_, i) => ({
      id: `m${String(i).padStart(3, "0")}`,
      at: 1_000 + Math.floor(i / 3),
    }));
    await env.DB.batch(
      rows.map((r) =>
        env.DB.prepare(
          `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
             raw_size, r2_key, received_at) VALUES (?, 1, 'in', 'parsed', 'a@b.c', 'd@e.f', 1, ?, ?)`,
        ).bind(r.id, rawKey(r.id), r.at),
      ),
    );
    const expected = [...rows]
      .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
      .map((r) => r.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const data = await client.json("GET", `/api/messages?limit=7${query}`);
      seen.push(...(data.messages as Item[]).map((m) => m.id));
      cursor = data.nextCursor as string | null;
      pages++;
    } while (cursor);
    expect(seen).toEqual(expected);
    expect(pages).toBe(Math.ceil(count / 7));
  });

  it("ends a list that fills its last page exactly without an empty page", async () => {
    const { client } = await setupOwner();
    await seedMany(Array.from({ length: 4 }, (_, i) => ({ id: `e${i}`, receivedAt: 1000 + i })));
    const first = await client.json("GET", "/api/messages?limit=2");
    expect((first.messages as Item[]).map((m) => m.id)).toEqual(["e3", "e2"]);
    const second = await client.json(
      "GET",
      `/api/messages?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );
    expect((second.messages as Item[]).map((m) => m.id)).toEqual(["e1", "e0"]);
    expect(second.nextCursor).toBeNull();
  });

  it("refuses a bad folder, cursor, limit or address", async () => {
    const { client } = await setupOwner();
    for (const query of [
      "folder=drafts",
      "folder=__proto__",
      "cursor=nope",
      "cursor=1:a;b",
      "limit=0",
      "limit=51",
      "limit=x",
      "address=x",
    ]) {
      const res = await client.request("GET", `/api/messages?${query}`);
      expect(res.status, query).toBe(400);
    }
    expect((await client.request("GET", "/api/messages?limit=50")).status).toBe(200);
  });
});

describe("one message", () => {
  it("returns its metadata or 404", async () => {
    const { client } = await setupOwner();
    await seedMessage({ id: "one", subject: "Hi" });
    const data = await client.json("GET", "/api/messages/one");
    expect(data.message).toMatchObject({
      id: "one",
      subject: "Hi",
      to: "shop@example.com",
      cc: null,
      envelopeFrom: "env@example.org",
      envelopeTo: "shop@example.com",
      forwardFailed: 0,
    });
    await client.json("GET", "/api/messages/missing", undefined, 404);
  });

  it("returns the thread oldest first, trashed messages only in Trash", async () => {
    const { client } = await setupOwner();
    await seedMany([
      { id: "t3", threadKey: "<root>", receivedAt: 3000 },
      { id: "t1", threadKey: "<root>", receivedAt: 1000 },
      { id: "t2", threadKey: "<root>", receivedAt: 2000, trashed: true },
      { id: "t4", threadKey: "<root>", receivedAt: 4000, trashed: true },
      { id: "other", threadKey: "<other>", receivedAt: 1500 },
      { id: "lone", threadKey: null },
    ]);
    const thread = async (id: string) => ids(client, `/api/messages/${id}/thread`);
    expect(await thread("t3")).toEqual(["t1", "t3"]);
    expect(await thread("t2")).toEqual(["t2", "t4"]);
    expect(await thread("lone")).toEqual(["lone"]);
    await client.json("GET", "/api/messages/missing/thread", undefined, 404);
  });
});

describe("raw message", () => {
  it("streams the R2 object as a download that never renders", async () => {
    const { client } = await setupOwner();
    const raw = "Subject: <script>alert(1)</script>\r\nContent-Type: text/html\r\n\r\n<b>x</b>\r\n";
    await seedMessage({ id: "raw", raw });
    const res = await client.request("GET", "/api/messages/raw/raw");
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="message.eml"',
      "content-length": String(raw.length),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe(raw);
  });

  it("passes the R2 body through without reading it", async () => {
    const { client } = await setupOwner();
    await seedMessage({ id: "big", raw: null });
    const body = new Response("streamed bytes").body;
    const object = {
      body,
      size: 14,
      arrayBuffer: () => Promise.reject(new Error("read in JS")),
      text: () => Promise.reject(new Error("read in JS")),
    };
    const MAIL = { get: async () => object } as unknown as R2Bucket;
    const res = await callWith(client, "GET", "/api/messages/big/raw", { MAIL });
    expect(res.status).toBe(200);
    expect(res.body).toBe(body);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("streamed bytes");
  });

  it("answers 404 for an unknown message or a missing object", async () => {
    const { client } = await setupOwner();
    await seedMessage({ id: "gone", raw: null });
    await client.json("GET", "/api/messages/gone/raw", undefined, 404);
    await client.json("GET", "/api/messages/missing/raw", undefined, 404);
  });
});

describe("flags", () => {
  it("sets flags on one message and leaves the others", async () => {
    const { client } = await setupOwner();
    await seedMessage({ id: "f", starred: true });
    await client.json("PATCH", "/api/messages/f", { read: true, archived: true });
    const row = await env.DB.prepare(
      "SELECT read, starred, archived, trashed FROM messages WHERE id = 'f'",
    ).first();
    expect(row).toEqual({ read: 1, starred: 1, archived: 1, trashed: 0 });
    await client.json("PATCH", "/api/messages/f", { starred: false, trashed: true });
    expect(
      await env.DB.prepare(
        "SELECT read, starred, archived, trashed FROM messages WHERE id = 'f'",
      ).first(),
    ).toEqual({ read: 1, starred: 0, archived: 1, trashed: 1 });
  });

  it("refuses an empty or malformed change and an unknown id", async () => {
    const { client } = await setupOwner();
    await seedMessage({ id: "f" });
    await client.json("PATCH", "/api/messages/f", {}, 400);
    await client.json("PATCH", "/api/messages/f", { read: 1 }, 400);
    await client.json("PATCH", "/api/messages/f", { other: true }, 400);
    await client.json("PATCH", "/api/messages/missing", { read: true }, 404);
  });

  it("sets flags on up to 100 messages at once", async () => {
    const { client } = await setupOwner();
    const all = Array.from({ length: BULK_MAX + 1 }, (_, i) => `b${i}`);
    await env.DB.batch(
      all.map((id) =>
        env.DB.prepare(
          `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
             raw_size, r2_key, received_at) VALUES (?, 1, 'in', 'parsed', 'a@b.c', 'd@e.f', 1, ?, 1)`,
        ).bind(id, rawKey(id)),
      ),
    );
    const res = await client.json("PATCH", "/api/messages", {
      ids: all.slice(0, BULK_MAX),
      trashed: true,
    });
    expect(res).toEqual({ updated: BULK_MAX });
    const trashed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE trashed = 1",
    ).first();
    expect(trashed).toEqual({ n: BULK_MAX });
    await client.json("PATCH", "/api/messages", { ids: all, read: true }, 400);
    expect((await client.json("PATCH", "/api/messages", { ids: all, read: true }, 400)).error).toBe(
      "too_many_ids",
    );
    await client.json("PATCH", "/api/messages", { ids: [], read: true }, 400);
    await client.json("PATCH", "/api/messages", { ids: [1], read: true }, 400);
    await client.json("PATCH", "/api/messages", { ids: ["b0"] }, 400);
    expect(await client.json("PATCH", "/api/messages", { ids: ["b0", "b0"], read: true })).toEqual({
      updated: 1,
    });
  });
});

describe("permanent delete", () => {
  it("removes the row, the search text and the raw object of a trashed message", async () => {
    const { client } = await setupOwner();
    await seedMessage({ id: "d", trashed: true, body: "delete me" });
    await seedMessage({ id: "keep", trashed: true, body: "keep me" });
    await client.json("DELETE", "/api/messages/d");
    expect(await env.DB.prepare("SELECT id FROM messages").all()).toMatchObject({
      results: [{ id: "keep" }],
    });
    expect((await env.DB.prepare("SELECT message_id FROM messages_fts").all()).results).toEqual([
      { message_id: "keep" },
    ]);
    expect(await env.MAIL.head(rawKey("d"))).toBeNull();
    expect(await env.MAIL.head(rawKey("keep"))).not.toBeNull();
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_log WHERE event = 'message_deleted'",
    ).all();
    expect(audit.results).toEqual([{ detail: "d" }]);
  });

  it("refuses a message outside Trash and keeps everything", async () => {
    const { client } = await setupOwner();
    await seedMessage({ id: "inbox", body: "still here" });
    expect((await client.json("DELETE", "/api/messages/inbox", undefined, 409)).error).toBe(
      "not_in_trash",
    );
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages_fts").first()).toEqual({
      n: 1,
    });
    expect(await env.MAIL.head(rawKey("inbox"))).not.toBeNull();
    await client.json("DELETE", "/api/messages/missing", undefined, 404);
  });

  it("still deletes the row when the R2 delete fails", async () => {
    const { client } = await setupOwner();
    await seedMessage({ id: "d", trashed: true });
    const MAIL = {
      delete: () => Promise.reject(new Error("R2 down")),
    } as unknown as R2Bucket;
    const res = await callWith(client, "DELETE", "/api/messages/d", { MAIL });
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first()).toEqual({ n: 0 });
  });
});

describe("search", () => {
  it("finds two-character Chinese terms and longer ones, outside Trash", async () => {
    const { client } = await setupOwner();
    await seedMany([
      { id: "zh", subject: "发票", body: "这是一封测试邮件", receivedAt: 3000 },
      { id: "zh-trashed", body: "另一封测试邮件", receivedAt: 2000, trashed: true },
      { id: "en", subject: "Invoice", body: "monthly invoice attached", receivedAt: 1000 },
    ]);
    expect(await ids(client, `/api/search?q=${encodeURIComponent("邮件")}`)).toEqual(["zh"]);
    expect(await ids(client, `/api/search?q=${encodeURIComponent("测试邮件")}`)).toEqual(["zh"]);
    expect(await ids(client, "/api/search?q=invoice")).toEqual(["en"]);
    expect(await ids(client, "/api/search?q=nothing")).toEqual([]);
    await client.json("GET", "/api/search?q=%20", undefined, 400);
    await client.json("GET", `/api/search?q=${"x".repeat(201)}`, undefined, 400);
    await client.json("GET", "/api/search?q=invoice&cursor=bad", undefined, 400);
  });

  it("pages search results newest first", async () => {
    const { client } = await setupOwner();
    await seedMany(
      Array.from({ length: 55 }, (_, i) => ({
        id: `s${String(i).padStart(2, "0")}`,
        body: "quarterly report",
        receivedAt: 1000 + i,
      })),
    );
    const first = await client.json("GET", "/api/search?q=report");
    expect((first.messages as Item[]).length).toBe(50);
    expect((first.messages as Item[])[0]?.id).toBe("s54");
    const second = await client.json(
      "GET",
      `/api/search?q=report&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );
    expect((second.messages as Item[]).map((m) => m.id)).toEqual([
      "s04",
      "s03",
      "s02",
      "s01",
      "s00",
    ]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("counts", () => {
  it("counts unread mail per folder and per inbox address", async () => {
    const { client } = await setupOwner();
    await seedMany([
      { id: "1", addressId: 1 },
      { id: "2", addressId: 1, starred: true },
      { id: "3", addressId: 2 },
      { id: "4", addressId: 2, read: true },
      { id: "5", addressId: 2, archived: true },
      { id: "6", addressId: 3, trashed: true, starred: true },
    ]);
    expect(await client.json("GET", "/api/counts")).toEqual({
      folders: { inbox: 3, starred: 1, archive: 1, spam: 0, trash: 1 },
      addresses: { "1": 2, "2": 1 },
    });
  });

  it("answers zeros for an empty mailbox", async () => {
    const { client } = await setupOwner();
    expect(await client.json("GET", "/api/counts")).toEqual({
      folders: { inbox: 0, starred: 0, archive: 0, spam: 0, trash: 0 },
      addresses: {},
    });
  });
});

describe("cross-site requests", () => {
  it("refuses a flag change from another origin", async () => {
    const { client } = await setupOwner();
    await seedMessage({ id: "x" });
    const res = await exports.default.fetch(`${ORIGIN}/api/messages/x`, {
      method: "PATCH",
      headers: {
        origin: "https://evil.example",
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        "content-type": "application/json",
      },
      body: JSON.stringify({ trashed: true }),
    });
    expect(res.status).toBe(403);
  });

  it("answers 401 to a client without a session", async () => {
    await seedMessage({ id: "x" });
    expect((await new Client().request("GET", "/api/messages/x/raw")).status).toBe(401);
  });
});
