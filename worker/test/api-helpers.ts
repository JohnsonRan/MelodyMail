import { env, exports } from "cloudflare:workers";
import { newApiKey } from "../src/api/keys";
import { sha256Hex } from "../src/auth/crypto";
import { ORIGIN } from "./helpers";
import { expectDocumented } from "./openapi-check";

// Shared set-up for the API key and /api/v1/ suites.

export const ALL_SCOPES = ["mail:read", "mail:write", "mail:send"];

/** An api_keys row written straight to D1; returns the key and its row id. */
export async function apiKey(
  scopes: string[] = ALL_SCOPES,
  options: { expiresAt?: number | null; lastUsedAt?: number | null } = {},
): Promise<{ key: string; id: number }> {
  const { key, publicId } = newApiKey();
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO api_keys (public_id, token_hash, label, scopes, created_at, expires_at,
       last_used_at) VALUES (?, ?, 'test', ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      publicId,
      await sha256Hex(key),
      JSON.stringify(scopes),
      now,
      options.expiresAt === undefined ? now + 86_400_000 : options.expiresAt,
      options.lastUsedAt ?? null,
    )
    .first<{ id: number }>();
  return { key, id: row?.id as number };
}

/**
 * An /api/v1/ request as a script would send it: no Origin, no cookie, the key as a Bearer
 * token. Every answer is checked against the OpenAPI document.
 */
export async function v1(
  key: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = `${ORIGIN}/api/v1${path}`;
  const res = await exports.default.fetch(url, {
    method,
    headers: {
      "cf-connecting-ip": `203.0.113.${crypto.randomUUID()}`,
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await expectDocumented(method, url, res);
  return res;
}
