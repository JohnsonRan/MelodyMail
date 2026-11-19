import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import openapi from "../src/api/openapi.json";
import { FOLDERS } from "../src/mail/folders";
import { apiKey, v1 } from "./api-helpers";
import type { Client } from "./helpers";

import { seedMany, seedMessage } from "./mailbox-helpers";
import { signedIn } from "./send-helpers";

// The Spam folder (docs/M8-mailbox-ux.md, section 4 and decision 6), worker side.

type FlagRow = {
  read: number;
  archived: number;
  trashed: number;
  trashed_at: number | null;
  spam: number;
  spam_at: number | null;
};

async function flags(id: string): Promise<FlagRow | null> {
  return env.DB.prepare(
    "SELECT read, archived, trashed, trashed_at, spam, spam_at FROM messages WHERE id = ?",
  )
    .bind(id)
    .first<FlagRow>();
}

async function senders() {
  return (
    await env.DB.prepare("SELECT address, created_at FROM spam_senders ORDER BY address").all<{
      address: string;
      created_at: number;
    }>()
  ).results;
}

const listSender = (address: string) =>
  env.DB.prepare("INSERT INTO spam_senders (address, created_at) VALUES (?, 1)")
    .bind(address)
    .run();

async function ids(client: Client, path: string): Promise<string[]> {
  const data = await client.json("GET", path);
  return (data.messages as { id: string }[]).map((m) => m.id).sort();
}

describe("transition policy", () => {
  it("entering Spam clears Archive and Trash and starts spam_at, kept while it stays", async () => {
    const client = await signedIn();
    await seedMany([
      { id: "a", archived: true },
      { id: "t", trashed: true, trashedAt: 5 },
    ]);
    const before = Date.now();
    await client.json("PATCH", "/api/messages", { ids: ["a", "t"], spam: true });
    for (const id of ["a", "t"]) {
      const row = (await flags(id)) as FlagRow;
      expect(row).toMatchObject({ spam: 1, archived: 0, trashed: 0, trashed_at: null });
      expect(row.spam_at).toBeGreaterThanOrEqual(before);
    }
    await env.DB.prepare("UPDATE messages SET spam_at = 7").run();
    await client.json("PATCH", "/api/messages/a", { spam: true });
    await client.json("PATCH", "/api/messages", { ids: ["a"], read: true });
    expect(await flags("a")).toMatchObject({ spam: 1, spam_at: 7, read: 1 });
  });

  it("leaves Spam for Trash or Archive; Trash beats Spam and Spam beats Archive", async () => {
    const client = await signedIn();
    await seedMany([
      { id: "s1", spam: true, spamAt: 7 },
      { id: "s2", spam: true, spamAt: 7 },
      { id: "x" },
      { id: "y" },
    ]);
    await client.json("PATCH", "/api/messages/s1", { trashed: true });
    expect(await flags("s1")).toMatchObject({ spam: 0, spam_at: null, trashed: 1 });
    await client.json("PATCH", "/api/messages/s2", { archived: true });
    expect(await flags("s2")).toMatchObject({ spam: 0, spam_at: null, archived: 1 });
    await client.json("PATCH", "/api/messages/x", { trashed: true, spam: true });
    expect(await flags("x")).toMatchObject({ spam: 0, trashed: 1 });
    await client.json("PATCH", "/api/messages/y", { spam: true, archived: true });
    expect(await flags("y")).toMatchObject({ spam: 1, archived: 0 });
  });

  it("lands Not spam in the Inbox, a stale archived flag included", async () => {
    const client = await signedIn();
    await seedMessage({ id: "n", spam: true, spamAt: 7, archived: true });
    await client.json("PATCH", "/api/messages", { ids: ["n"], spam: false });
    expect(await flags("n")).toMatchObject({ spam: 0, spam_at: null, archived: 0 });
    expect(await ids(client, "/api/messages?folder=inbox")).toEqual(["n"]);
  });

  it("never moves an outbound message into Spam", async () => {
    const client = await signedIn();
    await seedMessage({ id: "o", direction: "out", trashed: true, trashedAt: 5 });
    await client.json("PATCH", "/api/messages/o", { spam: true });
    expect(await flags("o")).toMatchObject({ spam: 0, spam_at: null, trashed: 1, trashed_at: 5 });
  });
});

describe("Spam and the other folders", () => {
  it("keeps Spam out of every other folder, search, contacts and the other unread counts", async () => {
    const client = await signedIn();
    const spammer = "Spammer <spammer@junk.example>";
    await seedMany([
      { id: "i", threadKey: "<t>", body: "wonderful offer", receivedAt: 1000 },
      { id: "s", threadKey: "<t>", body: "wonderful offer", receivedAt: 2000, spam: true },
      { id: "s-star", spam: true, starred: true, from: spammer },
      // A stale archived flag on a Spam row (an M7 Worker after a rollback) stays in Spam.
      { id: "s-arch", spam: true, archived: true },
      // Both flags (an M7 Worker after a rollback): Trash, counted and expired there.
      { id: "both", threadKey: "<t>", receivedAt: 3000, spam: true, trashed: true },
    ]);
    expect(await ids(client, "/api/messages?folder=inbox")).toEqual(["i"]);
    expect(await ids(client, "/api/messages?folder=spam")).toEqual(["s", "s-arch", "s-star"]);
    expect(await ids(client, "/api/messages?folder=starred")).toEqual([]);
    expect(await ids(client, "/api/messages?folder=archive")).toEqual([]);
    expect(await ids(client, "/api/messages?folder=trash")).toEqual(["both"]);
    expect(await ids(client, "/api/search?q=wonderful")).toEqual(["i"]);
    expect((await client.json("GET", "/api/contacts?q=spammer")).contacts).toEqual([]);
    expect((await client.json("GET", "/api/counts")).folders).toEqual({
      inbox: 1,
      starred: 0,
      archive: 0,
      spam: 3,
      trash: 1,
    });
    const thread = async (id: string) =>
      ((await client.json("GET", `/api/messages/${id}/thread`)).messages as { id: string }[]).map(
        (m) => m.id,
      );
    expect(await thread("i")).toEqual(["i"]);
    expect(await thread("s")).toEqual(["s"]);
    expect(await thread("both")).toEqual(["both"]);
    const item = (await client.json("GET", "/api/messages/s")).message as { spam: boolean };
    expect(item.spam).toBe(true);
  });

  it("lets the contact scan drop Spam from its window without reading further", async () => {
    const client = await signedIn();
    await seedMessage({ id: "old", from: "Friend <friend@ok.example>", receivedAt: 1 });
    await seedMessage({ id: "new", from: "Friend <friend@ok.example>", spam: true });
    expect((await client.json("GET", "/api/contacts?q=friend")).contacts).toEqual([
      { address: "friend@ok.example", name: "Friend" },
    ]);
  });
});

describe("Report spam and Not spam", () => {
  it("stores the sender with the flag, and Not spam removes the same key", async () => {
    const client = await signedIn();
    await seedMessage({ id: "m", fromKey: "a@junk.example" });
    const before = Date.now();
    await client.json("PATCH", "/api/messages/m", { spam: true });
    const [listed] = await senders();
    expect(listed?.address).toBe("a@junk.example");
    expect(listed?.created_at).toBeGreaterThanOrEqual(before);
    expect((await flags("m"))?.spam).toBe(1);
    await client.json("PATCH", "/api/messages", { ids: ["m"], spam: false });
    expect(await senders()).toEqual([]);
    expect((await flags("m"))?.spam).toBe(0);
  });

  it("learns only from rows that enter Spam and forgets only for rows that leave it", async () => {
    const client = await signedIn();
    await seedMany([
      // Already in Spam: a repeated report after the sender was removed adds nothing.
      { id: "again", spam: true, fromKey: "again@junk.example" },
      // Not in Spam: Not spam forgets nothing.
      { id: "inbox", fromKey: "kept@junk.example" },
      // A sent message never adds the owner's address.
      { id: "sent", direction: "out", fromKey: "me@example.com" },
      // Trash beats Spam: a message moved to Trash does not report its sender.
      { id: "trashed", fromKey: "trashed@junk.example" },
    ]);
    await client.json("PATCH", "/api/messages/trashed", { trashed: true, spam: true });
    await listSender("kept@junk.example");
    await client.json("PATCH", "/api/messages", { ids: ["again", "sent"], spam: true });
    await client.json("PATCH", "/api/messages/inbox", { spam: false });
    expect((await senders()).map((s) => s.address)).toEqual(["kept@junk.example"]);
    expect((await flags("sent"))?.spam).toBe(0);
  });

  it("moves a whole folder to Spam without learning senders", async () => {
    const client = await signedIn();
    await seedMessage({ id: "f", fromKey: "f@junk.example" });
    const { watermark } = await client.json("GET", "/api/messages/count?folder=inbox");
    await client.json("PATCH", "/api/messages", { folder: "inbox", watermark, spam: true });
    expect((await flags("f"))?.spam).toBe(1);
    expect(await senders()).toEqual([]);
  });
});

describe("Settings > Spam senders", () => {
  it("lists the senders newest first and removes one, which files no later mail", async () => {
    const client = await signedIn();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO spam_senders (address, created_at) VALUES ('old@junk.example', 1)",
      ),
      env.DB.prepare(
        "INSERT INTO spam_senders (address, created_at) VALUES ('new@junk.example', 2)",
      ),
    ]);
    expect(await client.json("GET", "/api/spam-senders")).toEqual({
      senders: [
        { address: "new@junk.example", createdAt: 2 },
        { address: "old@junk.example", createdAt: 1 },
      ],
    });
    const body = { address: "new@junk.example" };
    expect(await client.json("DELETE", "/api/spam-senders", body)).toEqual({ removed: true });
    expect(await client.json("DELETE", "/api/spam-senders", body)).toEqual({ removed: false });
    expect((await senders()).map((s) => s.address)).toEqual(["old@junk.example"]);
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_log WHERE event = 'spam_sender_removed'",
    ).all();
    expect(audit.results).toEqual([{ detail: null }]);
    expect((await client.request("DELETE", "/api/spam-senders", { address: 5 })).status).toBe(400);
  });
});

describe("rules with Move to Spam", () => {
  it("saves, updates, lists and tests the spam action", async () => {
    const client = await signedIn();
    const body = {
      name: "Junk",
      match: "all",
      conditions: [{ field: "subject", op: "contains", value: "junk" }],
      spam: true,
    };
    const created = (await client.json("POST", "/api/rules", body, 201)).rule as {
      id: number;
      spam: boolean;
    };
    expect(created.spam).toBe(true);
    const updated = (
      await client.json("PUT", `/api/rules/${created.id}`, { ...body, spam: false, star: true })
    ).rule as { spam: boolean };
    expect(updated.spam).toBe(false);
    await client.json("PUT", `/api/rules/${created.id}`, body);
    expect(((await client.json("GET", "/api/rules")).rules as { spam: boolean }[])[0]?.spam).toBe(
      true,
    );
    await seedMessage({ id: "m", raw: "Subject: junk mail\r\n\r\nbody\r\n" });
    const tested = await client.json("POST", "/api/rules/test", { messageId: "m", rule: body });
    expect(tested).toMatchObject({ matched: true, spam: true, archive: false, trash: false });
  });
});

describe("REST API v1 and Spam", () => {
  it("reads Spam, cannot change a Spam message, and refuses spam and the folder form", async () => {
    const { key } = await apiKey();
    await seedMany([
      { id: "s", spam: true, spamAt: 7 },
      { id: "i", receivedAt: 1 },
    ]);
    const list = (await (await v1(key, "GET", "/messages?folder=spam")).json()) as {
      messages: { id: string; spam: boolean }[];
    };
    expect(list.messages.map((m) => [m.id, m.spam])).toEqual([["s", true]]);

    for (const change of [{ archived: true }, { trashed: true }, { read: true }]) {
      expect((await v1(key, "PATCH", "/messages/s", change)).status).toBe(404);
    }
    const many = await v1(key, "PATCH", "/messages", { ids: ["s", "i"], trashed: true });
    expect(await many.json()).toEqual({ updated: 1 });
    expect(await flags("s")).toMatchObject({
      spam: 1,
      spam_at: 7,
      trashed: 0,
      archived: 0,
      read: 0,
    });

    const refused = [
      ["/messages/i", { spam: true }],
      ["/messages", { ids: ["i"], spam: false }],
      ["/messages", { folder: "inbox", watermark: 99, read: true }],
      ["/messages", { ids: ["i"], watermark: 99, read: true }],
    ] as const;
    for (const [path, body] of refused) {
      expect((await v1(key, "PATCH", path, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await flags("i"))?.read).toBe(0);
  });

  it("documents every folder a key can list", () => {
    const folder = openapi.paths["/messages"].get.parameters.find((p) => p.name === "folder");
    expect(folder?.schema.enum).toEqual(Object.keys(FOLDERS));
  });
});
