import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { clientInfo, fail } from "../http";
import { randomBytes, sha256Hex } from "./crypto";

const SESSION_COOKIE = "mm_session";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const SESSION_LIFETIME_MS = 30 * DAY;
export const SESSION_IDLE_MS = 7 * DAY;
const LAST_SEEN_WRITE_MS = HOUR;
export const REAUTH_MS = 5 * 60_000;
export const RECOVERY_FRESH_MS = 30 * 60_000;
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "Strict", path: "/" } as const;

/**
 * Prepares a new session. It counts as freshly re-authenticated: it starts with a Passkey
 * assertion (setup, sign-in) or a successful recovery. The caller runs `insert`, usually in a batch with the change that
 * authenticated the owner, and sets the cookie only after that batch succeeded.
 */
export async function startSession(c: Context<AppEnv>, now: number, fromRecovery = false) {
  const token = isoBase64URL.fromBuffer(randomBytes(32));
  const id = await sha256Hex(token);
  const recoveryFreshUntil = fromRecovery ? now + RECOVERY_FRESH_MS : null;
  const insert = c.env.DB.prepare(
    "INSERT INTO sessions (id, created_at, expires_at, last_seen_at, user_agent, reauth_at, recovery_fresh_until) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, now, now + SESSION_LIFETIME_MS, now, clientInfo(c).userAgent, now, recoveryFreshUntil);
  return { id, token, insert };
}

export function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_LIFETIME_MS / 1000 });
}

export type SessionInfo = {
  id: string;
  reauthAt: number | null;
  recoveryFreshUntil: number | null;
};

/** Returns the session for a valid cookie, or null. Ends an expired or idle session. */
export async function readSession(c: Context<AppEnv>): Promise<SessionInfo | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    "SELECT expires_at AS expiresAt, last_seen_at AS lastSeenAt, reauth_at AS reauthAt, recovery_fresh_until AS recoveryFreshUntil FROM sessions WHERE id = ?",
  )
    .bind(id)
    .first<{
      expiresAt: number;
      lastSeenAt: number;
      reauthAt: number | null;
      recoveryFreshUntil: number | null;
    }>();
  if (!row) return null;
  const now = Date.now();
  if (now >= row.expiresAt || now - row.lastSeenAt >= SESSION_IDLE_MS) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    return null;
  }
  if (now - row.lastSeenAt >= LAST_SEEN_WRITE_MS) {
    await c.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(now, id).run();
  }
  return { id, reauthAt: row.reauthAt, recoveryFreshUntil: row.recoveryFreshUntil };
}

/**
 * Step-up guard for sensitive actions (owner rulings 2026-11-15): the current session must have
 * a Passkey assertion within the last 5 minutes, or be a recovery session inside its window
 * (until the first Passkey is added on it, at most 30 minutes), else 403 reauth_required.
 */
export const requireFreshAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const now = Date.now();
  const reauthAt = c.get("reauthAt");
  const recoveryFreshUntil = c.get("recoveryFreshUntil");
  const recentPasskey = reauthAt !== null && now - reauthAt <= REAUTH_MS;
  const recoveryWindow = recoveryFreshUntil !== null && now < recoveryFreshUntil;
  if (!recentPasskey && !recoveryWindow) return fail(c, 403, "reauth_required");
  return next();
};

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, COOKIE_OPTIONS);
}
