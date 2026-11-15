import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { log } from "../http";

// One owner, so one stable user handle: an authenticator then treats every Passkey it holds for
// this site as the same account.
const OWNER_USER_ID = new Uint8Array(new TextEncoder().encode("melodymail-owner"));
const TIMEOUT_MS = 5 * 60_000;

/**
 * The library's error text names the failed check but also quotes the expected and received
 * values (challenges, origins). Keep the check, drop the values.
 */
function redact(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/"[^"]*"/g, '"…"').replace(/[A-Za-z0-9_-]{16,}/g, "…");
}

export type StoredPasskey = { id: string; publicKey: string; counter: number; transports: string };

/**
 * RP ID and origin come from the request, so dev on localhost and production use one build.
 * Dev must use localhost: browsers reject an IP address such as 127.0.0.1 as an RP ID.
 */
export function relyingParty(c: Context<AppEnv>) {
  const url = new URL(c.req.url);
  return { rpID: url.hostname, origin: url.origin };
}

export function registrationOptions(c: Context<AppEnv>, existing: StoredPasskey[]) {
  const { rpID } = relyingParty(c);
  return generateRegistrationOptions({
    rpName: "MelodyMail",
    rpID,
    userName: "owner",
    userID: OWNER_USER_ID,
    timeout: TIMEOUT_MS,
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: JSON.parse(p.transports) })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
}

export async function verifyRegistration(
  c: Context<AppEnv>,
  response: unknown,
  expectedChallenge: string,
): Promise<WebAuthnCredential | null> {
  const { rpID, origin } = relyingParty(c);
  try {
    const result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
    return result.verified ? result.registrationInfo.credential : null;
  } catch (err) {
    log("info", "webauthn_registration_rejected", { reason: redact(err) });
    return null;
  }
}

export function authenticationOptions(c: Context<AppEnv>) {
  return generateAuthenticationOptions({
    rpID: relyingParty(c).rpID,
    timeout: TIMEOUT_MS,
    userVerification: "preferred",
    allowCredentials: [],
  });
}

/** Returns the new sign counter, or null. The library rejects a counter that did not increase. */
export async function verifyAuthentication(
  c: Context<AppEnv>,
  response: unknown,
  expectedChallenge: string,
  passkey: StoredPasskey,
): Promise<number | null> {
  const { rpID, origin } = relyingParty(c);
  try {
    const result = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.id,
        publicKey: isoBase64URL.toBuffer(passkey.publicKey),
        counter: passkey.counter,
        transports: JSON.parse(passkey.transports),
      },
      requireUserVerification: false,
    });
    return result.verified ? result.authenticationInfo.newCounter : null;
  } catch (err) {
    log("info", "webauthn_authentication_rejected", { reason: redact(err) });
    return null;
  }
}
