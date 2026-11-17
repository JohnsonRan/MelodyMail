import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { headerAddresses, SCAN_ROWS } from "../src/send/contacts";
import { Client } from "./helpers";
import { seedMessage } from "./mailbox-helpers";
import { sender, signedIn } from "./send-helpers";

// GET /api/contacts (worker/src/send/contacts.ts): compose's recipient suggestions.

type Out = { to?: string; cc?: string; bcc?: string; trashed?: boolean };

function sent(id: string, at: number, h: Out) {
  return env.DB.prepare(
    `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
       from_hdr, to_hdr, cc_hdr, bcc_hdr, raw_size, r2_key, read, trashed, received_at)
     VALUES (?, 1, 'out', 'sent', 'me@example.com', '', 'me@example.com', ?, ?, ?, 0, ?, 1, ?, ?)`,
  )
    .bind(id, h.to ?? null, h.cc ?? null, h.bcc ?? null, `sent/${id}`, h.trashed ? 1 : 0, at)
    .run();
}

async function contacts(client: Client, query: string) {
  const body = await client.json("GET", `/api/contacts?${query}`);
  return body.contacts as { address: string; name: string }[];
}

describe("contacts", () => {
  it("parses stored headers with and without display names", () => {
    expect(
      headerAddresses('Doe, Jane <jane@example.org>, bob@example.org, "Ann" <ann@x.io>'),
    ).toEqual([
      { address: "jane@example.org", name: "Doe, Jane" },
      { address: "bob@example.org", name: "" },
      { address: "ann@x.io", name: "Ann" },
    ]);
  });

  // A scan that retries a run without "@" at every character takes minutes on this input; the
  // linear scan takes milliseconds, far inside the timeout.
  it("parses a long run without @ in linear time", { timeout: 3000 }, () => {
    const run = "a".repeat(200_000);
    expect(headerAddresses(`"${run}" <x@y.io>, ${run} b@y.io`)).toEqual([
      { address: "x@y.io", name: run },
      { address: "b@y.io", name: "" },
    ]);
  });

  it("suggests sent-to and received-from addresses, newest first", async () => {
    const client = await signedIn();
    await sender("me");
    const t = Date.now() - 100_000;
    await seedMessage({ id: "in-old", receivedAt: t, from: "Alice Liddell <alice@wonder.land>" });
    await sent("out-1", t + 1, { to: "bob@example.org", cc: "alice@wonder.land" });
    await seedMessage({ id: "in-new", receivedAt: t + 2, from: "Carol <carol@example.org>" });
    await sent("out-2", t + 3, { bcc: "Dave@Example.org", to: "me@example.com" });
    await seedMessage({ id: "in-me", receivedAt: t + 4, from: "Me <ME@example.com>" });
    await seedMessage({
      id: "in-trash",
      receivedAt: t + 5,
      from: "Eve <eve@example.org>",
      trashed: true,
    });
    await sent("out-trash", t + 6, { to: "mallory@example.org", trashed: true });

    expect(await contacts(client, "q=example")).toEqual([
      { address: "Dave@Example.org", name: "" },
      { address: "carol@example.org", name: "Carol" },
      { address: "bob@example.org", name: "" },
    ]);
    // A name matches, and an address sent to takes its name from older received mail.
    const alice = [{ address: "alice@wonder.land", name: "Alice Liddell" }];
    expect(await contacts(client, "q=LIDDELL")).toEqual(alice);
    expect(await contacts(client, "q=wonder")).toEqual(alice);
    expect(await contacts(client, "q=example&limit=2")).toHaveLength(2);
    expect(await contacts(client, "q=%25")).toEqual([]);
    expect(await contacts(client, "q=eve")).toEqual([]);
    expect(await contacts(client, "q=mallory")).toEqual([]);
  });

  it("reads only the newest messages", async () => {
    const client = await signedIn();
    const t = Date.now() - 1_000_000;
    await seedMessage({ id: "in-oldest", receivedAt: t, from: "Old Friend <old@example.org>" });
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
         from_hdr, raw_size, r2_key, received_at)
       SELECT 'fill-' || i, 1, 'in', 'parsed', 'x@example.net', 'me@example.com',
         'x@example.net', 0, 'raw/' || i, ? + i FROM n`,
    )
      .bind(SCAN_ROWS, t)
      .run();
    expect(await contacts(client, "q=old")).toEqual([]);
    await env.DB.prepare("DELETE FROM messages WHERE id = 'fill-1'").run();
    expect(await contacts(client, "q=old")).toEqual([
      { address: "old@example.org", name: "Old Friend" },
    ]);
  });

  it("refuses a missing query or a bad limit", async () => {
    const client = await signedIn();
    for (const query of [
      "",
      "q=",
      "q=%20",
      `q=${"a".repeat(101)}`,
      "q=a&limit=0",
      "q=a&limit=21",
      "q=a&limit=x",
    ]) {
      expect((await client.request("GET", `/api/contacts?${query}`)).status).toBe(400);
    }
    expect((await new Client().request("GET", "/api/contacts?q=a")).status).toBe(401);
  });
});
