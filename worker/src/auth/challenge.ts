import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { base64url, randomBytes } from "./crypto";

export type Purpose = "setup" | "login" | "add-passkey";

const CHALLENGE_COOKIE = "mm_challenge";
const CHALLENGE_TTL_MS = 5 * 60_000;
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "Strict",
  path: "/api/auth",
} as const;

export type ChallengeRow = { id: string; challenge: string; totpSecret: string | null };

export async function saveChallenge(
  c: Context<AppEnv>,
  purpose: Purpose,
  challenge: string,
  now: number,
  totpSecret: string | null = null,
): Promise<void> {
  const id = base64url(randomBytes(16));
  const db = c.env.DB;
  await db.batch([
    db.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    db
      .prepare(
        "INSERT INTO auth_challenges (id, purpose, challenge, totp_secret, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(id, purpose, challenge, totpSecret, now + CHALLENGE_TTL_MS),
  ]);
  setCookie(c, CHALLENGE_COOKIE, id, { ...COOKIE_OPTIONS, maxAge: CHALLENGE_TTL_MS / 1000 });
}

/** Reads the live challenge named by the cookie without using it up. */
export async function findChallenge(c: Context<AppEnv>, purpose: Purpose, now: number) {
  const id = getCookie(c, CHALLENGE_COOKIE);
  if (!id) return null;
  return c.env.DB.prepare(
    "SELECT id, challenge, totp_secret AS totpSecret FROM auth_challenges WHERE id = ? AND purpose = ? AND expires_at > ?",
  )
    .bind(id, purpose, now)
    .first<ChallengeRow>();
}

/**
 * Uses up the challenge named by the cookie. The delete and the read are one statement, so two
 * requests with the same challenge cannot both get it.
 */
export async function takeChallenge(c: Context<AppEnv>, purpose: Purpose, now: number) {
  const id = getCookie(c, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, COOKIE_OPTIONS);
  if (!id) return null;
  const row = await c.env.DB.prepare(
    "DELETE FROM auth_challenges WHERE id = ? AND purpose = ? RETURNING challenge, expires_at AS expiresAt",
  )
    .bind(id, purpose)
    .first<{ challenge: string; expiresAt: number }>();
  return row && row.expiresAt > now ? row.challenge : null;
}

export function clearChallengeCookie(c: Context<AppEnv>): void {
  deleteCookie(c, CHALLENGE_COOKIE, COOKIE_OPTIONS);
}
