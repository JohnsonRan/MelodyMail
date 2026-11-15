#!/usr/bin/env bun
/**
 * CPU cost of the two checks a login runs: one Passkey assertion verification and one TOTP
 * check. workerd does not advance performance.now() during computation, so the budget is
 * measured here with the same code under Bun (docs/PLAN.md, section 2, "CPU budget").
 *
 * Usage: bun bench/auth.ts [iterations]
 */
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { base32Encode, randomBytes } from "../src/auth/crypto";
import { hotp, totpStep, verifyTotp } from "../src/auth/totp";
import { ORIGIN, SoftAuthenticator } from "../test/soft-authenticator";

const ITERATIONS = Number(process.argv[2] ?? 200);
const RP_ID = new URL(ORIGIN).hostname;

function summarize(name: string, samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  console.log(
    `${name}: median ${at(0.5).toFixed(3)} ms, p95 ${at(0.95).toFixed(3)} ms, max ${at(1).toFixed(3)} ms (n=${sorted.length})`,
  );
}

async function passkeySamples(): Promise<number[]> {
  const authenticator = await SoftAuthenticator.create();
  const registration = await authenticator.register({ rp: { id: RP_ID }, challenge: "x" });
  const attestation = (registration.response as { attestationObject: string }).attestationObject;
  const { decodeAttestationObject, parseAuthenticatorData } = await import(
    "@simplewebauthn/server/helpers"
  );
  const authData = decodeAttestationObject(isoBase64URL.toBuffer(attestation)).get("authData");
  const publicKey = parseAuthenticatorData(authData).credentialPublicKey;
  if (!publicKey) throw new Error("no public key in the software registration");

  const samples: number[] = [];
  let counter = 0;
  for (let i = 0; i < ITERATIONS + 20; i++) {
    const options = await generateAuthenticationOptions({ rpID: RP_ID, allowCredentials: [] });
    const response = await authenticator.authenticate(
      { challenge: options.challenge },
      RP_ID,
      ORIGIN,
    );
    const start = performance.now();
    const result = await verifyAuthenticationResponse({
      response: response as never,
      expectedChallenge: options.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: { id: authenticator.credentialId, publicKey, counter },
      requireUserVerification: false,
    });
    const elapsed = performance.now() - start;
    if (!result.verified) throw new Error("assertion did not verify");
    counter = result.authenticationInfo.newCounter;
    if (i >= 20) samples.push(elapsed); // the first runs warm up the JIT
  }
  return samples;
}

async function totpSamples(): Promise<number[]> {
  const key = randomBytes(20);
  const secret = base32Encode(key);
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS + 20; i++) {
    const now = Date.now();
    const code = await hotp(key, totpStep(now) + 1);
    const start = performance.now();
    const step = await verifyTotp(secret, code, now, 0);
    const elapsed = performance.now() - start;
    if (step === null) throw new Error("TOTP did not verify");
    if (i >= 20) samples.push(elapsed);
  }
  return samples;
}

console.log(`${navigator.userAgent}, ${process.platform} ${process.arch}`);
summarize("passkey assertion verification", await passkeySamples());
summarize("TOTP check (3 HMAC-SHA-1 steps)", await totpSamples());
