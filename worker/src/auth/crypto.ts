const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compares two strings without an early exit. Both sides are hashed first, so the time does not
 * depend on where they differ or on the length of the secret.
 */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  return hashMatches(a, await sha256Hex(b));
}

/** Whether `value` hashes to `hash` (SHA-256 hex), compared without an early exit. */
export async function hashMatches(value: string, hash: string): Promise<boolean> {
  const hv = await sha256Hex(value);
  let diff = hv.length ^ hash.length;
  for (let i = 0; i < hv.length; i++) diff |= hv.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

/** RFC 4648 base32 without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text.replace(/=+$/, "").toUpperCase()) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error("invalid base32");
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
