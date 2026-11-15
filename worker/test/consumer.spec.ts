import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { handleQueue, MAX_ATTEMPTS, RETRY_DELAY_SECONDS } from "../src/mail/consumer";
import { handleEmail } from "../src/mail/inbound";
import { SLICE_BYTES } from "../src/mail/parse";
import { fixture } from "./fixtures";
import { deeplyNested, largeMessage } from "./fixtures/generated";
import { addAddress, asMessage, inbound, messageRows } from "./mail-helpers";

/** A stored message as email() leaves it, without a queue job. */
async function storeRow(id: string, raw: string | Uint8Array | null) {
  const key = `raw/2026/11/${id}.eml`;
  if (raw !== null) await env.MAIL.put(key, raw);
  await env.DB.prepare(
    `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
       raw_size, r2_key, received_at) VALUES (?, 1, 'in', 'stored', 'env@example.org', 'shop@example.com', ?, ?, ?)`,
  )
    .bind(id, typeof raw === "string" ? raw.length : (raw?.byteLength ?? 0), key, Date.now())
    .run();
}

/** env with an R2 bucket whose reads fail. */
function r2Unavailable(): Env {
  return {
    ...env,
    MAIL: { get: () => Promise.reject(new Error("R2 unavailable")) },
  } as unknown as Env;
}

function batch(...ids: string[]) {
  const messages = ids.map((id) => ({ body: { id }, ack: vi.fn(), retry: vi.fn() }));
  return { messages, batch: { messages } as unknown as MessageBatch<InboundJob> };
}

async function row(id: string) {
  return env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
}

async function ftsRows(id: string) {
  const { results } = await env.DB.prepare("SELECT * FROM messages_fts WHERE message_id = ?")
    .bind(id)
    .all();
  return results;
}

describe("queue consumer", () => {
  it("writes the parsed headers to the row and the text to the FTS index", async () => {
    await storeRow("mixed", fixture("mixed-attachment"));
    await storeRow("plain", fixture("plain"));
    const { messages, batch: b } = batch("mixed", "plain");
    await handleQueue(b, env);
    for (const m of messages) expect(m.ack).toHaveBeenCalledOnce();
    expect(await row("mixed")).toMatchObject({
      status: "parsed",
      message_id_hdr: "<mixed-attachment@example.org>",
      in_reply_to: null,
      references_hdr: null,
      thread_key: "<mixed-attachment@example.org>",
      subject: "With attachment",
      from_hdr: "Sender Name <sender@example.org>",
      to_hdr: "shop@example.com",
      cc_hdr: "Copy <copy@example.net>",
      date_hdr: "2026-11-16T08:00:00.000Z",
      snippet: "See the attached report.",
      has_attachments: 1,
    });
    expect(await row("plain")).toMatchObject({
      in_reply_to: "<parent@example.org>",
      references_hdr: "<root@example.org> <parent@example.org>",
      thread_key: "<root@example.org>",
      has_attachments: 0,
    });
    expect(await ftsRows("mixed")).toEqual([
      {
        message_id: "mixed",
        subject: "With attachment",
        sender: "Sender Name <sender@example.org>",
        body: "See the attached report.",
      },
    ]);
  });

  it("finds a parsed message with MATCH, CJK text included", async () => {
    await storeRow("zh", fixture("gbk"));
    await storeRow("en", fixture("plain"));
    await handleQueue(batch("zh", "en").batch, env);
    const search = async (q: string) =>
      (
        await env.DB.prepare("SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?")
          .bind(q)
          .all<{ message_id: string }>()
      ).results.map((r) => r.message_id);
    expect(await search('"测试邮件"')).toEqual(["zh"]);
    expect(await search('subject:"测试主"')).toEqual(["zh"]);
    expect(await search('"plain fixture"')).toEqual(["en"]);
  });

  it("is idempotent on redelivery", async () => {
    await storeRow("m", fixture("plain"));
    await handleQueue(batch("m").batch, env);
    const first = await row("m");
    const get = vi.spyOn(env.MAIL, "get");
    const again = batch("m", "m");
    await handleQueue(again.batch, env);
    for (const m of again.messages) expect(m.ack).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
    expect(await row("m")).toEqual(first);
    expect(await ftsRows("m")).toHaveLength(1);
  });

  it("writes one FTS row when two deliveries of a job run at once", async () => {
    await storeRow("c", fixture("plain"));
    await Promise.all([handleQueue(batch("c").batch, env), handleQueue(batch("c").batch, env)]);
    expect(await ftsRows("c")).toHaveLength(1);
    expect((await row("c"))?.status).toBe("parsed");
  });

  it("indexes the envelope sender when the message has no From header", async () => {
    await storeRow("nofrom", "Subject: Anonymous\r\n\r\nNo sender header.\r\n");
    await handleQueue(batch("nofrom").batch, env);
    expect(await ftsRows("nofrom")).toMatchObject([{ sender: "env@example.org" }]);
    expect((await row("nofrom"))?.from_hdr).toBeNull();
  });

  it("acks a job whose row is gone", async () => {
    const { messages, batch: b } = batch("missing");
    await handleQueue(b, env);
    expect(messages[0]?.ack).toHaveBeenCalledOnce();
  });

  it("marks a message the bounded parse refuses as parse_failed and keeps it", async () => {
    await storeRow("deep", deeplyNested(40));
    const { messages, batch: b } = batch("deep");
    await handleQueue(b, env);
    expect(messages[0]?.ack).toHaveBeenCalledOnce();
    expect(await row("deep")).toMatchObject({ status: "parse_failed", subject: null });
    expect(await ftsRows("deep")).toEqual([]);
    expect(await env.MAIL.head("raw/2026/11/deep.eml")).not.toBeNull();
  });

  it("marks a message whose raw object is missing as parse_failed", async () => {
    await storeRow("gone", null);
    await handleQueue(batch("gone").batch, env);
    expect((await row("gone"))?.status).toBe("parse_failed");
  });

  it("retries later on a transient storage error", async () => {
    await storeRow("t", fixture("plain"));
    const { messages, batch: b } = batch("t");
    await handleQueue(b, r2Unavailable());
    expect(messages[0]?.ack).not.toHaveBeenCalled();
    expect(messages[0]?.retry).toHaveBeenCalledWith({ delaySeconds: RETRY_DELAY_SECONDS });
    expect((await row("t"))?.status).toBe("stored");
  });

  it("gives up after five failed tries and keeps the raw message", async () => {
    await storeRow("f", fixture("plain"));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { messages, batch: b } = batch("f");
      await handleQueue(b, r2Unavailable());
      const last = attempt === MAX_ATTEMPTS;
      expect(messages[0]?.ack, `attempt ${attempt}`).toHaveBeenCalledTimes(last ? 1 : 0);
      expect(messages[0]?.retry, `attempt ${attempt}`).toHaveBeenCalledTimes(last ? 0 : 1);
    }
    expect(await row("f")).toMatchObject({ status: "parse_failed", attempts: MAX_ATTEMPTS });
    expect(await env.MAIL.head("raw/2026/11/f.eml")).not.toBeNull();
  });

  it("parses on the third try after two failures", async () => {
    await storeRow("s", fixture("plain"));
    await handleQueue(batch("s").batch, r2Unavailable());
    await handleQueue(batch("s").batch, r2Unavailable());
    await handleQueue(batch("s").batch, env);
    expect(await row("s")).toMatchObject({
      status: "parsed",
      attempts: 3,
      subject: "Plain text message",
    });
  });

  it("counts a try the CPU limit killed: the next delivery past the limit gives up unparsed", async () => {
    await storeRow("k", fixture("plain"));
    await env.DB.prepare("UPDATE messages SET attempts = ? WHERE id = 'k'")
      .bind(MAX_ATTEMPTS)
      .run();
    const get = vi.spyOn(env.MAIL, "get");
    const { messages, batch: b } = batch("k");
    await handleQueue(b, env);
    expect(messages[0]?.ack).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
    expect(await row("k")).toMatchObject({ status: "parse_failed", attempts: MAX_ATTEMPTS + 1 });
  });

  it("reads only the first 256 KB of a 20 MiB message, end to end", async () => {
    await addAddress("shop");
    const raw = largeMessage();
    expect(raw.byteLength).toBeGreaterThan(20 * 1024 * 1024 - 100);
    const get = vi.spyOn(env.MAIL, "get");
    await handleEmail(asMessage(inbound("shop@example.com", raw)), env);
    await vi.waitFor(async () => expect((await messageRows())[0]?.status).toBe("parsed"), {
      timeout: 4000,
      interval: 25,
    });
    const [r] = await messageRows();
    expect(r).toMatchObject({
      subject: "Large attachment",
      has_attachments: 1,
      raw_size: raw.byteLength,
    });
    expect((await env.MAIL.head(r?.r2_key ?? ""))?.size).toBe(raw.byteLength);
    expect(get).toHaveBeenCalledWith(r?.r2_key, { range: { offset: 0, length: SLICE_BYTES } });
  });
});
