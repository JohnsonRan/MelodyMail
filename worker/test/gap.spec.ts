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
    expect(report).toMatchObject({ listed: 4, after: 3, present: 1 });
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
});
