import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ALL_SCOPES, apiKey, v1 } from "./api-helpers";
import { ORIGIN } from "./helpers";
import { fetchWith } from "./mailbox-helpers";

// How an /api/v1/ request authenticates (docs/M6-rules-api.md, "How a request authenticates"):
// the format check and the rate limit before any D1 read, unknown and expired keys, last used.

const HOUR = 3_600_000;
/** The API_LIMITER period (wrangler.jsonc) and the time the 121 requests may take at most. */
const WINDOW_MS = 60_000;
const WINDOW_MARGIN_MS = 3_000;

/** A D1 stand-in that fails the test on any use. */
const noDatabase = new Proxy({} as D1Database, {
  get() {
    throw new Error("D1 was read");
  },
});

describe("API key authentication", () => {
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
    // The local limiter counts in fixed 60-second windows aligned to the clock, so 121 requests
    // that straddle a minute boundary start a new count. Start with at least WINDOW_MARGIN_MS
    // left in the current window; the requests take well under a second.
    const left = WINDOW_MS - (Date.now() % WINDOW_MS);
    if (left < WINDOW_MARGIN_MS) await new Promise((resolve) => setTimeout(resolve, left + 50));
    const window = Math.floor(Date.now() / WINDOW_MS);
    const headers = { authorization: `Bearer mmk_short`, "cf-connecting-ip": "192.0.2.77" };
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) {
      const res = await exports.default.fetch(`${ORIGIN}/api/v1/addresses`, { headers });
      statuses.push(res.status);
    }
    expect(Math.floor(Date.now() / WINDOW_MS), "the requests stayed in one window").toBe(window);
    expect(statuses.slice(0, 120).every((s) => s === 401)).toBe(true);
    expect(statuses[120]).toBe(429);
  });
});
