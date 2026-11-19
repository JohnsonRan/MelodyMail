#!/usr/bin/env bun
/**
 * The release tier (`bun run release`, REQUIREMENTS.md, "Commands"; .github/AGENTS.md: release
 * checks run migrations on a copy of production data). The owner runs it on main before a
 * production deploy, signed in with `wrangler login`:
 * 1. `bun run check`, then the scheduled suites (browser, send, PWA, settings);
 * 2. the restore drill on a production export: downloads it with `--remote` (read only), builds a
 *    fresh local database at the export's migration, imports the export, applies this checkout's
 *    newer migrations to that copy of production data, and verifies counts and foreign keys.
 *    Nothing is written to the account.
 *
 * Usage: bun run release <exportId>   (the newest complete export, from the routine check)
 * Exit codes: 0 passed, 1 a step failed, 2 could not run.
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonc } from "../worker/scripts/prod-config";

const ROOT = join(import.meta.dir, "..");
const WORKER = join(ROOT, "worker");
const PROD = ".wrangler-production.jsonc";

const exportId = process.argv[2];
if (!exportId || !/^\d{4}-\d{2}-\d{2}T\d{4}Z$/.test(exportId)) {
  console.error("usage: bun run release <exportId>, for example 2026-11-18T0300Z");
  process.exit(2);
}

function step(name: string, cmd: string[], cwd = ROOT): void {
  const start = performance.now();
  console.log(`\n=== ${name}`);
  const code = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" }).exitCode;
  console.log(`=== ${name}: exit ${code} (${((performance.now() - start) / 1000).toFixed(1)} s)`);
  if (code !== 0) process.exit(1);
}

const bun = process.execPath;
const dir = mkdtempSync(join(tmpdir(), "melodymail-release-"));
const local = ["--local", "--persist-to", join(dir, "state")];

step("check", [bun, "run", "check"]);
for (const suite of ["test:browser", "test:send", "test:pwa", "test:settings", "test:folders"]) {
  step(suite, [bun, "run", suite]);
}
step("production config", [bun, "scripts/prod-config.ts"], WORKER);
step(
  "fetch the export (read only)",
  [
    bun,
    "scripts/backup-restore.ts",
    "fetch",
    exportId,
    join(dir, "export"),
    "--remote",
    "--config",
    PROD,
  ],
  WORKER,
);
// A config whose migrations stop at the export's, so the newer ones run on the imported data.
const manifest = JSON.parse(readFileSync(join(dir, "export", "manifest.json"), "utf8")) as {
  migration: string | null;
};
const atExport = join(dir, "migrations-at-export");
mkdirSync(atExport);
for (const file of readdirSync(join(WORKER, "migrations"))) {
  if (file.endsWith(".sql") && manifest.migration && file <= manifest.migration) {
    copyFileSync(join(WORKER, "migrations", file), join(atExport, file));
  }
}
const config = parseJsonc(readFileSync(join(WORKER, "wrangler.jsonc"), "utf8")) as Record<
  string,
  unknown
> & { d1_databases: Record<string, unknown>[] };
config.main = join(WORKER, "src", "index.ts");
config.assets = undefined;
config.d1_databases = config.d1_databases.map((db) => ({ ...db, migrations_dir: atExport }));
const atExportConfig = join(dir, "wrangler.at-export.jsonc");
writeFileSync(atExportConfig, JSON.stringify(config));

step(
  `migrations up to ${manifest.migration}`,
  [
    bun,
    "run",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "melodymail",
    ...local,
    "--config",
    atExportConfig,
  ],
  WORKER,
);
step(
  "import",
  [
    bun,
    "run",
    "wrangler",
    "d1",
    "execute",
    "melodymail",
    "--file",
    join(dir, "export", "restore.sql"),
    ...local,
    "--config",
    atExportConfig,
  ],
  WORKER,
);
step(
  "newer migrations on the copy",
  [bun, "run", "wrangler", "d1", "migrations", "apply", "melodymail", ...local],
  WORKER,
);
step(
  "verify",
  [bun, "scripts/backup-restore.ts", "verify", join(dir, "export"), "melodymail", ...local],
  WORKER,
);
console.log(`\nrelease checks passed; the local copy is in ${dir}`);
