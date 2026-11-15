import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { clientInfo } from "../http";
import { randomBytes, sha256Hex } from "./crypto";

const SESSION_COOKIE = "mm_session";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const SESSION_LIFETIME_MS = 30 * DAY;
export const SESSION_IDLE_MS = 7 * DAY;
const LAST_SEEN_WRITE_MS = HOUR;
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "Strict", path: "/" } as const;

/**
 * Prepares a new session. The caller runs `insert`, usually in a batch with the change that
 * authenticated the owner, and sets the cookie only after that batch succeeded.
 */
export async function startSession(c: Context<AppEnv>, now: number) {
  const token = isoBase64URL.fromBuffer(randomBytes(32));
  const insert = c.env.DB.prepare(
    "INSERT INTO sessions (id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?)",
  ).bind(await sha256Hex(token), now, now + SESSION_LIFETIME_MS, now, clientInfo(c).userAgent);
  return { token, insert };
}

export function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_LIFETIME_MS / 1000 });
}

/** Returns the session id for a valid cookie, or null. Ends an expired or idle session. */
export async function readSession(c: Context<AppEnv>): Promise<string | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    "SELECT expires_at AS expiresAt, last_seen_at AS lastSeenAt FROM sessions WHERE id = ?",
  )
    .bind(id)
    .first<{ expiresAt: number; lastSeenAt: number }>();
  if (!row) return null;
  const now = Date.now();
  if (now >= row.expiresAt || now - row.lastSeenAt >= SESSION_IDLE_MS) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    return null;
  }
  if (now - row.lastSeenAt >= LAST_SEEN_WRITE_MS) {
    await c.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(now, id).run();
  }
  return id;
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, COOKIE_OPTIONS);
}
