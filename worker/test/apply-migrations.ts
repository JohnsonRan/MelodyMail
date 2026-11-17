import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage lives as long as the test file, so each test starts from empty tables.
// Children before parents: D1 enforces foreign keys.
const TABLES = [
  "telegram_cards",
  "telegram",
  "messages_fts",
  "messages",
  "drafts",
  "uploads",
  "webhook_events",
  "send_quota",
  "settings",
  "rule_forwards",
  "api_keys",
  "rules",
  "address_forwards",
  "addresses",
  "forward_targets",
  "domains",
  "owner",
  "passkeys",
  "push_subscriptions",
  "sessions",
  "auth_challenges",
  "login_attempts",
  "audit_log",
  "backup_exports",
];
beforeEach(async () => {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const objects = (await env.MAIL.list()).objects.map((o) => o.key);
  if (objects.length > 0) await env.MAIL.delete(objects);
  // No test may reach a real upstream (AGENTS.md, hard limits). A test that needs an outbound
  // answer replaces this with its own mock.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("outbound fetch is off in tests"));
});
afterEach(() => {
  vi.restoreAllMocks();
});
