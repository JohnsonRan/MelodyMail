import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { findGap, gapSql, monthPrefixes } from "../src/backup/gap";
import { requeueStored, STUCK_AFTER_MS } from "../src/mail/consumer";
import { handleEmail } from "../src/mail/inbound";
import { addAddress, asMessage, inbound, messageRows } from "./mail-helpers";

/** Applies the gap SQL as `wrangler d1 execute --file` would. */
async function apply(sql: string) {
  const statements = sql.split(";\n").filter((s) => s.trim() !== "");
  if (statements.length > 0) await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}

describe("gap tool", () => {
  it("lists the months from the one before the restore point to now", () => {
    expect(monthPrefixes(Date.UTC(2026, 0, 10), Date.UTC(2026, 2, 1))).toEqual([
      "raw/2025/12/",
      "raw/2026/01/",
      "raw/2026/02/",
      "raw/2026/03/",
    ]);
  });

  it("stores mail received after the restore point again, which the consumer then parses", async () => {
    const shop = await addAddress("shop");
    const send = (from: string, to = "shop@example.com") => {
      const message = inbound(to);
      message.from = from;
      return handleEmail(asMessage(message), env);
    };
    vi.spyOn(env.INBOUND, "send").mockResolvedValue(undefined as never);
    await send("before@example.org");
    await new Promise((r) => setTimeout(r, 20));
    const since = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    await send("o'brien.ü@例え.jp", "shop+news@example.com");
    await send("kept@example.org");
    // A restore to `since` lost the first of the later rows; the other one is still there.
    const lost = (await messageRows()).find((r) => r.envelope_from === "o'brien.ü@例え.jp");
    await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(lost?.id).run();
    // An object stored before the metadata existed.
    await env.MAIL.put(`raw/2026/11/${crypto.randomUUID()}.eml`, "Subject: old\r\n\r\nx\r\n");

    const report = await findGap(env, since);
    // The overlap lists the earlier message too; it has a row.
    expect(report).toMatchObject({ listed: 4, after: 4, present: 2 });
    expect(report.skipped).toEqual([
      { key: expect.stringMatching(/^raw\//), reason: "no_metadata" },
    ]);
    expect(report.rows).toEqual([
      {
        id: lost?.id,
        key: lost?.r2_key,
        addressId: shop,
        envelopeFrom: "o'brien.ü@例え.jp",
        envelopeTo: "shop+news@example.com",
        tag: "news",
        size: lost?.raw_size,
        receivedAt: lost?.received_at,
      },
    ]);

    // Applying the SQL twice stores the row once; nothing is missing afterwards.
    const sql = gapSql(report.rows);
    await apply(sql);
    await apply(sql);
    const rebuilt = (await messageRows()).find((r) => r.id === lost?.id);
    expect(rebuilt).toMatchObject({
      status: "stored",
      direction: "in",
      address_id: shop,
      envelope_from: "o'brien.ü@例え.jp",
      subaddress_tag: "news",
      read: 0,
    });
    expect((await findGap(env, since)).rows).toEqual([]);

    // The cron re-enqueues it and the real consumer parses the raw object.
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("outbound fetch is off in tests"));
    await requeueStored(env, (lost?.received_at as number) + STUCK_AFTER_MS);
    await vi.waitFor(
      async () => {
        const row = (await messageRows()).find((r) => r.id === lost?.id);
        expect(row?.status).toBe("parsed");
        expect(row?.subject).toBe("Hello");
      },
      { timeout: 4000, interval: 25 },
    );
  });

  const put = (key: string, meta?: Record<string, string>) =>
    env.MAIL.put(key, "Subject: x\r\n\r\nx\r\n", meta ? { customMetadata: meta } : {});
  const meta = (fields: Record<string, string> = {}) => ({
    addressId: "1",
    envelopeFrom: "a%40example.org",
    envelopeTo: "shop%40example.com",
    receivedAt: "1794800000000",
    ...fields,
  });
  const month = () => {
    const d = new Date();
    return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };

  it("rebuilds an empty sender, and skips bad keys, bad numbers, undecodable values and NULs", async () => {
    const since = Date.now() - 1000;
    const id = () => crypto.randomUUID();
    const good = `raw/${month()}/${id()}.eml`;
    await put(good, meta({ envelopeFrom: "" }));
    const bad = {
      key: `raw/${month()}/not-a-uuid.eml`,
      number: `raw/${month()}/${id()}.eml`,
      decode: `raw/${month()}/${id()}.eml`,
      nul: `raw/${month()}/${id()}.eml`,
      to: `raw/${month()}/${id()}.eml`,
      received: `raw/${month()}/${id()}.eml`,
      empty: `raw/${month()}/${id()}.eml`,
    };
    await put(bad.key, meta());
    // Number("") is 0, a safe integer: only the digit check refuses it.
    await put(bad.number, meta({ addressId: "" }));
    await put(bad.decode, meta({ envelopeTo: "%E0%A4%A" }));
    await put(bad.nul, meta({ envelopeFrom: "a%00b" }));
    await put(bad.to, meta({ envelopeTo: "" }));
    await put(bad.received, meta({ receivedAt: "" }));
    // Fields present but empty are bad metadata; only absent fields mean "before M7".
    await put(bad.empty, meta({ addressId: "", envelopeTo: "" }));
    const report = await findGap(env, since);
    expect(report.rows.map((r) => [r.key, r.envelopeFrom])).toEqual([[good, ""]]);
    const reasons = Object.fromEntries(report.skipped.map((s) => [s.key, s.reason]));
    expect(reasons).toEqual({
      [bad.key]: "bad_key",
      [bad.number]: "bad_metadata",
      [bad.decode]: "bad_metadata",
      [bad.nul]: "bad_metadata",
      [bad.to]: "bad_metadata",
      [bad.received]: "bad_metadata",
      [bad.empty]: "bad_metadata",
    });
    await apply(gapSql(report.rows));
    expect((await messageRows())[0]).toMatchObject({ envelope_from: "", status: "stored" });
  });

  it("lists from 10 minutes before the restore point", async () => {
    const key = `raw/${month()}/${crypto.randomUUID()}.eml`;
    await put(key, meta());
    const now = Date.now();
    expect((await findGap(env, now + 9 * 60 * 1000, now)).rows.map((r) => r.key)).toEqual([key]);
    expect((await findGap(env, now + 11 * 60 * 1000, now)).rows).toEqual([]);
  });

  it("follows the list cursor past 1,000 objects", async () => {
    const objects = Array.from({ length: 1005 }, () => ({
      key: `raw/${month()}/${crypto.randomUUID()}.eml`,
      uploaded: new Date(),
      size: 1,
      customMetadata: meta(),
    }));
    const list = vi.fn(async (options?: R2ListOptions) => {
      if (options?.prefix !== `raw/${month()}/`) return { objects: [], truncated: false };
      return options.cursor === "c1"
        ? { objects: objects.slice(1000), truncated: false }
        : { objects: objects.slice(0, 1000), truncated: true, cursor: "c1" };
    });
    const MAIL = { list } as unknown as R2Bucket;
    const report = await findGap({ MAIL, DB: env.DB }, Date.now() - 1000);
    expect(report.rows).toHaveLength(1005);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ cursor: "c1" }));
  });

  it("reports sent mail without a row and writes nothing that sends or notifies", async () => {
    const since = Date.now() - 1000;
    const sent = `sent/${month()}/${crypto.randomUUID()}.json`;
    await env.MAIL.put(sent, "{}");
    const inboundKey = `raw/${month()}/${crypto.randomUUID()}.eml`;
    await put(inboundKey, meta());
    const send = vi.spyOn(env.INBOUND, "send");
    const report = await findGap(env, since);
    expect(report.sentNotRebuilt).toEqual([{ key: sent, uploaded: expect.any(Number) }]);
    expect(report.rows.map((r) => r.key)).toEqual([inboundKey]);
    const sql = gapSql(report.rows);
    expect(sql).not.toContain("'out'");
    await apply(sql);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect((await messageRows()).map((r) => r.direction)).toEqual(["in"]);
  });
});
