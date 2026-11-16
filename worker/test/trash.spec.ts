import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { handleScheduled } from "../src/mail/consumer";
import { handleEmail } from "../src/mail/inbound";
import { deleteFromTrash, expireTrash, TRASH_EXPIRE_MAX, TRASH_KEEP_MS } from "../src/mail/trash";
import { setupOwner } from "./helpers";
import { addAddress, addRule, asMessage, inbound, messageRows } from "./mail-helpers";
import { rawKey, seedMessage } from "./mailbox-helpers";

const DAY = 24 * 60 * 60 * 1000;

async function trashedAt(id: string): Promise<number | null | undefined> {
  const row = await env.DB.prepare("SELECT trashed_at AS t FROM messages WHERE id = ?")
    .bind(id)
    .first<{ t: number | null }>();
  return row?.t;
}

async function seedTrashed(id: string, at: number | null) {
  await seedMessage({ id, trashed: true, body: `text of ${id}` });
  await env.DB.prepare("UPDATE messages SET trashed_at = ? WHERE id = ?").bind(at, id).run();
}

describe("automatic Trash clean-up", () => {
  it("deletes mail in Trash for 30 days through the permanent delete, and nothing else", async () => {
    const now = Date.now();
    await seedTrashed("old", now - TRASH_KEEP_MS);
    await seedTrashed("young", now - TRASH_KEEP_MS + 1);
    await seedTrashed("day29", now - 29 * DAY);
    await seedMessage({ id: "inbox", body: "inbox text" });
    // Not in Trash, with a stale time: never deleted.
    await env.DB.prepare("UPDATE messages SET trashed_at = 1 WHERE id = 'inbox'").run();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await handleScheduled({ scheduledTime: now } as ScheduledController, env);

    expect((await messageRows()).map((r) => r.id).sort()).toEqual(["day29", "inbox", "young"]);
    expect(
      (await env.DB.prepare("SELECT message_id AS id FROM messages_fts ORDER BY 1").all()).results,
    ).toEqual([{ id: "day29" }, { id: "inbox" }, { id: "young" }]);
    expect(await env.MAIL.head(rawKey("old"))).toBeNull();
    expect(await env.MAIL.head(rawKey("young"))).not.toBeNull();
    expect(await env.MAIL.head(rawKey("inbox"))).not.toBeNull();
    expect(info.mock.calls.join(" ")).toContain(
      '{"level":"info","event":"trash_expired","count":1}',
    );
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_log WHERE event = 'trash_expired'",
    ).all();
    expect(audit.results).toEqual([{ detail: "1" }]);
  });

  it("deletes at most 100 per run, oldest first", async () => {
    const now = Date.now();
    const insert = env.DB.prepare(
      `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
         raw_size, r2_key, trashed, trashed_at, received_at)
       VALUES (?, 1, 'in', 'parsed', 'a@b.c', 'd@e.f', 1, ?, 1, ?, 1)`,
    );
    await env.DB.batch(
      Array.from({ length: TRASH_EXPIRE_MAX + 1 }, (_, i) =>
        insert.bind(`t${i}`, rawKey(`t${i}`), now - TRASH_KEEP_MS - i),
      ),
    );
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await expireTrash(env, now)).toBe(TRASH_EXPIRE_MAX);
    expect((await messageRows()).map((r) => r.id)).toEqual(["t0"]);
    expect(await expireTrash(env, now)).toBe(1);
  });

  it("starts the clock for a Trash row without a time, and keeps one restored meanwhile", async () => {
    const now = Date.now();
    await seedTrashed("untimed", null);
    expect(await expireTrash(env, now)).toBe(0);
    expect(await trashedAt("untimed")).toBe(now);

    await seedTrashed("restored", now - TRASH_KEEP_MS - 1);
    await env.DB.prepare(
      "UPDATE messages SET trashed = 0, trashed_at = NULL WHERE id = 'restored'",
    ).run();
    expect(await deleteFromTrash(env, ["restored", "untimed"], now - TRASH_KEEP_MS)).toEqual([]);
    expect(await messageRows()).toHaveLength(2);
  });

  it("stamps the time a message enters Trash, keeps it there, and clears it when it leaves", async () => {
    const { client } = await setupOwner();
    await seedMessage({ id: "m" });
    // A change that does not touch Trash leaves the clock unset.
    await client.json("PATCH", "/api/messages/m", { read: true });
    expect(await trashedAt("m")).toBeNull();
    const before = Date.now();
    await client.json("PATCH", "/api/messages/m", { trashed: true });
    const first = (await trashedAt("m")) as number;
    expect(first).toBeGreaterThanOrEqual(before);
    // Another change, or moving it to Trash again, keeps the time.
    await env.DB.prepare("UPDATE messages SET trashed_at = 5 WHERE id = 'm'").run();
    await client.json("PATCH", "/api/messages", { ids: ["m"], read: true });
    await client.json("PATCH", "/api/messages", { ids: ["m"], trashed: true });
    expect(await trashedAt("m")).toBe(5);
    await client.json("PATCH", "/api/messages/m", { trashed: false });
    expect(await trashedAt("m")).toBeNull();
    await client.json("PATCH", "/api/messages/m", { trashed: true });
    expect(await trashedAt("m")).toBeGreaterThanOrEqual(first);
  });

  it("stamps mail a rule moves to Trash on arrival", async () => {
    await addAddress("shop");
    await addRule({
      conditions: [{ field: "subject", op: "contains", value: "hello" }],
      trash: true,
    });
    await addRule({ conditions: [{ field: "subject", op: "contains", value: "nothing" }] });
    vi.spyOn(env.INBOUND, "send").mockResolvedValue(undefined as never);
    await handleEmail(asMessage(inbound("shop@example.com", undefined, { Subject: "Hello" })), env);
    const [row] = await messageRows();
    expect(row?.trashed).toBe(1);
    expect(row?.trashed_at).toBe(row?.received_at);
  });
});
