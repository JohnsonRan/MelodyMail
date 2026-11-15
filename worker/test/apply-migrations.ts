import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage lives as long as the test file, so each test starts from empty tables.
const TABLES = ["owner", "passkeys", "sessions", "auth_challenges", "login_attempts", "audit_log"];
beforeEach(async () => {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  // No test may reach a real upstream (AGENTS.md, hard limits). Tests that need an outbound
  // answer, such as the ip.sb lookup, replace this with their own mock.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("outbound fetch is off in tests"));
});
afterEach(() => {
  vi.restoreAllMocks();
});
