#!/usr/bin/env bun
/**
 * The owner-side half of a restore from an R2 export (docs/M7-ops.md, "Restore runbook", B).
 *
 * fetch <exportId> <dir> <where>
 *   Downloads the manifest and every part with `wrangler r2 object get`, checks each part's size,
 *   MD5 and sequence against the manifest and that every part of a table names the same columns,
 *   and writes <dir>/restore.sql: the parts in order with foreign keys deferred, then the removal
 *   of rows whose parent the export lacks (an export is not one snapshot), then the seq counter
 *   moved past the restored rows. Apply it with `wrangler d1 execute <db> --file <dir>/restore.sql`.
 * verify <dir> <database> <where> [--r2 <where>]
 *   Compares each table's row count with the manifest, requires PRAGMA foreign_key_check to be
 *   empty and every messages.seq to be held by one row and, with --r2, finds 20 sampled r2_key
 *   objects in the bucket.
 *
 * <where> is --remote, or --local with an optional --persist-to <path> (`--r2-persist-to` for the
 * bucket in verify). --config <file> passes a wrangler config (the production one for --remote).
 * Every wrangler call is printed first. Nothing is written to a database or a bucket.
 *
 * Exit codes: 0 passed, 1 a check failed, 2 could not run.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Manifest, RESTORE_COUNTER } from "../src/backup/sql";

const WORKER = join(import.meta.dir, "..");
const BUCKET = "melodymail-mail";
const SAMPLE = 20;

/** Children whose parent may be missing, removed in this order; each foreign key is listed. */
export const DANGLING = [
  "DELETE FROM addresses WHERE domain NOT IN (SELECT name FROM domains);",
  "DELETE FROM address_forwards WHERE address_id NOT IN (SELECT id FROM addresses) OR target_id NOT IN (SELECT id FROM forward_targets);",
  "DELETE FROM rule_forwards WHERE rule_id NOT IN (SELECT id FROM rules) OR target_id NOT IN (SELECT id FROM forward_targets);",
  "DELETE FROM telegram_cards WHERE message_id NOT IN (SELECT id FROM messages);",
];
/** seq values held by more than one message; the counter moves past MAX(seq) only. */
const SEQ_DUPLICATES =
  "SELECT seq, COUNT(*) AS n FROM messages WHERE seq IS NOT NULL GROUP BY seq HAVING COUNT(*) > 1 ORDER BY seq LIMIT 5";
/** Tables the clean-up may shrink; a lower count there is reported, not failed. */
const CLEANED = ["addresses", "address_forwards", "rule_forwards", "telegram_cards"];

class Stop extends Error {
  constructor(
    message: string,
    readonly code: 1 | 2,
  ) {
    super(message);
  }
}

function option(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** wrangler's location flags for D1 (prefix "") or R2 (prefix "r2-"). */
function where(argv: string[], prefix = ""): string[] {
  if (argv.includes(`--${prefix}remote`)) return ["--remote"];
  if (!argv.includes(`--${prefix}local`))
    throw new Error(`give --${prefix}local or --${prefix}remote`);
  const persist = option(argv, `--${prefix}persist-to`);
  return persist ? ["--local", "--persist-to", persist] : ["--local"];
}

function wrangler(args: string[], config: string | undefined): string {
  const full = [...args, ...(config ? ["--config", config] : [])];
  console.error(`wrangler ${full.join(" ")}`);
  const run = Bun.spawnSync(["bun", "run", "--cwd", WORKER, "wrangler", ...full], {
    stderr: "inherit",
  });
  if (run.exitCode !== 0) throw new Stop(`wrangler ${args.slice(0, 3).join(" ")} failed`, 2);
  return run.stdout.toString();
}

/** The distinct INSERT column lists of a part's text. */
function insertColumns(table: string, text: string): Set<string> {
  const head = new RegExp(`^INSERT INTO "${table}" \\(([^)]*)\\) VALUES \\(`, "gm");
  return new Set([...text.matchAll(head)].map((m) => m[1] ?? ""));
}

/**
 * Problems with the downloaded parts: missing, wrong size or MD5, a gap in a sequence, or parts of
 * one table with different columns. The last happens when an export spans a deploy or a rollback
 * across a migration (M8 to M7): restoring it would lose the newer columns of the later rows and
 * let the seq trigger number rows with a seq that an earlier part's row already holds.
 */
export function partProblems(manifest: Manifest, dir: string): string[] {
  const problems: string[] = [];
  for (const table of manifest.tables) {
    const columns = new Map<string, string>();
    table.parts.forEach((part, seq) => {
      const expected = `part-${table.name}-${String(seq).padStart(5, "0")}.sql`;
      if (basename(part.key) !== expected) problems.push(`${part.key}: expected ${expected}`);
      const file = join(dir, basename(part.key));
      if (!existsSync(file)) {
        problems.push(`${part.key}: missing`);
        return;
      }
      const bytes = readFileSync(file);
      if (bytes.byteLength !== part.bytes) problems.push(`${part.key}: ${bytes.byteLength} bytes`);
      const md5 = createHash("md5").update(bytes).digest("hex");
      if (md5 !== part.md5) problems.push(`${part.key}: MD5 differs`);
      for (const list of insertColumns(table.name, bytes.toString("utf8"))) {
        if (!columns.has(list)) columns.set(list, basename(part.key));
      }
    });
    if (columns.size > 1) {
      const seen = [...columns].map(([list, file]) => `${file}: ${list.split(",").length}`);
      problems.push(
        `${table.name}: the parts have different columns (${seen.join(", ")}); the export was written by two versions of the Worker, restore another export`,
      );
    }
  }
  return problems;
}

export function restoreSql(manifest: Manifest, dir: string): string {
  const parts = manifest.tables.flatMap((t) =>
    t.parts.map((p) => readFileSync(join(dir, basename(p.key)), "utf8")),
  );
  return [
    `-- Export ${manifest.exportId}, migration ${manifest.migration}.`,
    "PRAGMA defer_foreign_keys = on;",
    parts.join(""),
    ...DANGLING,
    RESTORE_COUNTER,
    "",
  ].join("\n");
}

function fetchExport(argv: string[]): void {
  const [exportId, dir] = argv;
  if (!exportId || !dir) throw new Stop("usage: fetch <exportId> <dir> <where>", 2);
  const location = where(argv);
  const config = option(argv, "--config");
  mkdirSync(dir, { recursive: true });
  const prefix = `${BUCKET}/backups/d1/${exportId}`;
  const manifestFile = join(dir, "manifest.json");
  wrangler(
    ["r2", "object", "get", `${prefix}/manifest.json`, "--file", manifestFile, ...location],
    config,
  );
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
  for (const table of manifest.tables) {
    for (const part of table.parts) {
      const file = join(dir, basename(part.key));
      wrangler(
        ["r2", "object", "get", `${BUCKET}/${part.key}`, "--file", file, ...location],
        config,
      );
    }
  }
  const problems = partProblems(manifest, dir);
  if (problems.length > 0) throw new Stop(problems.join("\n"), 1);
  writeFileSync(join(dir, "restore.sql"), restoreSql(manifest, dir));
  const rows = manifest.tables.reduce((n, t) => n + t.rows, 0);
  console.log(
    `${exportId}: ${rows} rows, restore.sql ${statSync(join(dir, "restore.sql")).size} bytes`,
  );
}

/** Rows of a single-statement `wrangler d1 execute --json`. */
function query<T>(database: string, sql: string, argv: string[]): T[] {
  const out = wrangler(
    ["d1", "execute", database, "--json", "--command", sql, ...where(argv)],
    option(argv, "--config"),
  );
  return (JSON.parse(out) as { results: T[] }[])[0]?.results ?? [];
}

/** Runs one statement on the restored database and returns its rows. */
export type Query = <T>(sql: string) => T[];

/**
 * The checks of verify that read the restored database: each table's row count against the
 * manifest, PRAGMA foreign_key_check and seq uniqueness. Notes are reported; problems fail the
 * restore.
 */
export function databaseProblems(
  manifest: Manifest,
  run: Query,
): { problems: string[]; notes: string[] } {
  const counts = manifest.tables.map((t) => `'${t.name}', (SELECT COUNT(*) FROM "${t.name}")`);
  const [row] = run<{ c: string }>(`SELECT json_object(${counts.join(", ")}) AS c`);
  const restored = JSON.parse(row?.c ?? "{}") as Record<string, number>;
  const problems: string[] = [];
  const notes: string[] = [];
  for (const t of manifest.tables) {
    const n = restored[t.name];
    if (n === t.rows) continue;
    if (n !== undefined && n < t.rows && CLEANED.includes(t.name)) {
      notes.push(`${t.name}: ${t.rows - n} row(s) without a parent removed`);
    } else {
      problems.push(`${t.name}: ${n} rows, manifest ${t.rows}`);
    }
  }
  const fk = run("PRAGMA foreign_key_check");
  if (fk.length > 0) problems.push(`foreign_key_check: ${fk.length} row(s)`);
  for (const { seq, n } of run<{ seq: number; n: number }>(SEQ_DUPLICATES)) {
    problems.push(
      `messages: seq ${seq} is held by ${n} rows; the counter would hand out a seq that a row already has`,
    );
  }
  return { problems, notes };
}

function verify(argv: string[]): void {
  const [dir, database] = argv;
  if (!dir || !database) throw new Stop("usage: verify <dir> <database> <where>", 2);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  const { problems, notes } = databaseProblems(manifest, (sql) => query(database, sql, argv));
  for (const note of notes) console.log(note);
  if (argv.includes("--r2-local") || argv.includes("--r2-remote")) {
    const keys = query<{ key: string }>(
      database,
      `SELECT r2_key AS key FROM messages ORDER BY random() LIMIT ${SAMPLE}`,
      argv,
    );
    for (const { key } of keys) {
      try {
        wrangler(
          ["r2", "object", "get", `${BUCKET}/${key}`, "--pipe", ...where(argv, "r2-")],
          option(argv, "--config"),
        );
      } catch {
        problems.push(`R2: ${key} missing`);
      }
    }
  }
  if (problems.length > 0) throw new Stop(problems.join("\n"), 1);
  console.log(`${manifest.exportId}: counts match, no foreign key problem, no duplicate seq`);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "fetch") fetchExport(rest);
    else if (command === "verify") verify(rest);
    else throw new Stop("usage: backup-restore.ts fetch|verify ...", 2);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(err instanceof Stop ? err.code : 2);
  }
}
