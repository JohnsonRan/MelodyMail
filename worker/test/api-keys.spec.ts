import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { KEY_PATTERN, KEYS_MAX } from "../src/api/keys";
import { sha256Hex } from "../src/auth/crypto";
import { ALL_SCOPES, apiKey, v1 } from "./api-helpers";
import { Client, ORIGIN, setupOwner, totpCode } from "./helpers";
import { fetchWith } from "./mailbox-helpers";
import { signedIn } from "./send-helpers";

// API keys (docs/M6-rules-api.md, "API keys"): creation behind fresh re-authentication, the
// format check before any D1 read, the rate limit before the lookup, expiry, revocation, last
// used, and recovery.

const DAY = 86_400_000;
const HOUR = 3_600_000;

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

/** A D1 stand-in that fails the test on any use. */
const noDatabase = new Proxy({} as D1Database, {
  get() {
    throw new Error("D1 was read");
  },
});

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

  it("refuses a malformed key before any D1 read, and reads no key from the query", async () => {
    for (const authorization of [
      "Bearer mmk_short",
      `Bearer mmk_ABCDEFGH_${"a".repeat(43)}`,
      `Bearer mmk_abcdefgh_${"a".repeat(42)}`,
      `Bearer mmk_abcdefgh_${"a".repeat(42)}=`,
      `Bearer xmk_abcdefgh_${"a".repeat(43)}`,
    ]) {
      const req = new Request(`${ORIGIN}/api/v1/addresses`, { headers: { authorization } });
      const res = await fetchWith(req, { DB: noDatabase });
      expect(res.status, authorization).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_key" });
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    const { key } = await apiKey();
    for (const query of [`?key=${key}`, `?access_token=${key}`]) {
      const res = await v1(null, "GET", `/addresses${query}`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    const basic = await v1(null, "GET", "/addresses", undefined, { authorization: `Basic ${key}` });
    expect(basic.status).toBe(401);
  });

  it("answers 401 for an unknown, expired or revoked key and accepts one that never expires", async () => {
    const unknown = `mmk_abcdefgh_${"a".repeat(43)}`;
    const res = await v1(unknown, "GET", "/addresses");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_key" });
    expect(res.headers.get("www-authenticate")).toBe("Bearer");

    const expired = await apiKey(ALL_SCOPES, { expiresAt: Date.now() - 1 });
    const late = await v1(expired.key, "GET", "/addresses");
    expect(late.status).toBe(401);
    expect(await late.json()).toEqual({ error: "key_expired" });

    const never = await apiKey(ALL_SCOPES, { expiresAt: null });
    expect((await v1(never.key, "GET", "/addresses")).status).toBe(200);
  });

  it("writes last used at most once an hour", async () => {
    const { key, id } = await apiKey(["mail:read"]);
    const lastUsed = () =>
      env.DB.prepare("SELECT last_used_at AS at, last_used_ip AS ip FROM api_keys WHERE id = ?")
        .bind(id)
        .first<{ at: number | null; ip: string | null }>();
    const ip = (n: number) => ({ "cf-connecting-ip": `192.0.2.${n}` });
    await v1(key, "GET", "/addresses", undefined, ip(1));
    const first = await lastUsed();
    expect(first?.ip).toBe("192.0.2.1");
    await v1(key, "GET", "/addresses", undefined, ip(2));
    expect(await lastUsed()).toEqual(first);

    await env.DB.prepare("UPDATE api_keys SET last_used_at = ?")
      .bind(Date.now() - HOUR + 5_000)
      .run();
    await v1(key, "GET", "/addresses", undefined, ip(3));
    expect((await lastUsed())?.ip).toBe("192.0.2.1");
    await env.DB.prepare("UPDATE api_keys SET last_used_at = ?")
      .bind(Date.now() - HOUR - 1)
      .run();
    await v1(key, "GET", "/addresses", undefined, ip(4));
    expect((await lastUsed())?.ip).toBe("192.0.2.4");
  });

  it("spends no D1 write inside the hour, and the write itself loses a race", async () => {
    const { key, id } = await apiKey(["mail:read"], { lastUsedAt: Date.now() - 60_000 });
    const statements: string[] = [];
    // `stale`: the key lookup reports "never used", as when another request wrote in between.
    const database = (stale: boolean) =>
      new Proxy(env.DB, {
        get(target, prop) {
          if (prop !== "prepare") return Reflect.get(target, prop);
          return (sql: string) => {
            statements.push(sql);
            const statement = target.prepare(sql);
            if (!stale || !sql.includes("WHERE token_hash")) return statement;
            return {
              bind: (...values: unknown[]) => ({
                first: async () => ({
                  ...(await statement.bind(...values).first()),
                  lastUsedAt: null,
                }),
              }),
            };
          };
        },
      });
    const request = () =>
      new Request(`${ORIGIN}/api/v1/addresses`, {
        headers: { authorization: `Bearer ${key}`, "cf-connecting-ip": "192.0.2.50" },
      });
    expect((await fetchWith(request(), { DB: database(false) })).status).toBe(200);
    expect(statements.some((s) => s.includes("UPDATE api_keys"))).toBe(false);
    expect((await fetchWith(request(), { DB: database(true) })).status).toBe(200);
    expect(statements.some((s) => s.includes("UPDATE api_keys"))).toBe(true);
    const ip = await env.DB.prepare("SELECT last_used_ip AS ip FROM api_keys WHERE id = ?")
      .bind(id)
      .first("ip");
    expect(ip).toBeNull();
  });

  it("checks the rate limit before the key lookup, keyed by client IP", async () => {
    const seen: string[] = [];
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        seen.push(key);
        return { success: false };
      },
    } as unknown as RateLimit;
    const { key } = await apiKey();
    const req = new Request(`${ORIGIN}/api/v1/messages`, {
      headers: { authorization: `Bearer ${key}`, "cf-connecting-ip": "192.0.2.9" },
    });
    const res = await fetchWith(req, { API_LIMITER: limiter, DB: noDatabase });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(seen).toEqual(["192.0.2.9"]);
  });

  it("answers 429 after 120 requests from one IP in a minute", async () => {
    const headers = { authorization: `Bearer mmk_short`, "cf-connecting-ip": "192.0.2.77" };
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) {
      const res = await exports.default.fetch(`${ORIGIN}/api/v1/addresses`, { headers });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 120).every((s) => s === 401)).toBe(true);
    expect(statuses[120]).toBe(429);
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
