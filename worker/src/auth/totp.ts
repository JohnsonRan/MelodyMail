import { base32Decode, base32Encode, randomBytes } from "./crypto";

// RFC 6238 with the parameters every authenticator app supports: HMAC-SHA-1, 30 s, 6 digits.
const STEP_SECONDS = 30;
const DIGITS = 6;

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpUri(secret: string, account: string): string {
  const label = encodeURIComponent(`MelodyMail:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=MelodyMail&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/** RFC 4226 HOTP value for one counter. */
export async function hotp(key: Uint8Array<ArrayBuffer>, counter: number, digits = DIGITS) {
  const message = new DataView(new ArrayBuffer(8));
  message.setUint32(0, Math.floor(counter / 2 ** 32));
  message.setUint32(4, counter >>> 0);
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, message));
  const offset = (mac[19] ?? 0) & 0x0f;
  const binary = new DataView(mac.buffer, offset, 4).getUint32(0) & 0x7fffffff;
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

/**
 * Checks a code against the previous, current and next step. Returns the matched step, or null.
 * A step at or below `lastStep` is rejected so that a code cannot be replayed.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  nowMs: number,
  lastStep: number,
): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const expected = await hotp(key, step);
    let diff = 0;
    for (let i = 0; i < DIGITS; i++) diff |= expected.charCodeAt(i) ^ code.charCodeAt(i);
    if (diff === 0 && step > lastStep && matched === null) matched = step;
  }
  return matched;
}
