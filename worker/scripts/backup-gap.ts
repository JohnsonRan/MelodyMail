#!/usr/bin/env bun
/**
 * The gap tool (docs/M7-ops.md, "Mail after the restore point"; owner ruling 2, 2026-11-17).
 * After a restore to time T, it finds the raw mail objects received after T that have no row,
 * from the metadata email() writes on each object, and writes the SQL that stores them again as
 * `stored` rows; the cron then re-enqueues them and the consumer parses them. Objects stored
 * before that metadata existed are reported and skipped.
 *
 * It starts worker/scripts/gap-worker.ts with `wrangler dev` on the given database and bucket
 * (local state, or with --remote the account's through remote bindings), asks it for the report
 * and stops it. It writes nothing to D1 or R2; the owner applies the SQL:
 *   bun run wrangler d1 execute melodymail --file <out.sql> (--local ... | --remote --config ...)
 *
 * Usage: bun scripts/backup-gap.ts <since> <out.sql> <where> [--config <file>] [--dry-run]
 *   <since>  an export id (2026-11-18T0300Z), an ISO time, or milliseconds since 1970
 *   <where>  --local [--persist-to <path>], or --remote (needs `wrangler login`)
 *   --dry-run  prints the report and writes no file
 * Exit codes: 0 done, 2 could not run.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonc } from "./prod-config";

const WORKER = join(import.meta.dir, "..");
const PORT = 8798;

type Report = {
  since: number;
  listed: number;
  after: number;
  present: number;
  rows: { key: string; receivedAt: number }[];
  skipped: { key: string; reason: string }[];
  sql: string;
};

/** Milliseconds from an export id, an ISO time or a number; null when none of them. */
export function parseSince(value: string): number | null {
  const id = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})Z$/.exec(value);
  const ms = id
    ? Date.parse(`${id[1]}T${id[2]}:${id[3]}:00Z`)
    : /^\d+$/.test(value)
      ? Number(value)
      : Date.parse(value);
  return Number.isSafeInteger(ms) ? ms : null;
}

/** The gap Worker's config: the D1 and R2 bindings of `base`, remote when asked, nothing else. */
export function gapConfig(base: Record<string, unknown>, remote: boolean): Record<string, unknown> {
  const pick = (list: unknown, binding: string) => {
    const entry = (list as Record<string, unknown>[] | undefined)?.find(
      (b) => b.binding === binding,
    );
    if (!entry) throw new Error(`the config has no ${binding} binding`);
    return { ...entry, ...(remote ? { remote: true } : {}) };
  };
  return {
    name: "melodymail-gap",
    main: join(WORKER, "scripts", "gap-worker.ts"),
    compatibility_date: base.compatibility_date,
    compatibility_flags: base.compatibility_flags,
    d1_databases: [pick(base.d1_databases, "DB")],
    r2_buckets: [pick(base.r2_buckets, "MAIL")],
  };
}

function stop(child: { pid: number; kill: () => void }) {
  if (process.platform === "win32")
    Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", "/F"]);
  else child.kill();
}

async function main(argv: string[]): Promise<number> {
  const [sinceText, out] = argv;
  const since = sinceText ? parseSince(sinceText) : null;
  const dryRun = argv.includes("--dry-run");
  const remote = argv.includes("--remote");
  if (since === null || !out || (!remote && !argv.includes("--local"))) {
    console.error(
      "usage: backup-gap.ts <since> <out.sql> (--local [--persist-to <path>] | --remote) [--config <file>] [--dry-run]",
    );
    return 2;
  }
  const configAt = argv.indexOf("--config");
  const configPath = configAt === -1 ? join(WORKER, "wrangler.jsonc") : (argv[configAt + 1] ?? "");
  if (!existsSync(configPath)) {
    console.error(`no config at ${configPath}`);
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), "melodymail-gap-"));
  const config = join(dir, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify(
      gapConfig(parseJsonc(readFileSync(configPath, "utf8")) as Record<string, unknown>, remote),
    ),
  );
  const persistAt = argv.indexOf("--persist-to");
  const persist = persistAt === -1 ? [] : ["--persist-to", argv[persistAt + 1] ?? ""];
  console.error(`wrangler dev --config ${config} --port ${PORT} ${persist.join(" ")}`);
  const dev = Bun.spawn(
    [
      "bun",
      "run",
      "--cwd",
      WORKER,
      "wrangler",
      "dev",
      "--config",
      config,
      "--port",
      String(PORT),
      "--ip",
      "127.0.0.1",
      "--inspector-port",
      String(PORT + 1),
      ...persist,
    ],
    { stdout: Bun.file(join(dir, "dev.log")), stderr: Bun.file(join(dir, "dev.err.log")) },
  );
  try {
    const origin = `http://127.0.0.1:${PORT}`;
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${origin}/health`)).ok) break;
      } catch {}
      if (i > 120) throw new Error(`wrangler dev did not start; see ${dir}`);
      await Bun.sleep(500);
    }
    const res = await fetch(`${origin}/gap?since=${since}`);
    if (!res.ok) throw new Error(`the gap Worker answered ${res.status}; see ${dir}`);
    const report = (await res.json()) as Report;
    console.log(
      `since ${new Date(since).toISOString()}: ${report.listed} raw objects listed, ${report.after} after it, ${report.present} with a row`,
    );
    console.log(
      `${report.rows.length} to store again${dryRun ? " (dry run, no file written)" : ""}`,
    );
    for (const row of report.rows.slice(0, 20))
      console.log(`  ${row.key} received ${new Date(row.receivedAt).toISOString()}`);
    if (report.rows.length > 20) console.log(`  ... and ${report.rows.length - 20} more`);
    for (const s of report.skipped) console.log(`skipped ${s.key}: ${s.reason}`);
    if (!dryRun) {
      writeFileSync(
        out,
        `-- Gap since ${new Date(since).toISOString()}: ${report.rows.length} rows.\n${report.sql}`,
      );
      console.log(`wrote ${out}`);
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  } finally {
    stop(dev);
    await dev.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
