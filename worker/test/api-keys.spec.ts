import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { KEY_PATTERN, KEYS_MAX } from "../src/api/keys";
import { sha256Hex } from "../src/auth/crypto";
import { apiKey, v1 } from "./api-helpers";
import { Client, setupOwner, totpCode } from "./helpers";
import { signedIn } from "./send-helpers";

// API key management (docs/M6-rules-api.md, "API keys"): creation behind fresh re-authentication,
// expiry choices, the cap, revocation, recovery and the origin rule. Request authentication is in
// api-key-auth.spec.ts.

const DAY = 86_400_000;

/** A signed-in client whose session passed a Passkey assertion just now. */
async function freshClient(): Promise<Client> {
  const client = await signedIn();
  await env.DB.prepare("UPDATE sessions SET reauth_at = ?").bind(Date.now()).run();
  return client;
}

type Created = { key: string; apiKey: Record<string, unknown> & { id: number; publicId: string } };

async function create(client: Client, body: Record<string, unknown> = {}) {
  return client.request("POST", "/api/keys", { label: "Backup", scopes: ["mail:read"], ...body });
}

async function auditRows(event: string) {
  const { results } = await env.DB.prepare("SELECT detail FROM audit_log WHERE event = ?")
    .bind(event)
    .all<{ detail: string }>();
  return results.map((r) => r.detail);
}

/** Every value of every table, as one string. */
async function databaseText(): Promise<string> {
  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  const dumps = await env.DB.batch(tables.map((t) => env.DB.prepare(`SELECT * FROM "${t.name}"`)));
  return JSON.stringify(dumps.map((d) => d.results));
}

describe("API keys", () => {
  it("creates a key only on a fresh session, returns it once and stores only its hash", async () => {
    const stale = await signedIn();
    const refused = await create(stale);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "reauth_required" });

    const client = await freshClient();
    const res = await create(client, { label: " Backup ", scopes: ["mail:send", "mail:read"] });
    expect(res.status).toBe(201);
    const { key, apiKey: meta } = (await res.json()) as Created;
    expect(key).toMatch(KEY_PATTERN);
    expect(key.startsWith(`mmk_${meta.publicId}_`)).toBe(true);
    expect(meta).toMatchObject({ label: "Backup", scopes: ["mail:read", "mail:send"] });
    expect(meta.expiresAt).toBe((meta.createdAt as number) + 90 * DAY);

    const row = await env.DB.prepare("SELECT token_hash AS hash FROM api_keys").first("hash");
    expect(row).toBe(await sha256Hex(key));
    const secret = key.slice(13);
    const stored = await databaseText();
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(key);
    expect(await auditRows("api_key_created")).toEqual([
      `${meta.publicId} mail:read,mail:send 90d`,
    ]);

    const list = await client.json("GET", "/api/keys");
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(list.apiKeys).toEqual([{ ...meta, lastUsedAt: null, lastUsedIp: null }]);
  });

  it("takes 30, 90, 365 days or never, and refuses anything else", async () => {
    const client = await freshClient();
    for (const [days, expected] of [
      [30, 30 * DAY],
      [365, 365 * DAY],
      [null, null],
    ] as const) {
      const { apiKey: meta } = (await (
        await create(client, { expiresInDays: days })
      ).json()) as Created;
      const lifetime =
        meta.expiresAt === null ? null : (meta.expiresAt as number) - (meta.createdAt as number);
      expect(lifetime, String(days)).toBe(expected);
    }
    for (const bad of [
      { expiresInDays: 7 },
      { expiresInDays: "90" },
      { scopes: [] },
      { scopes: ["mail:read", "rules:write"] },
      { scopes: "mail:read" },
      { label: "  " },
      { label: "x".repeat(65) },
    ]) {
      const res = await create(client, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys").first("n")).toBe(3);
  });

  it("keeps at most 20 keys", async () => {
    for (let i = 0; i < KEYS_MAX - 1; i++) await apiKey();
    const client = await freshClient();
    expect((await create(client)).status).toBe(201);
    const over = await create(client);
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({ error: "too_many_keys" });
    expect(await auditRows("api_key_created")).toHaveLength(1);
  });

  it("revokes with a stale session, after which the key answers 401", async () => {
    const { key, id } = await apiKey();
    expect((await v1(key, "GET", "/addresses")).status).toBe(200);
    const client = await signedIn();
    const publicId = key.slice(4, 12);
    await client.json("DELETE", `/api/keys/${id}`);
    await client.json("DELETE", `/api/keys/${id}`, undefined, 404);
    await client.json("DELETE", "/api/keys/abc", undefined, 404);
    expect(await auditRows("api_key_revoked")).toEqual([publicId]);
    const res = await v1(key, "GET", "/addresses");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_key" });
  });

  it("skips the Origin check on /api/v1/ only", async () => {
    const { key } = await apiKey(["mail:write"]);
    const foreign = await v1(
      key,
      "PATCH",
      "/messages/none",
      { read: true },
      {
        origin: "https://evil.test",
      },
    );
    expect(foreign.status).toBe(404);
    const client = await freshClient();
    const res = await client.request(
      "POST",
      "/api/keys",
      { label: "x", scopes: ["mail:read"] },
      {
        origin: "https://evil.test",
      },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "bad_origin" });
  });

  it("deletes every key on a successful recovery, with an audit row", async () => {
    const owner = await setupOwner();
    const { key } = await apiKey();
    await apiKey(["mail:read"]);
    const res = await new Client().request("POST", "/api/auth/recover", {
      recoveryKey: owner.recoveryKey,
      totpCode: await totpCode(owner.totpSecret, 1),
    });
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys").first("n")).toBe(0);
    expect(await auditRows("api_keys_revoked")).toEqual(["2"]);
    expect((await v1(key, "GET", "/addresses")).status).toBe(401);
  });

  it("serves the OpenAPI document to a session", async () => {
    const client = await signedIn();
    const doc = await client.json("GET", "/api/openapi.json");
    expect(doc.openapi).toBe("3.1.0");
  });
});
