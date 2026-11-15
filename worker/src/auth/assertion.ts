import type { Context } from "hono";
import type { AppEnv } from "../env";
import { fail, readJson, str } from "../http";
import { takeChallenge } from "./challenge";
import { type StoredPasskey, verifyAuthentication } from "./webauthn";

const MAX_CREDENTIAL_ID = 1024;

/**
 * Checks a Passkey assertion against the challenge stored for `purpose` and the matching
 * Passkey. Returns the Passkey id and its new sign counter, or the error response to send.
 * Used by sign-in and by step-up re-authentication.
 */
export async function checkAssertion(
  c: Context<AppEnv>,
  purpose: "login" | "reauth",
  now: number,
): Promise<{ passkeyId: string; counter: number } | Response> {
  const body = await readJson(c);
  const credential = body?.credential as { id?: unknown } | undefined;
  const credentialId = str(credential?.id, MAX_CREDENTIAL_ID);
  if (!credentialId) return fail(c, 400, "bad_request");
  const challenge = await takeChallenge(c, purpose, now);
  if (!challenge) return fail(c, 401, "verification_failed");
  const passkey = await c.env.DB.prepare(
    "SELECT id, public_key AS publicKey, counter, transports FROM passkeys WHERE id = ?",
  )
    .bind(credentialId)
    .first<StoredPasskey>();
  if (!passkey) return fail(c, 401, "verification_failed");
  const counter = await verifyAuthentication(c, credential, challenge, passkey);
  if (counter === null) return fail(c, 401, "verification_failed");
  return { passkeyId: passkey.id, counter };
}

export function counterUpdate(c: Context<AppEnv>, passkeyId: string, counter: number, now: number) {
  return c.env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").bind(
    counter,
    now,
    passkeyId,
  );
}
