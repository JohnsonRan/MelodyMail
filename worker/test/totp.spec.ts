import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode } from "../src/auth/crypto";
import { hotp, totpStep, verifyTotp } from "../src/auth/totp";

// RFC 6238, Appendix B, SHA-1 rows. The key is the ASCII string "12345678901234567890".
const RFC_KEY = new TextEncoder().encode("12345678901234567890");
const SECRET = base32Encode(RFC_KEY);
const VECTORS: [seconds: number, code: string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

const key = () => new Uint8Array(RFC_KEY);

describe("TOTP", () => {
  it.each(VECTORS)("matches RFC 6238 at T=%i", async (seconds, code) => {
    expect(await hotp(key(), totpStep(seconds * 1000), 8)).toBe(code);
    expect(await hotp(key(), totpStep(seconds * 1000))).toBe(code.slice(2));
  });

  it("round-trips base32 and encodes the RFC key", () => {
    expect(SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(SECRET)).toEqual(key());
    expect(base32Encode(new Uint8Array([0xff]))).toBe("74");
    expect(base32Decode("74")).toEqual(new Uint8Array([0xff]));
  });

  it("accepts the previous, current and next step and nothing further", async () => {
    const now = 1111111111 * 1000;
    const step = totpStep(now);
    for (const offset of [-1, 0, 1]) {
      expect(await verifyTotp(SECRET, await hotp(key(), step + offset), now, 0)).toBe(
        step + offset,
      );
    }
    for (const offset of [-2, 2]) {
      expect(await verifyTotp(SECRET, await hotp(key(), step + offset), now, 0)).toBeNull();
    }
  });

  it("rejects a step at or below the last used step", async () => {
    const now = 1111111111 * 1000;
    const step = totpStep(now);
    const code = await hotp(key(), step);
    expect(await verifyTotp(SECRET, code, now, step)).toBeNull();
    expect(await verifyTotp(SECRET, code, now, step - 1)).toBe(step);
  });

  it("rejects malformed codes", async () => {
    // A valid code with a digit appended must not pass on its first six characters.
    const valid = await hotp(key(), totpStep(Date.now()));
    for (const code of ["", "12345", "1234567", "abcdef", " 12345", `${valid}0`]) {
      expect(await verifyTotp(SECRET, code, Date.now(), 0)).toBeNull();
    }
  });
});
