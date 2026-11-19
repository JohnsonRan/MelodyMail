import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { dayStart, RUN_BYTES, runExport } from "../src/backup/export";
import { PAGE_BYTES, partKey, SPLIT_BYTES } from "../src/backup/sql";
import { EXCLUDED, EXPORT_COLUMNS, EXPORTED, INTERNAL_PREFIXES } from "../src/backup/tables";
import {
  DAY,
  exportedRows,
  exportUntilComplete,
  LONG_TEXT,
  latestState,
  loadExport,
  MINUTE,
  PLANTED,
  partTexts,
  readManifest,
  START,
  seedAll,
  statements,
} from "./backup-helpers";
import { seedMessage } from "./mailbox-helpers";

/** Tables and columns the schema holds that neither list decides. */
async function uncovered(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .all<{ name: string }>();
  const problems: string[] = [];
  for (const { name } of results) {
    if (INTERNAL_PREFIXES.some((p) => name.startsWith(p)) || Object.hasOwn(EXCLUDED, name)) {
      continue;
    }
    const table = EXPORTED.find((t) => t.name === name);
    if (!table) {
      problems.push(name);
      continue;
    }
    const { results: cols } = await db
      .prepare("SELECT name FROM pragma_table_info(?)")
      .bind(name)
      .all<{ name: string }>();
    const listed = table.columns.filter((c) => c !== "rowid");
    for (const { name: column } of cols) {
      if (!listed.includes(column)) problems.push(`${name}.${column}`);
    }
    for (const column of listed) {
      if (!cols.some((c) => c.name === column)) problems.push(`${name}.${column} (gone)`);
    }
  }
  return problems;
}

describe("export coverage", () => {
  it("decides every table and column, and fails on a planted table and column", async () => {
    expect(await uncovered(env.DB)).toEqual([]);
    await env.DB.exec("CREATE TABLE planted_table (id INTEGER PRIMARY KEY)");
    await env.DB.exec("ALTER TABLE domains ADD planted_column TEXT");
    try {
      expect(await uncovered(env.DB)).toEqual(["domains.planted_column", "planted_table"]);
    } finally {
      await env.DB.exec("DROP TABLE planted_table");
      await env.DB.exec("ALTER TABLE domains DROP COLUMN planted_column");
    }
  });
});

describe("daily export", () => {
  it("spans runs, writes the manifest last, and round-trips every exported table", async () => {
    await seedAll();
    await runExport(env, START);
    const first = await latestState();
    expect(first?.status).toBe("running");
    expect(await readManifest(first?.id as string)).toBeNull();

    const runs = await exportUntilComplete(START + 15 * MINUTE);
    expect(runs).toBeGreaterThanOrEqual(1);
    const state = await latestState();
    expect(state).toMatchObject({ id: "2026-11-18T0300Z", status: "complete" });
    const manifest = await readManifest(state?.id as string);
    expect(manifest?.migration).toMatch(/^0016_/);
    expect(manifest?.tables.map((t) => t.name)).toEqual(EXPORTED.map((t) => t.name));

    // Counts, sizes and R2 MD5s match the stored parts.
    for (const table of manifest?.tables ?? []) {
      const { n } = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table.name}`).first<{
        n: number;
      }>()) ?? { n: -1 };
      expect([table.name, table.rows]).toEqual([table.name, n]);
      for (const [seq, part] of table.parts.entries()) {
        expect(part.key).toBe(partKey(manifest?.exportId as string, table.name, seq));
        const head = await env.MAIL.head(part.key);
        expect(head?.size).toBe(part.bytes);
        expect(part.md5).toMatch(/^[0-9a-f]{32}$/);
        expect(part.md5).toBe(
          [...new Uint8Array(head?.checksums.md5 ?? new ArrayBuffer(0))]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
        );
      }
    }

    const texts = await partTexts(manifest as never);
    const all = texts.join("");
    // No statement reaches D1's 100,000-byte limit; the long draft is split into UPDATEs.
    const encoder = new TextEncoder();
    const sql = texts.flatMap(statements);
    expect(Math.max(...sql.map((s) => encoder.encode(s).byteLength))).toBeLessThanOrEqual(
      SPLIT_BYTES,
    );
    expect(sql.filter((s) => s.startsWith('UPDATE "drafts" SET "text"')).length).toBeGreaterThan(
      20,
    );
    // The left-out tables and their planted values appear nowhere.
    for (const value of Object.values(PLANTED)) expect(all).not.toContain(value);
    for (const name of Object.keys(EXCLUDED)) expect(all).not.toContain(`INSERT INTO "${name}"`);

    await applyD1Migrations(env.RESTORE_DB, env.TEST_MIGRATIONS);
    await loadExport(env.RESTORE_DB, manifest as never);
    expect(await exportedRows(env.RESTORE_DB)).toEqual(await exportedRows(env.DB));
    const draft = await env.RESTORE_DB.prepare(
      "SELECT text FROM drafts WHERE id = 'long-draft'",
    ).first<{
      text: string;
    }>();
    expect(draft?.text === LONG_TEXT).toBe(true);
    // Search works on the restored FTS rows, CJK included.
    const hit = await env.RESTORE_DB.prepare(
      "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH '\"中文搜索\"'",
    ).first<{ n: number }>();
    expect(hit?.n).toBe(30);
    const fk = await env.RESTORE_DB.prepare("PRAGMA foreign_key_check").all();
    expect(fk.results).toEqual([]);
    // seq is kept as stored, and the first message stored after the restore is numbered above
    // every restored one.
    const top = await env.DB.prepare("SELECT MAX(seq) AS s FROM messages").first<{ s: number }>();
    await env.RESTORE_DB.prepare(
      `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
         raw_size, r2_key, received_at) VALUES ('after', 1, 'in', 'stored', 'a', 'b', 1, 'k', 1)`,
    ).run();
    const after = await env.RESTORE_DB.prepare(
      "SELECT seq FROM messages WHERE id = 'after'",
    ).first<{
      seq: number;
    }>();
    expect(after?.seq).toBe((top?.s ?? 0) + 1);
  });

  it("starts again when the exported columns changed since the export started", async () => {
    await seedMessage({ id: "m" });
    // A running export started by code from before migration 0016, with one part written.
    await env.DB.prepare(
      "INSERT INTO backup_exports (id, status, started_at, table_index, part_seq) VALUES ('2026-11-18T0300Z', 'running', ?, 7, 1)",
    )
      .bind(START)
      .run();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    // Discarded in the minute it started; the next run starts the new export.
    await runExport(env, START);
    expect((await latestState())?.status).toBe("failed");
    expect((await env.MAIL.list({ prefix: "backups/d1/2026-11-18T0300Z/" })).objects).toEqual([]);
    await runExport(env, START + 15 * MINUTE);
    const rows = await env.DB.prepare(
      "SELECT id, status, error, columns FROM backup_exports ORDER BY started_at",
    ).all<{ id: string; status: string; error: string | null; columns: string | null }>();
    expect(rows.results.map((r) => [r.id, r.status, r.error])).toEqual([
      ["2026-11-18T0300Z", "failed", "columns_changed"],
      ["2026-11-18T0315Z", "complete", null],
    ]);
    expect(rows.results[1]?.columns).toBe(EXPORT_COLUMNS);
    // A running export started with the same lists continues.
    await env.DB.prepare(
      "UPDATE backup_exports SET status = 'running', table_index = 0, last_rowid = 0, part_seq = 0 WHERE id = '2026-11-18T0315Z'",
    ).run();
    await runExport(env, START + 30 * MINUTE);
    const after = await env.DB.prepare(
      "SELECT id, status FROM backup_exports ORDER BY started_at",
    ).all();
    expect(after.results).toEqual([
      { id: "2026-11-18T0300Z", status: "failed" },
      { id: "2026-11-18T0315Z", status: "complete" },
    ]);
  });

  it("repeats a page whose cursor update was lost, without duplicate rows", async () => {
    for (let i = 0; i < 5; i++) await seedMessage({ id: `k${i}`, body: `text ${i}` });
    const put = env.MAIL.put.bind(env.MAIL);
    let puts = 0;
    const spy = vi.spyOn(env.MAIL, "put").mockImplementation(async (...args) => {
      const object = await put(...args);
      // The third part is stored, then the run dies before the cursor moves.
      if (++puts === 3) throw new Error("killed after put");
      return object;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runExport(env, START)).rejects.toThrow("killed after put");
    expect(error.mock.calls.join(" ")).toContain('"event":"backup_export_failed"');
    spy.mockRestore();
    await exportUntilComplete(START + 15 * MINUTE);
    const manifest = await readManifest((await latestState())?.id as string);
    const sql = (await partTexts(manifest as never)).flatMap(statements);
    const inserts = sql.filter((s) => s.startsWith('INSERT INTO "messages" '));
    expect(inserts).toHaveLength(5);
    expect(manifest?.tables.find((t) => t.name === "messages")?.rows).toBe(5);
    expect(manifest?.tables.find((t) => t.name === "messages_fts")?.rows).toBe(5);
  });

  it("stops a run at its byte budget and continues on the next run", async () => {
    const insert = env.DB.prepare(
      "INSERT INTO forward_targets (email, note, created_at) VALUES (?, ?, 1)",
    );
    // An early table, so the calls would allow 7 pages: the bytes end the run after 5 (3 rows a page).
    const note = "a".repeat(86_000);
    await env.DB.batch(
      Array.from({ length: 30 }, (_, i) => insert.bind(`t${i}@dest.example`, note)),
    );
    await runExport(env, START);
    const state = await latestState();
    expect(state?.status).toBe("running");
    expect(JSON.parse(state?.parts_json as string)).toHaveLength(5);
    expect(state?.bytes as number).toBeGreaterThanOrEqual(RUN_BYTES);
    await exportUntilComplete(START + 15 * MINUTE);
    const manifest = await readManifest((await latestState())?.id as string);
    const targets = manifest?.tables.find((t) => t.name === "forward_targets");
    expect(targets?.rows).toBe(30);
    expect(targets?.parts).toHaveLength(10);
    for (const part of targets?.parts ?? []) expect(part.bytes).toBeLessThanOrEqual(PAGE_BYTES);
  });
  it("stops a run at its call budget", async () => {
    // 500 short rows a page: 8 pages fit the calls, far below the byte budget.
    await env.DB.exec(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000) INSERT INTO domains (name, created_at) SELECT 'd' || i || '.example', 1 FROM n",
    );
    await runExport(env, START);
    const state = await latestState();
    expect(state?.status).toBe("running");
    expect(JSON.parse(state?.parts_json as string)).toHaveLength(8);
    expect(state?.bytes as number).toBeLessThan(RUN_BYTES);
  });

  it("writes an oversized row only as a run's first page, and keeps the cursor it reached", async () => {
    await env.DB.prepare("INSERT INTO domains (name, created_at) VALUES ('example.com', 1)").run();
    const insert = env.DB.prepare(
      "INSERT INTO drafts (id, text, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
    );
    const text = "a".repeat(300_000);
    await env.DB.batch([
      insert.bind("d0", text, "key-0-000000"),
      insert.bind("d1", text, "key-1-000000"),
    ]);
    const prepare = vi.spyOn(env.DB, "prepare");
    await runExport(env, START);
    // domains, its end, 8 empty tables, then the oversized row, left for the next run.
    const pages = prepare.mock.calls.filter((c) => String(c[0]).startsWith("WITH p AS"));
    expect(pages).toHaveLength(11);
    const state = await latestState();
    expect(JSON.parse(state?.parts_json as string)).toHaveLength(1);
    expect(state?.table_index).toBe(EXPORTED.findIndex((t) => t.name === "drafts"));
    await runExport(env, START + 15 * MINUTE);
    expect(JSON.parse((await latestState())?.parts_json as string)).toHaveLength(2);
    await runExport(env, START + 30 * MINUTE);
    expect(JSON.parse((await latestState())?.parts_json as string)).toHaveLength(3);
  });
  it("starts once a day at 03:00 UTC and replaces an export running for 48 hours", async () => {
    expect(dayStart(START - 1)).toBe(START - DAY);
    expect(dayStart(START)).toBe(START);
    await exportUntilComplete(START);
    await runExport(env, START + DAY - 1);
    const { results } = await env.DB.prepare("SELECT id FROM backup_exports").all();
    expect(results).toHaveLength(1);
    await runExport(env, START + DAY);
    expect((await latestState())?.id).toBe("2026-11-19T0300Z");

    // A running export that has not finished within 48 hours is marked failed and replaced.
    await env.DB.prepare(
      "UPDATE backup_exports SET status = 'running' WHERE id = '2026-11-19T0300Z'",
    ).run();
    // Its parts are removed in the same run, so failing exports do not pile up in R2.
    const stuck = "backups/d1/2026-11-19T0300Z/";
    expect((await env.MAIL.list({ prefix: stuck })).objects.length).toBeGreaterThan(0);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runExport(env, START + 3 * DAY);
    expect(error.mock.calls.join(" ")).toContain('"error":"timeout"');
    expect((await env.MAIL.list({ prefix: stuck })).objects).toEqual([]);
    const ids = async () =>
      (await env.DB.prepare("SELECT id FROM backup_exports ORDER BY id").all()).results;
    expect(await ids()).toEqual([{ id: "2026-11-18T0300Z" }]);
    await runExport(env, START + 3 * DAY + 15 * MINUTE);
    expect(await ids()).toEqual([{ id: "2026-11-18T0300Z" }, { id: "2026-11-21T0315Z" }]);
  });

  it("does nothing before migration 0015", async () => {
    await env.DB.exec("ALTER TABLE backup_exports RENAME TO backup_exports_away");
    try {
      await expect(runExport(env, START)).resolves.toBeUndefined();
      expect((await env.MAIL.list({ prefix: "backups/" })).objects).toEqual([]);
    } finally {
      await env.DB.exec("ALTER TABLE backup_exports_away RENAME TO backup_exports");
    }
  });
});
