#!/usr/bin/env bun
/**
 * Seeds the local mailbox for screenshots and manual checks: runs the real M3 email() path in a
 * running `wrangler dev` over every fixture in worker/test/fixtures, so the messages land in the
 * local D1 and R2 and go through the local queue consumer like real mail.
 *
 * Start the Worker first (`bun run --cwd worker dev`), then run `bun scripts/seed-mail.ts`.
 * It creates the domain example.com and the addresses shop@ and news@ in the local database
 * when they are missing. It never touches a remote account: every wrangler call passes --local.
 *
 * Usage: bun scripts/seed-mail.ts [worker-url] [--persist-to <dir>]   (default http://127.0.0.1:8787)
 *   --persist-to  the local state the Worker was started with (the restore drill in docs/RUNBOOK.md)
 * Exit codes: 0 seeded, 1 a message was refused, 2 the Worker or wrangler could not be reached.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const persistAt = args.indexOf("--persist-to");
const persist = persistAt === -1 ? undefined : args[persistAt + 1];
if (persistAt !== -1 && !persist) {
  console.error("--persist-to needs a directory");
  process.exit(2);
}
const base =
  args.find((a, i) => !a.startsWith("--") && (persistAt === -1 || i !== persistAt + 1)) ??
  "http://127.0.0.1:8787";
// wrangler runs from worker/, so a relative state directory is resolved against the caller first.
const local = persist ? ["--local", "--persist-to", resolve(persist)] : ["--local"];
const root = join(import.meta.dir, "..");
const fixtures = join(root, "worker", "test", "fixtures");

const SETUP_SQL = [
  "INSERT OR IGNORE INTO domains (name, receive_enabled, send_enabled, created_at) VALUES ('example.com', 1, 0, 0)",
  "INSERT OR IGNORE INTO addresses (local_part, domain, note, display_name, enabled, forward_only, created_at) VALUES ('shop', 'example.com', '', '', 1, 0, 0)",
  "INSERT OR IGNORE INTO addresses (local_part, domain, note, display_name, enabled, forward_only, created_at) VALUES ('news', 'example.com', '', '', 1, 0, 0)",
].join("; ");

/** wrangler runs on Node through `bun run` (owner ruling); --local keeps it off any account. */
async function wrangler(args: string[]): Promise<void> {
  const child = Bun.spawn(["bun", "run", "--cwd", join(root, "worker"), "wrangler", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) {
    console.error(`wrangler ${args[0]} failed`);
    process.exit(2);
  }
}

await wrangler(["d1", "migrations", "apply", "melodymail", ...local]);
await wrangler(["d1", "execute", "melodymail", ...local, "--command", SETUP_SQL]);

// Every other message goes to the news address with a sub-address tag, so the address
// navigation and the tag in the reader both have data.
const names = readdirSync(fixtures)
  .filter((f) => f.endsWith(".eml"))
  .sort();
let refused = 0;
for (const [i, name] of names.entries()) {
  const to = i % 2 === 0 ? "shop@example.com" : "news+github@example.com";
  const url = new URL("/cdn-cgi/local/email", base);
  url.searchParams.set("from", "sender@example.org");
  url.searchParams.set("to", to);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", body: readFileSync(join(fixtures, name)) });
  } catch {
    console.error(`no Worker at ${base}; start it with: bun run --cwd worker dev`);
    process.exit(2);
  }
  console.log(`${res.status} ${name} -> ${to}`);
  if (!res.ok) refused++;
}
process.exit(refused > 0 ? 1 : 0);
