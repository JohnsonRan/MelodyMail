import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage lives as long as the test file, so each test starts from empty tables.
const TABLES = ["owner", "passkeys", "sessions", "auth_challenges", "login_attempts", "audit_log"];
beforeEach(async () => {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
