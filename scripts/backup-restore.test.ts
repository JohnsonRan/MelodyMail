import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseProblems, partProblems } from "../worker/scripts/backup-restore";
import {
  type Manifest,
  PAGE_BYTES,
  PAGE_ROWS,
  pageQuery,
  SPLIT_BYTES,
} from "../worker/src/backup/sql";

// The restore tool's checks (worker/scripts/backup-restore.ts) on files in a temporary directory
// and an in-memory SQLite database; no wrangler call is made.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes each table's parts and returns the manifest that describes them. */
function exportOf(tables: Record<string, string[]>): { manifest: Manifest; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "restore-test-"));
  dirs.push(dir);
  const manifest: Manifest = {
    format: 1,
    exportId: "2026-11-19T0300Z",
    startedAt: 0,
    finishedAt: 0,
    migration: null,
    tables: Object.entries(tables).map(([name, texts]) => ({
      name,
      rows: texts.length,
      lastRowid: texts.length,
      parts: texts.map((text, seq) => {
        const file = `part-${name}-${String(seq).padStart(5, "0")}.sql`;
        writeFileSync(join(dir, file), text);
        const md5 = createHash("md5").update(text).digest("hex");
        return { key: `backups/d1/2026-11-19T0300Z/${file}`, bytes: Buffer.byteLength(text), md5 };
      }),
    })),
  };
  return { manifest, dir };
}

const M8 = `INSERT INTO "messages" ("id","subject","seq","spam","spam_at","from_key") VALUES ('a','x',1,0,NULL,NULL);\n`;
const M7 = `INSERT INTO "messages" ("id","subject") VALUES ('b','y');\n`;

describe("partProblems", () => {
  test("refuses an export whose parts of one table have different column sets", () => {
    const { manifest, dir } = exportOf({ messages: [M8, M7] });
    expect(partProblems(manifest, dir)).toEqual([
      "messages: the parts have different columns (part-messages-00000.sql: 6, part-messages-00001.sql: 2); the export was written by two versions of the Worker, restore another export",
    ]);
  });

  test("accepts an export written wholly by one version, M7 included", () => {
    const split = `INSERT INTO "messages" ("id","subject") VALUES ('c','');\nUPDATE "messages" SET "subject" = "subject" || 'long' WHERE "id" = 'c';\n`;
    expect(partProblems(...withDir(exportOf({ messages: [M7, split, ""] })))).toEqual([]);
    expect(partProblems(...withDir(exportOf({ messages: [M8, M8] })))).toEqual([]);
  });
});

const withDir = ({ manifest, dir }: { manifest: Manifest; dir: string }) =>
  [manifest, dir] as const;

/** A part as the Worker writes it: the export's own page query, run on SQLite. */
function realPart(columns: string[]): string {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE messages (${columns.join(", ")})`);
  db.run(`INSERT INTO messages VALUES (${columns.map(() => "'v'").join(", ")})`);
  const table = { name: "messages", columns, key: ["id"] };
  const rows = db.query(pageQuery(table)).all(0, PAGE_ROWS, PAGE_BYTES, SPLIT_BYTES) as {
    s: string;
  }[];
  return `${rows.map((r) => r.s).join("\n")}\n`;
}

test("partProblems reads the column list of the Worker's own INSERT text", () => {
  const m8 = realPart(["id", "subject", "seq", "spam"]);
  const m7 = realPart(["id", "subject"]);
  expect(partProblems(...withDir(exportOf({ messages: [m8, m8] })))).toEqual([]);
  expect(partProblems(...withDir(exportOf({ messages: [m8, m7] })))).toHaveLength(1);
});

describe("databaseProblems", () => {
  const restored = (rows: [string, number][]) => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, seq INTEGER)");
    for (const [id, seq] of rows) db.run("INSERT INTO messages VALUES (?, ?)", [id, seq]);
    return <T>(sql: string) => db.query(sql).all() as T[];
  };
  const manifest = (rows: number) => exportOf({ messages: Array(rows).fill(M7) }).manifest;

  test("fails a restore where two messages hold the same seq", () => {
    const run = restored([
      ["a", 1],
      ["b", 2],
      ["c", 2],
    ]);
    expect(databaseProblems(manifest(3), run).problems).toEqual([
      "messages: seq 2 is held by 2 rows; the counter would hand out a seq that a row already has",
    ]);
  });

  test("passes counts that match, distinct seq values and no foreign key problem", () => {
    const run = restored([
      ["a", 1],
      ["b", 2],
    ]);
    expect(databaseProblems(manifest(2), run)).toEqual({ problems: [], notes: [] });
    expect(databaseProblems(manifest(3), run).problems).toEqual(["messages: 2 rows, manifest 3"]);
  });
});
