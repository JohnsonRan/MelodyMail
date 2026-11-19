import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { handleQueue } from "../src/mail/consumer";
import { handleEmail } from "../src/mail/inbound";
import { addAddress, addRule, asMessage, inbound, messageRows } from "./mail-helpers";
import { seedMessage } from "./mailbox-helpers";

// Filing inbound mail into Spam (docs/M8-mailbox-ux.md, "Filing"): the sender key, the consumer's
// lookup, the rule action, and the Hub event decided from the last write.

type FlagRow = {
  read: number;
  archived: number;
  trashed: number;
  spam: number;
  spam_at: number | null;
};

async function flags(id: string): Promise<FlagRow | null> {
  return env.DB.prepare("SELECT read, archived, trashed, spam, spam_at FROM messages WHERE id = ?")
    .bind(id)
    .first<FlagRow>();
}

const listSender = (address: string) =>
  env.DB.prepare("INSERT INTO spam_senders (address, created_at) VALUES (?, 1)")
    .bind(address)
    .run();

/** env whose Hub records the events instead of delivering them. */
function recordingHub(events: unknown[], base: Env = env): Env {
  return {
    ...base,
    HUB: { getByName: () => ({ notify: async (e: unknown) => events.push(e) }) },
  } as unknown as Env;
}

const queue = (...list: string[]) =>
  ({
    messages: list.map((id) => ({ body: { id }, ack: vi.fn(), retry: vi.fn() })),
  }) as unknown as MessageBatch<InboundJob>;

/** A raw message from `from`, through email() and the consumer; returns the row and the events. */
async function deliver(from: string, subject = "Hello") {
  const raw = `From: ${from}\r\nTo: shop@example.com\r\nSubject: ${subject}\r\n\r\nBody.\r\n`;
  const events: unknown[] = [];
  const hub = recordingHub(events);
  await handleEmail(asMessage(inbound("shop@example.com", raw, { Subject: subject })), hub);
  const rows = await messageRows();
  const row = rows.at(-1) as Record<string, unknown> & { id: string };
  const atArrival = { spam: row.spam, from_key: row.from_key };
  await handleQueue(queue(row.id), hub);
  return { id: row.id, atArrival, events };
}

describe("filing inbound mail", () => {
  it("files mail from a listed sender in the consumer, with filed and no push", async () => {
    await addAddress("shop");
    vi.spyOn(env.INBOUND, "send").mockResolvedValue(undefined as never);
    await listSender("bad@junk.example");
    const bad = await deliver("Bad <BAD@Junk.Example>");
    // email() runs the rules only; the sender is looked up when the consumer has the parse.
    expect(bad.atArrival).toEqual({ spam: 0, from_key: null });
    expect(await flags(bad.id)).toMatchObject({ spam: 1, archived: 0, trashed: 0 });
    expect((await flags(bad.id))?.spam_at).toEqual(expect.any(Number));
    expect(bad.events).toEqual([{ type: "filed", id: bad.id }]);

    const good = await deliver("Good <good@ok.example>");
    expect((await flags(good.id))?.spam).toBe(0);
    expect(good.events).toEqual([{ type: "message", id: good.id }]);
    const keys = await env.DB.prepare(
      "SELECT id, from_key FROM messages ORDER BY received_at",
    ).all();
    expect(keys.results.map((r) => r.from_key)).toEqual(["bad@junk.example", "good@ok.example"]);
  });

  it("keys a From with a long display name by its address", async () => {
    await addAddress("shop");
    vi.spyOn(env.INBOUND, "send").mockResolvedValue(undefined as never);
    await listSender("long@junk.example");
    const { id, events } = await deliver(`"${"N".repeat(1200)}" <Long@Junk.Example>`);
    const row = await env.DB.prepare("SELECT from_hdr, from_key, spam FROM messages WHERE id = ?")
      .bind(id)
      .first<{ from_hdr: string; from_key: string; spam: number }>();
    expect(row?.from_hdr).toHaveLength(998);
    expect(row?.from_hdr).not.toContain("@");
    expect(row).toMatchObject({ from_key: "long@junk.example", spam: 1 });
    expect(events).toEqual([{ type: "filed", id }]);
  });

  it("leaves a listed sender's mail where a rule put it", async () => {
    await addAddress("shop");
    vi.spyOn(env.INBOUND, "send").mockResolvedValue(undefined as never);
    await listSender("bad@junk.example");
    await addRule({
      conditions: [{ field: "subject", op: "equals", value: "keep" }],
      archive: true,
    });
    const { id, events } = await deliver("bad@junk.example", "keep");
    expect(await flags(id)).toMatchObject({ spam: 0, archived: 1 });
    expect(events).toEqual([{ type: "changed", id }]);
  });

  it("decides the event from the last write: a failed parse notifies as before", async () => {
    await seedMessage({ id: "fail", status: "stored", raw: null });
    await seedMessage({ id: "fail-archived", status: "stored", raw: null, archived: true });
    const events: unknown[] = [];
    await handleQueue(queue("fail", "fail-archived"), recordingHub(events));
    expect(events).toEqual([
      { type: "message", id: "fail" },
      { type: "changed", id: "fail-archived" },
    ]);
  });

  it("notifies nothing when the last write changed no row", async () => {
    await seedMessage({ id: "dup", status: "stored", raw: "Subject: x\r\n\r\nbody\r\n" });
    const events: unknown[] = [];
    // A duplicate delivery finishes the parse while this one reads the raw message.
    const racing = {
      ...env,
      MAIL: {
        get: async (key: string, options: R2GetOptions) => {
          await env.DB.prepare("UPDATE messages SET status = 'parsed' WHERE id = 'dup'").run();
          return env.MAIL.get(key, options);
        },
      },
    } as unknown as Env;
    const job = queue("dup");
    await handleQueue(job, recordingHub(events, racing));
    expect(events).toEqual([]);
    // Handled, not failed and retried.
    expect(job.messages[0]?.ack).toHaveBeenCalledOnce();
    expect(job.messages[0]?.retry).not.toHaveBeenCalled();
  });

  it("files mail a Move to Spam rule matches on arrival; Trash beats it", async () => {
    await addAddress("shop");
    vi.spyOn(env.INBOUND, "send").mockResolvedValue(undefined as never);
    await addRule({ conditions: [{ field: "subject", op: "equals", value: "spam" }], spam: true });
    await addRule({
      conditions: [{ field: "subject", op: "equals", value: "both" }],
      spam: true,
      trash: true,
    });
    const spam = await deliver("x@ok.example", "spam");
    const row = await env.DB.prepare("SELECT spam, spam_at, received_at FROM messages WHERE id = ?")
      .bind(spam.id)
      .first<{ spam: number; spam_at: number; received_at: number }>();
    expect(row?.spam).toBe(1);
    expect(row?.spam_at).toBeGreaterThanOrEqual(row?.received_at as number);
    expect(spam.events).toEqual([{ type: "changed", id: spam.id }]);
    const both = await deliver("x@ok.example", "both");
    expect(await flags(both.id)).toMatchObject({ spam: 0, trashed: 1 });
    // Spam beats Archive.
    await addRule({
      conditions: [{ field: "subject", op: "equals", value: "arch" }],
      spam: true,
      archive: true,
    });
    const arch = await deliver("x@ok.example", "arch");
    expect(await flags(arch.id)).toMatchObject({ spam: 1, archived: 0 });
  });
});
