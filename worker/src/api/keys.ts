import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Context, Hono } from "hono";
import { base32Encode, randomBytes, sha256Hex } from "../auth/crypto";
import { requireFreshAuth } from "../auth/session";
import { audit } from "../auth/store";
import { parseId } from "../domains/validate";
import type { AppEnv } from "../env";
import { clientInfo, fail, readJson } from "../http";

// API keys for /api/v1/ (docs/M6-rules-api.md, "API keys"). A key is shown once, in the create
// response. Only the SHA-256 of the whole key and its public id are stored; logs and audit rows
// name a key by its public id.

export const SCOPES = ["mail:read", "mail:write", "mail:send"] as const;
export type Scope = (typeof SCOPES)[number];

export const KEYS_MAX = 20;
const LABEL_MAX = 64;
const DAY = 86_400_000;
const LAST_USED_WRITE_MS = 3_600_000;
/** null: a key that never expires (owner ruling 3). */
const EXPIRY_DAYS = [30, 90, 365, null] as const;
const DEFAULT_EXPIRY_DAYS = 90;

/** `mmk_`, 8 base32 characters of public id, `_`, 43 base64url characters of secret. */
export const KEY_PATTERN = /^mmk_[a-z2-7]{8}_[A-Za-z0-9_-]{43}$/;

export function newApiKey(): { key: string; publicId: string } {
  const publicId = base32Encode(randomBytes(5)).toLowerCase();
  const secret = isoBase64URL.fromBuffer(randomBytes(32));
  return { key: `mmk_${publicId}_${secret}`, publicId };
}

type KeyRow = {
  id: number;
  publicId: string;
  label: string;
  scopes: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
};

const KEY_COLUMNS = `id, public_id AS publicId, label, scopes, created_at AS createdAt,
  expires_at AS expiresAt, last_used_at AS lastUsedAt, last_used_ip AS lastUsedIp`;

const toApiKey = (r: KeyRow) => ({ ...r, scopes: JSON.parse(r.scopes) as Scope[] });

function parseScopes(value: unknown): Scope[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((s) => (SCOPES as readonly unknown[]).includes(s))) return null;
  return SCOPES.filter((s) => value.includes(s));
}

function parseExpiry(value: unknown): number | null | undefined {
  if (value === undefined) return DEFAULT_EXPIRY_DAYS;
  return (EXPIRY_DAYS as readonly unknown[]).includes(value) ? (value as number | null) : undefined;
}

/** Settings > API keys: session routes only; creation also needs fresh re-authentication. */
export function registerKeyRoutes(keys: Hono<AppEnv>): void {
  keys.get("/", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT ${KEY_COLUMNS} FROM api_keys ORDER BY created_at DESC, id DESC`,
    ).all<KeyRow>();
    return c.json({ apiKeys: results.map(toApiKey) });
  });

  keys.post("/", requireFreshAuth, async (c) => {
    const body = await readJson(c);
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    const scopes = parseScopes(body?.scopes);
    const days = parseExpiry(body?.expiresInDays);
    if (!label || label.length > LABEL_MAX || !scopes || days === undefined) {
      return fail(c, 400, "bad_request");
    }
    const now = Date.now();
    const expiresAt = days === null ? null : now + days * DAY;
    const { key, publicId } = newApiKey();
    const db = c.env.DB;
    // The cap is part of the INSERT, so two concurrent creations cannot pass 20 together.
    const [inserted] = await db.batch<KeyRow>([
      db
        .prepare(
          `INSERT INTO api_keys (public_id, token_hash, label, scopes, created_at, expires_at)
           SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM api_keys) < ?
           RETURNING ${KEY_COLUMNS}`,
        )
        .bind(
          publicId,
          await sha256Hex(key),
          label,
          JSON.stringify(scopes),
          now,
          expiresAt,
          KEYS_MAX,
        ),
      db
        .prepare(
          `INSERT INTO audit_log (event, created_at, ip, user_agent, detail)
           SELECT 'api_key_created', ?, ?, ?, ? WHERE changes() = 1`,
        )
        .bind(
          now,
          clientInfo(c).ip,
          clientInfo(c).userAgent,
          `${publicId} ${scopes.join(",")} ${days === null ? "never" : `${days}d`}`,
        ),
    ]);
    const row = inserted?.results[0];
    if (!row) return fail(c, 409, "too_many_keys");
    return c.json({ key, apiKey: toApiKey(row) }, 201);
  });

  // No re-authentication: revoking must stay one click in an emergency.
  keys.delete("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return fail(c, 404, "not_found");
    const removed = await c.env.DB.prepare(
      "DELETE FROM api_keys WHERE id = ? RETURNING public_id AS publicId",
    )
      .bind(id)
      .first<{ publicId: string }>();
    if (!removed) return fail(c, 404, "not_found");
    await audit(c, "api_key_revoked", Date.now(), removed.publicId).run();
    return c.json({ ok: true });
  });
}

function unauthorized(c: Context<AppEnv>, error: string) {
  c.header("WWW-Authenticate", "Bearer");
  return fail(c, 401, error);
}

/**
 * Authenticates an /api/v1/ request by its `Authorization: Bearer` key alone; the session cookie
 * is never read. The rate limit runs before any D1 read, and a malformed key is refused before
 * the lookup. Returns an error response, or null when the request may go on.
 */
export async function authenticateKey(
  c: Context<AppEnv>,
  scopes: readonly Scope[],
): Promise<Response | null> {
  const ip = c.req.header("cf-connecting-ip") ?? "";
  const { success } = await c.env.API_LIMITER.limit({ key: ip || "unknown" });
  if (!success) {
    c.header("Retry-After", "60");
    return fail(c, 429, "rate_limited");
  }
  const match = /^Bearer +(\S+) *$/i.exec(c.req.header("authorization") ?? "");
  if (!match) return unauthorized(c, "unauthorized");
  const key = match[1] as string;
  if (!KEY_PATTERN.test(key)) return unauthorized(c, "invalid_key");
  const db = c.env.DB;
  const row = await db
    .prepare(
      "SELECT id, scopes, expires_at AS expiresAt, last_used_at AS lastUsedAt FROM api_keys WHERE token_hash = ?",
    )
    .bind(await sha256Hex(key))
    .first<{ id: number; scopes: string; expiresAt: number | null; lastUsedAt: number | null }>();
  if (!row) return unauthorized(c, "invalid_key");
  const now = Date.now();
  if (row.expiresAt !== null && now >= row.expiresAt) return unauthorized(c, "key_expired");
  const granted = JSON.parse(row.scopes) as Scope[];
  if (!scopes.some((s) => granted.includes(s))) return fail(c, 403, "insufficient_scope");
  if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_WRITE_MS) {
    // Conditional, so concurrent requests in the same hour write once.
    await db
      .prepare(
        `UPDATE api_keys SET last_used_at = ?, last_used_ip = ?
         WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)`,
      )
      .bind(now, ip.slice(0, 64), row.id, now - LAST_USED_WRITE_MS)
      .run();
  }
  return null;
}
