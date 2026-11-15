import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { fail, readJson, str } from "../http";
import { publicRoute } from "../routing";
import { clearChallengeCookie, findChallenge, saveChallenge, takeChallenge } from "./challenge";
import { base32Encode, randomBytes, secretsEqual, sha256Hex } from "./crypto";
import { clearFailures, reserveAttempt } from "./lockout";
import { readSession, setSessionCookie, startSession } from "./session";
import { audit, passkeyInsert, passkeyLabel } from "./store";
import { newTotpSecret, totpUri, verifyTotp } from "./totp";
import {
  authenticationOptions,
  registrationOptions,
  relyingParty,
  type StoredPasskey,
  verifyAuthentication,
  verifyRegistration,
} from "./webauthn";

const MIN_SETUP_TOKEN_LENGTH = 32;
const MAX_CREDENTIAL_ID = 1024;

type Ctx = Context<AppEnv>;

/** Abuse guard on every public POST; approximate by design (see wrangler.jsonc). */
const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await c.env.AUTH_LIMITER.limit({ key });
  if (!success) return fail(c, 429, "rate_limited");
  return next();
};

async function isInitialized(c: Ctx): Promise<boolean> {
  return (await c.env.DB.prepare("SELECT 1 AS one FROM owner WHERE id = 1").first()) !== null;
}

/** Returns an error response, or null when the token matches a long enough SETUP_TOKEN. */
async function checkSetupToken(c: Ctx, given: unknown): Promise<Response | null> {
  const configured = c.env.SETUP_TOKEN ?? "";
  if (configured.length < MIN_SETUP_TOKEN_LENGTH) return fail(c, 503, "setup_disabled");
  const token = str(given, 1024);
  if (!token || !(await secretsEqual(token, configured))) {
    return fail(c, 401, "invalid_setup_token");
  }
  return null;
}

/** 160 random bits as 8 groups of 4 base32 characters. */
function newRecoveryKey(): string {
  return (base32Encode(randomBytes(20)).match(/.{4}/g) ?? []).join("-");
}

function hashRecoveryKey(key: string): Promise<string> {
  return sha256Hex(key.replace(/[^0-9a-z]/gi, "").toUpperCase());
}

export function registerAuthRoutes(auth: Hono<AppEnv>): void {
  publicRoute(auth, "GET", "/state", async (c) => {
    const [initialized, session] = await Promise.all([isInitialized(c), readSession(c)]);
    return c.json({ initialized, authenticated: session !== null });
  });

  publicRoute(auth, "POST", "/setup/options", rateLimit, async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, "bad_request");
    if (await isInitialized(c)) return fail(c, 409, "already_initialized");
    const denied = await checkSetupToken(c, body.setupToken);
    if (denied) return denied;
    const now = Date.now();
    const options = await registrationOptions(c, []);
    const totpSecret = newTotpSecret();
    await saveChallenge(c, "setup", options.challenge, now, totpSecret);
    return c.json({
      options,
      totp: { secret: totpSecret, uri: totpUri(totpSecret, relyingParty(c).rpID) },
    });
  });

  publicRoute(auth, "POST", "/setup/verify", rateLimit, async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, "bad_request");
    if (await isInitialized(c)) return fail(c, 409, "already_initialized");
    const denied = await checkSetupToken(c, body.setupToken);
    if (denied) return denied;
    const now = Date.now();
    // The challenge stays usable until setup succeeds, so a mistyped TOTP code can be retried
    // without creating another Passkey.
    const challenge = await findChallenge(c, "setup", now);
    if (!challenge?.totpSecret) return fail(c, 401, "verification_failed");
    const credential = await verifyRegistration(c, body.credential, challenge.challenge);
    const step = await verifyTotp(challenge.totpSecret, String(body.totpCode ?? ""), now, 0);
    if (!credential || step === null) return fail(c, 401, "verification_failed");

    const recoveryKey = newRecoveryKey();
    const session = await startSession(c, now);
    const db = c.env.DB;
    try {
      await db.batch([
        db
          .prepare(
            "INSERT INTO owner (id, totp_secret, totp_last_step, recovery_key_hash, created_at) VALUES (1, ?, ?, ?, ?)",
          )
          .bind(challenge.totpSecret, step, await hashRecoveryKey(recoveryKey), now),
        passkeyInsert(c, credential, passkeyLabel(body.label), now),
        db.prepare("DELETE FROM auth_challenges WHERE id = ?").bind(challenge.id),
        session.insert,
        audit(c, "setup", now),
      ]);
    } catch (err) {
      // A concurrent setup won the single owner row; the batch rolled back as a whole.
      if (await isInitialized(c)) return fail(c, 409, "already_initialized");
      throw err;
    }
    clearChallengeCookie(c);
    setSessionCookie(c, session.token);
    return c.json({ recoveryKey });
  });

  publicRoute(auth, "POST", "/login/options", rateLimit, async (c) => {
    const options = await authenticationOptions(c);
    await saveChallenge(c, "login", options.challenge, Date.now());
    return c.json({ options });
  });

  publicRoute(auth, "POST", "/login/verify", rateLimit, async (c) => {
    const body = await readJson(c);
    const credential = body?.credential as { id?: unknown } | undefined;
    const credentialId = str(credential?.id, MAX_CREDENTIAL_ID);
    if (!credentialId) return fail(c, 400, "bad_request");
    const now = Date.now();
    const challenge = await takeChallenge(c, "login", now);
    if (!challenge) return fail(c, 401, "verification_failed");
    const passkey = await c.env.DB.prepare(
      "SELECT id, public_key AS publicKey, counter, transports FROM passkeys WHERE id = ?",
    )
      .bind(credentialId)
      .first<StoredPasskey>();
    if (!passkey) return fail(c, 401, "verification_failed");
    const counter = await verifyAuthentication(c, credential, challenge, passkey);
    if (counter === null) return fail(c, 401, "verification_failed");

    const session = await startSession(c, now);
    const db = c.env.DB;
    await db.batch([
      db
        .prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
        .bind(counter, now, passkey.id),
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
      session.insert,
      audit(c, "login", now),
    ]);
    setSessionCookie(c, session.token);
    return c.json({ ok: true });
  });

  publicRoute(auth, "POST", "/recover", rateLimit, async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, "bad_request");
    const db = c.env.DB;
    const now = Date.now();
    // The attempt is counted before the credentials are checked; a locked attempt is not.
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const retryAfter = await reserveAttempt(db, ip, now);
    if (retryAfter > 0) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "locked", retryAfter }, 429);
    }
    const owner = await db
      .prepare(
        "SELECT totp_secret AS totpSecret, totp_last_step AS totpLastStep, recovery_key_hash AS recoveryKeyHash FROM owner WHERE id = 1",
      )
      .first<{ totpSecret: string; totpLastStep: number; recoveryKeyHash: string }>();
    // Both factors are always checked and fail with the same answer, so the response does not
    // tell which one was wrong.
    const keyHash = await hashRecoveryKey(str(body.recoveryKey, 128) ?? "");
    const keyOk = owner ? await secretsEqual(keyHash, owner.recoveryKeyHash) : false;
    const code = String(body.totpCode ?? "");
    const step = owner ? await verifyTotp(owner.totpSecret, code, now, owner.totpLastStep) : null;
    if (!owner || !keyOk || step === null) {
      await audit(c, "recover_failed", now).run();
      return fail(c, 401, "verification_failed");
    }

    const recoveryKey = newRecoveryKey();
    // Compare-and-set: of two concurrent requests with the same key and code, one wins.
    const swapped = await db
      .prepare(
        "UPDATE owner SET recovery_key_hash = ?, totp_last_step = ? WHERE id = 1 AND recovery_key_hash = ? AND totp_last_step < ?",
      )
      .bind(await hashRecoveryKey(recoveryKey), step, owner.recoveryKeyHash, step)
      .run();
    if (swapped.meta.changes !== 1) return fail(c, 401, "verification_failed");
    const session = await startSession(c, now);
    await db.batch([session.insert, clearFailures(db, ip), audit(c, "recover", now)]);
    setSessionCookie(c, session.token);
    return c.json({ recoveryKey });
  });
}
