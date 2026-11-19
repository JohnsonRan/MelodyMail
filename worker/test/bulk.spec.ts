import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { handleEmail } from "../src/mail/inbound";
import { deletePermanently } from "../src/mail/trash";
import type { Client } from "./helpers";
import { addAddress, asMessage, inbound } from "./mail-helpers";
import { rawKey, seedMany, seedMessage } from "./mailbox-helpers";
import { resendOk, sendBody, sender, signedIn, stubResend } from "./send-helpers";

// Bulk permanent delete, Empty, select all matching (docs/M8-mailbox-ux.md, sections 1 and 2).

type Json = Record<string, unknown>;

const remaining = async () =>
  (await env.DB.prepare("SELECT id FROM messages ORDER BY id").all<{ id: string }>()).results.map(
    (r) => r.id,
  );

const ftsIds = async () =>
  (
    await env.DB.prepare("SELECT message_id AS id FROM messages_fts ORDER BY 1").all<{
      id: string;
    }>()
  ).results.map((r) => r.id);

const audits = async (event: string) =>
  (
    await env.DB.prepare("SELECT detail FROM audit_log WHERE event = ? ORDER BY id")
      .bind(event)
      .all<{ detail: string }>()
  ).results.map((r) => r.detail);

const seqOf = async (id: string) =>
  (await env.DB.prepare("SELECT seq FROM messages WHERE id = ?").bind(id).first<{ seq: number }>())
    ?.seq;

/** `n` rows straight to D1 in one statement; the trigger numbers them in id order. */
async function bulkRows(n: number, prefix: string, columns: Json = {}) {
  const extra = Object.keys(columns);
  await env.DB.prepare(
    `WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < ? - 1)
     INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
       raw_size, r2_key, received_at${extra.map((c) => `, ${c}`).join("")})
     SELECT printf('${prefix}%04d', i), 1, 'in', 'parsed', 'a@b.c', 'd@e.f', 1,
       printf('raw/${prefix}%04d', i), 1000 + i${extra.map(() => ", ?").join("")} FROM k`,
  )
    .bind(n, ...Object.values(columns))
    .run();
}

const count = (client: Client, query: string) =>
  client.json("GET", `/api/messages/count?${query}`) as Promise<{
    total: number;
    watermark: number;
    asOf: number;
  }>;

describe("seq and the count route", () => {
  it("numbers rows from both INSERT sites and counts the view below the counter", async () => {
    await addAddress("shop");
    vi.spyOn(env.INBOUND, "send").mockResolvedValue(undefined as never);
    await handleEmail(asMessage(inbound("shop@example.com")), env);
    const client = await signedIn();
    const from = await sender("me");
    stubResend(() => resendOk("re_1"));
    const sent = (await client.json("POST", "/api/messages/send", sendBody(from))) as {
      message: { id: string };
    };
    const { results } = await env.DB.prepare(
      "SELECT direction, seq FROM messages ORDER BY seq",
    ).all<{ direction: string; seq: number }>();
    expect(results.map((r) => r.direction)).toEqual(["in", "out"]);
    expect(results[1]?.seq).toBe((results[0]?.seq ?? 0) + 1);
    expect(await seqOf(sent.message.id)).toBe(results[1]?.seq);

    const before = Date.now();
    const inboxCount = await count(client, "folder=inbox");
    expect(inboxCount).toEqual({ total: 1, watermark: results[1]?.seq, asOf: expect.any(Number) });
    expect(inboxCount.asOf).toBeGreaterThanOrEqual(before);
    expect((await count(client, "folder=sent")).total).toBe(1);
    expect((await count(client, "folder=inbox&address=999")).total).toBe(0);
    expect((await client.request("GET", "/api/messages/count?folder=junk")).status).toBe(400);
  });
});

describe("folder-form PATCH", () => {
  it("marks 1,200 Inbox messages read in three calls of at most 500", async () => {
    const client = await signedIn();
    await bulkRows(1200, "r");
    const { watermark } = await count(client, "folder=inbox");
    const calls: Json[] = [];
    let after: number | undefined;
    do {
      const res = await client.json("PATCH", "/api/messages", {
        folder: "inbox",
        watermark,
        read: true,
        ...(after === undefined ? {} : { after }),
      });
      calls.push(res);
      after = (res.next as number | null) ?? undefined;
    } while (after !== undefined && calls.length < 10);
    expect(calls.map((c) => c.updated)).toEqual([500, 500, 200]);
    expect(calls.at(-1)?.next).toBeNull();
    const unread = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE read = 0").first(
      "n",
    );
    expect(unread).toBe(0);
  });

  it("moves forward even when every changed row leaves the folder", async () => {
    const client = await signedIn();
    await bulkRows(600, "a");
    const { watermark } = await count(client, "folder=inbox");
    const first = await client.json("PATCH", "/api/messages", {
      folder: "inbox",
      watermark,
      archived: true,
    });
    expect(first).toEqual({ updated: 500, next: watermark - 499 });
    const second = await client.json("PATCH", "/api/messages", {
      folder: "inbox",
      watermark,
      archived: true,
      after: first.next,
    });
    expect(second).toEqual({ updated: 100, next: null });
  });

  it("changes only rows of that folder and address at or below the watermark", async () => {
    const client = await signedIn();
    await seedMany([
      { id: "in-1", addressId: 1 },
      { id: "in-2", addressId: 2 },
      { id: "archived-2", addressId: 2, archived: true },
    ]);
    const { watermark } = await count(client, "folder=inbox&address=2");
    // Stored after the count with an older received_at: above the watermark, left alone.
    await seedMessage({ id: "late-2", addressId: 2, receivedAt: 1 });
    const res = await client.json("PATCH", "/api/messages", {
      folder: "inbox",
      address: 2,
      watermark,
      starred: true,
    });
    expect(res).toEqual({ updated: 1, next: null });
    const starred = await env.DB.prepare("SELECT id FROM messages WHERE starred = 1").all();
    expect(starred.results).toEqual([{ id: "in-2" }]);
  });

  it("refuses a malformed folder form", async () => {
    const client = await signedIn();
    for (const body of [
      { folder: "inbox", read: true },
      { folder: "junk", watermark: 1, read: true },
      { folder: "inbox", watermark: -1, read: true },
      { folder: "inbox", watermark: 1, after: "x", read: true },
      { folder: "inbox", watermark: 1, address: "2", read: true },
      { folder: "inbox", watermark: 1, ids: ["a"], read: true },
      { folder: "inbox", watermark: 1 },
    ]) {
      expect((await client.request("PATCH", "/api/messages", body)).status).toBe(400);
    }
  });
});

describe("bulk permanent delete", () => {
  it("deletes only the listed rows in the named folder, with search rows, raw mail and audit", async () => {
    const client = await signedIn();
    await seedMany([
      { id: "t1", trashed: true, body: "one" },
      { id: "t2", trashed: true, body: "two" },
      { id: "s1", spam: true, body: "spam" },
      { id: "i1", body: "inbox" },
      // Both flags: in Trash, so a Spam delete skips it.
      { id: "both", spam: true, trashed: true },
    ]);
    const trash = await client.json("DELETE", "/api/messages", {
      folder: "trash",
      ids: ["t1", "s1", "i1", "missing"],
    });
    expect(trash).toEqual({ deleted: ["t1"] });
    expect(await env.MAIL.head(rawKey("t1"))).toBeNull();
    expect(await env.MAIL.head(rawKey("s1"))).not.toBeNull();
    const spam = await client.json("DELETE", "/api/messages", {
      folder: "spam",
      ids: ["s1", "t2", "both"],
    });
    expect(spam).toEqual({ deleted: ["s1"] });
    expect(await remaining()).toEqual(["both", "i1", "t2"]);
    expect(await ftsIds()).toEqual(["i1", "t2"]);
    expect(await audits("messages_deleted")).toEqual(["1", "1"]);
    // Nothing deleted: no audit row.
    await client.json("DELETE", "/api/messages", { folder: "trash", ids: ["i1"] });
    expect(await audits("messages_deleted")).toEqual(["1", "1"]);
  });

  it("refuses more than 100 ids and any other folder", async () => {
    const client = await signedIn();
    const ids = Array.from({ length: 101 }, (_, i) => `m${i}`);
    const res = await client.request("DELETE", "/api/messages", { folder: "trash", ids });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "too_many_ids" });
    for (const body of [
      { folder: "inbox", ids: ["a"] },
      { folder: "trash", ids: [] },
      { ids: ["a"] },
    ]) {
      expect((await client.request("DELETE", "/api/messages", body)).status).toBe(400);
    }
  });

  it("keeps a row moved to another folder before the batch", async () => {
    await seedMessage({ id: "moved" });
    for (const folder of ["trash", "spam"] as const) {
      expect(await deletePermanently(env, folder, ["moved"])).toEqual({
        deleted: [],
        hasMore: false,
      });
    }
    expect(await remaining()).toEqual(["moved"]);
  });

  it("deletes one message from Spam, and refuses one outside Trash and Spam", async () => {
    const client = await signedIn();
    await seedMany([{ id: "s", spam: true, body: "x" }, { id: "i" }]);
    expect(await client.json("DELETE", "/api/messages/s")).toEqual({ ok: true });
    expect(await audits("message_deleted")).toEqual(["s"]);
    const res = await client.request("DELETE", "/api/messages/i");
    expect(res.status).toBe(409);
    expect(await remaining()).toEqual(["i"]);
  });
});

describe("purge (Empty Trash and Empty Spam)", () => {
  const OLD = 1_000;

  it("deletes at most 100 per call, oldest first, and reports hasMore", async () => {
    const client = await signedIn();
    await bulkRows(101, "t", { trashed: 1, trashed_at: OLD });
    await env.DB.prepare("UPDATE messages SET trashed_at = trashed_at + received_at").run();
    await seedMessage({ id: "spam", spam: true, spamAt: OLD });
    await seedMessage({ id: "inbox" });
    const { total, watermark, asOf } = await count(client, "folder=trash");
    expect(total).toBe(101);
    const first = await client.json("POST", "/api/messages/purge", {
      folder: "trash",
      watermark,
      asOf,
    });
    expect((first.deleted as string[]).length).toBe(100);
    expect(first.hasMore).toBe(true);
    expect(await remaining()).toEqual(["inbox", "spam", "t0100"]);
    const second = await client.json("POST", "/api/messages/purge", {
      folder: "trash",
      watermark,
      asOf,
    });
    expect(second).toEqual({ deleted: ["t0100"], hasMore: false });
    expect(await audits("trash_emptied")).toEqual(["100", "1"]);
    const third = await client.json("POST", "/api/messages/purge", {
      folder: "trash",
      watermark,
      asOf,
    });
    expect(third).toEqual({ deleted: [], hasMore: false });
    expect(await audits("trash_emptied")).toEqual(["100", "1"]);
  });

  it("keeps rows above the watermark, outside the address, or in the folder since asOf", async () => {
    const client = await signedIn();
    await seedMany([
      { id: "a2-old", addressId: 2, spam: true, spamAt: OLD },
      { id: "a1-old", addressId: 1, spam: true, spamAt: OLD },
      { id: "a2-trash", addressId: 2, trashed: true, trashedAt: OLD },
    ]);
    const { watermark, asOf } = await count(client, "folder=spam&address=2");
    await seedMany([
      // Stored after the dialog opened, with an old clock: above the watermark.
      { id: "a2-late", addressId: 2, spam: true, spamAt: OLD },
      // Filed into Spam at or after asOf, below the watermark.
      { id: "a2-at", addressId: 2, spam: true, spamAt: asOf },
    ]);
    await env.DB.prepare("UPDATE messages SET seq = 1 WHERE id = 'a2-at'").run();
    const res = await client.json("POST", "/api/messages/purge", {
      folder: "spam",
      address: 2,
      watermark,
      asOf,
    });
    expect(res).toEqual({ deleted: ["a2-old"], hasMore: false });
    expect(await audits("spam_emptied")).toEqual(["1"]);
    expect(await remaining()).toEqual(["a1-old", "a2-at", "a2-late", "a2-trash"]);
  });

  it("numbers new mail above every deleted row, so a purge with the old watermark keeps it", async () => {
    const client = await signedIn();
    await seedMany([
      { id: "old-1", trashed: true, trashedAt: OLD },
      { id: "old-2", trashed: true, trashedAt: OLD },
    ]);
    const { watermark, asOf } = await count(client, "folder=trash");
    const body = { folder: "trash", watermark, asOf };
    expect((await client.json("POST", "/api/messages/purge", body)).deleted).toEqual([
      "old-1",
      "old-2",
    ]);
    await seedMessage({ id: "new", trashed: true, trashedAt: OLD });
    expect(await seqOf("new")).toBe(watermark + 1);
    expect(await client.json("POST", "/api/messages/purge", body)).toEqual({
      deleted: [],
      hasMore: false,
    });
    expect(await remaining()).toEqual(["new"]);
  });

  it("refuses a malformed purge", async () => {
    const client = await signedIn();
    for (const body of [
      { folder: "inbox", watermark: 1, asOf: 1 },
      { folder: "trash", asOf: 1 },
      { folder: "trash", watermark: 1 },
      { folder: "trash", watermark: 1, asOf: 1, address: "x" },
    ]) {
      expect((await client.request("POST", "/api/messages/purge", body)).status).toBe(400);
    }
  });
});
