import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Migration 0016 on a database that already holds rows (worker/AGENTS.md, "Compatibility"). The
// second database starts empty in this file; the main one is migrated by the setup file.

const db = env.RESTORE_DB;
const before = env.TEST_MIGRATIONS.filter((m) => m.name < "0016");
const m0016 = env.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0016"));

/** A messages row; `seq` undefined leaves the column out, as email() does. */
const insert = (id: string, receivedAt: number, seq?: number) =>
  db
    .prepare(
      `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to, raw_size,
         r2_key, received_at${seq === undefined ? "" : ", seq"})
       VALUES (?, 1, 'in', 'parsed', 'a@b.c', 'd@e.f', 1, ?, ?${seq === undefined ? "" : ", ?"})`,
    )
    .bind(id, `raw/${id}`, receivedAt, ...(seq === undefined ? [] : [seq]));

describe("migration 0016", () => {
  it("numbers existing rows in (received_at, id) order and later inserts above them", async () => {
    await applyD1Migrations(db, before);
    // Inserted out of order; two share a received_at, so the id breaks the tie.
    await db.batch([
      insert("c", 3000),
      insert("b2", 2000),
      insert("a", 1000),
      insert("b1", 2000),
      db.prepare(
        `INSERT INTO rules (name, position, match, conditions, trash, created_at, updated_at)
         VALUES ('r', 1, 'all', '[]', 1, 1, 1)`,
      ),
    ]);
    await db.prepare("UPDATE messages SET trashed = 1, trashed_at = 5 WHERE id = 'c'").run();

    await applyD1Migrations(db, m0016);

    const { results } = await db
      .prepare(
        "SELECT id, seq, spam, spam_at, from_key, trashed, trashed_at FROM messages ORDER BY seq",
      )
      .all();
    expect(results).toEqual([
      { id: "a", seq: 1, spam: 0, spam_at: null, from_key: null, trashed: 0, trashed_at: null },
      { id: "b1", seq: 2, spam: 0, spam_at: null, from_key: null, trashed: 0, trashed_at: null },
      { id: "b2", seq: 3, spam: 0, spam_at: null, from_key: null, trashed: 0, trashed_at: null },
      { id: "c", seq: 4, spam: 0, spam_at: null, from_key: null, trashed: 1, trashed_at: 5 },
    ]);
    expect(await db.prepare("SELECT name, value FROM counters").all()).toMatchObject({
      results: [{ name: "messages_seq", value: 4 }],
    });
    expect(await db.prepare("SELECT trash, spam FROM rules").first()).toEqual({
      trash: 1,
      spam: 0,
    });

    // A new row, even one with an older received_at, gets the next value; an explicit seq (a
    // restore) is kept and does not move the counter.
    await insert("late", 500).run();
    await insert("restored", 9000, 77).run();
    await insert("next", 600).run();
    const seqs = await db
      .prepare("SELECT id, seq FROM messages WHERE id IN ('late', 'restored', 'next') ORDER BY id")
      .all();
    expect(seqs.results).toEqual([
      { id: "late", seq: 5 },
      { id: "next", seq: 6 },
      { id: "restored", seq: 77 },
    ]);

    const indexes = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger') AND name IN ('messages_spam_received', 'messages_spam_at', 'messages_seq', 'messages_seq_insert') ORDER BY name",
      )
      .all();
    expect(indexes.results.map((r) => r.name)).toEqual([
      "messages_seq",
      "messages_seq_insert",
      "messages_spam_at",
      "messages_spam_received",
    ]);
  });
});
