#!/usr/bin/env bun
/**
 * Writes the production wrangler config (docs/M7-ops.md, "Production config"):
 * worker/.wrangler-production.jsonc, which is wrangler.jsonc with the account's values from the
 * untracked worker/deploy.local.jsonc (the D1 database id, the custom domain route,
 * workers_dev: false). It writes beside wrangler.jsonc, so the relative paths stay valid.
 *
 * It refuses unless the branch is main, the tree is clean and HEAD equals origin/main as last
 * fetched (worker/AGENTS.md, "Operations": production only from merged main; there is no
 * override). Run `git pull` first. It contacts nothing; `migrate:prod` and `deploy:prod` run it
 * before wrangler.
 *
 * Usage: bun scripts/prod-config.ts [--local <deploy.local.jsonc>] [--print]
 *   --print writes nothing and prints the merged config.
 * Exit codes: 0 written, 1 refused (git state or an invalid local file), 2 could not run.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WORKER = join(import.meta.dir, "..");
export const OUTPUT = ".wrangler-production.jsonc";

/** Keys deploy.local.jsonc may set; anything else is refused, so a typo cannot pass silently. */
const LOCAL_KEYS = ["database_id", "routes", "workers_dev", "preview_urls", "account_id"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Git = (args: string[]) => string | null;

/** Why production is refused, or null when HEAD is a clean, merged main. */
export function refusal(git: Git): string | null {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return "git could not be run";
  if (branch !== "main") return `the branch is ${branch}, not main`;
  const status = git(["status", "--porcelain"]);
  if (status === null || status !== "") return "the working tree is not clean";
  const head = git(["rev-parse", "HEAD"]);
  const remote = git(["rev-parse", "origin/main"]);
  if (!head || !remote) return "origin/main is unknown; run git fetch";
  if (head !== remote) return "HEAD is not origin/main; pull or push first";
  return null;
}

/** JSON with // and /* comments and trailing commas, as wrangler reads it. Strings are kept. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) throw new Error("unclosed comment");
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

type Config = Record<string, unknown> & { d1_databases?: Record<string, unknown>[] };

/** wrangler.jsonc with the local values; throws with a message on an invalid local file. */
export function mergeConfig(base: Config, local: Record<string, unknown>): Config {
  const unknown = Object.keys(local).filter((k) => !LOCAL_KEYS.includes(k));
  if (unknown.length > 0) throw new Error(`deploy.local.jsonc: unknown keys ${unknown.join(", ")}`);
  const { database_id: databaseId, ...rest } = local;
  if (typeof databaseId !== "string" || !UUID.test(databaseId)) {
    throw new Error("deploy.local.jsonc: database_id must be the id `wrangler d1 create` printed");
  }
  const routes = rest.routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error("deploy.local.jsonc: routes must name the custom domain");
  }
  if (rest.workers_dev !== false) {
    throw new Error("deploy.local.jsonc: workers_dev must be false");
  }
  if (rest.preview_urls !== false) {
    throw new Error("deploy.local.jsonc: preview_urls must be false");
  }
  const databases = (base.d1_databases ?? []).map((db) =>
    db.binding === "DB" ? { ...db, database_id: databaseId } : db,
  );
  if (!databases.some((db) => db.database_id === databaseId)) {
    throw new Error("wrangler.jsonc: no D1 binding named DB");
  }
  return { ...base, ...rest, d1_databases: databases };
}

function main(argv: string[]): number {
  const at = argv.indexOf("--local");
  const localPath = at === -1 ? join(WORKER, "deploy.local.jsonc") : argv[at + 1];
  const print = argv.includes("--print");
  if (!localPath || !existsSync(localPath)) {
    console.error("deploy.local.jsonc is missing; copy deploy.example.jsonc and fill it in");
    return 2;
  }
  const git: Git = (args) => {
    const run = Bun.spawnSync(["git", ...args], { cwd: WORKER });
    return run.exitCode === 0 ? run.stdout.toString().trim() : null;
  };
  const refused = refusal(git);
  if (refused) {
    console.error(`refused: ${refused}. Production deploys only from merged main.`);
    return 1;
  }
  let config: Config;
  try {
    const base = parseJsonc(readFileSync(join(WORKER, "wrangler.jsonc"), "utf8")) as Config;
    config = mergeConfig(base, parseJsonc(readFileSync(localPath, "utf8")) as Config);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const text = `// Generated by scripts/prod-config.ts from wrangler.jsonc and deploy.local.jsonc. Do not edit.\n${JSON.stringify(config, null, 2)}\n`;
  if (print) {
    process.stdout.write(text);
    return 0;
  }
  writeFileSync(join(WORKER, OUTPUT), text);
  console.log(`wrote ${OUTPUT}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
