import { isoBase64URL } from "@simplewebauthn/server/helpers";

// Signed attachment URLs for Resend (docs/M5-sending.md, "Routes"): Resend fetches each
// attachment from GET /api/uploads/:id/blob?exp=&sig=, where sig is HMAC-SHA256 over the id and
// the expiry with UPLOAD_URL_KEY. The URL names one upload only. The expiry is fixed when the
// sent copy is prepared and stored in it, so every attempt sends the same body under the same
// idempotency key; it lasts as long as Resend keeps that key (24 hours).

export const SIGNED_URL_TTL_S = 24 * 3600;

const encoder = new TextEncoder();

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

const message = (id: string, exp: number) => encoder.encode(`${id}.${exp}`);

export async function signUpload(secret: string, id: string, exp: number): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), message(id, exp));
  return isoBase64URL.fromBuffer(new Uint8Array(mac));
}

/** True for a signature of `id` and `exp` that has not expired. The MAC check is constant-time. */
export async function verifyUpload(
  secret: string,
  id: string,
  exp: string | undefined,
  sig: string | undefined,
  nowS: number,
): Promise<boolean> {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp) || !/^[\w-]{43}$/.test(sig)) return false;
  const expiry = Number(exp);
  if (expiry < nowS) return false;
  const mac = isoBase64URL.toBuffer(sig);
  return crypto.subtle.verify("HMAC", await hmacKey(secret), mac, message(id, expiry));
}

export async function signedBlobUrl(
  origin: string,
  secret: string,
  id: string,
  exp: number,
): Promise<string> {
  const sig = await signUpload(secret, id, exp);
  return `${origin}/api/uploads/${encodeURIComponent(id)}/blob?exp=${exp}&sig=${sig}`;
}
