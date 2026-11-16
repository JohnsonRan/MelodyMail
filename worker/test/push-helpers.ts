import { env } from "cloudflare:workers";
import { vi } from "vitest";

// A browser's side of Web Push, for tests: a subscription with a real P-256 key pair, a stub of
// the push service (no request leaves the test, AGENTS.md hard limits), and RFC 8291 decryption
// written here from the RFC, so a library that encrypts wrongly turns the tests red.

const enc = new TextEncoder();

export const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export const fromB64url = (value: string) => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
};

export type BrowserSubscription = {
  json: { endpoint: string; keys: { p256dh: string; auth: string } };
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  auth: Uint8Array;
};

export async function browserSubscription(
  endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
): Promise<BrowserSubscription> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    json: { endpoint, keys: { p256dh: b64url(publicRaw), auth: b64url(auth) } },
    privateKey: pair.privateKey,
    publicRaw,
    auth,
  };
}

export type Sent = { url: string; headers: Headers; body: Uint8Array };

/** Replaces fetch with a push service that answers `status` and records each request. */
export function stubPushService(status: number | (() => Promise<Response>) = 201): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    sent.push({
      url: request.url,
      headers: request.headers,
      body: new Uint8Array(await request.arrayBuffer()),
    });
    return typeof status === "number" ? new Response(null, { status }) : status();
  });
  return sent;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bits: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits),
  );
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Decrypts an aes128gcm body (RFC 8188 framing, RFC 8291 keys) with the browser's keys. */
export async function decryptPush(body: Uint8Array, sub: BrowserSubscription): Promise<unknown> {
  const salt = body.slice(0, 16);
  const idLength = body[20] ?? 0;
  const serverPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const serverKey = await crypto.subtle.importKey(
    "raw",
    serverPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: serverKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      sub.privateKey,
      256,
    ),
  );
  const keyInfo = concat(enc.encode("WebPush: info\0"), sub.publicRaw, serverPublic);
  const ikm = await hkdf(sub.auth, ecdh, keyInfo, 256);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 96);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ciphertext),
  );
  let end = padded.length - 1;
  while (end > 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error("not a final record");
  return JSON.parse(new TextDecoder().decode(padded.slice(0, end)));
}

/** Checks the VAPID header (RFC 8292): an ES256 JWT signed by `publicKey`; returns its claims. */
export async function vapidClaims(authorization: string, publicKey: string) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
  if (!match) throw new Error(`not a VAPID header: ${authorization}`);
  const [, jwt = "", k = ""] = match;
  if (k !== publicKey) throw new Error("k is not the VAPID public key");
  const [header = "", payload = "", signature = ""] = jwt.split(".");
  const key = await crypto.subtle.importKey(
    "raw",
    fromB64url(publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromB64url(signature),
    enc.encode(`${header}.${payload}`),
  );
  if (!valid) throw new Error("bad VAPID signature");
  return JSON.parse(new TextDecoder().decode(fromB64url(payload))) as {
    aud: string;
    sub: string;
    exp: number;
  };
}

export async function pushRows() {
  const { results } = await env.DB.prepare(
    "SELECT id, session_id AS sessionId, endpoint FROM push_subscriptions ORDER BY created_at",
  ).all<{ id: string; sessionId: string; endpoint: string }>();
  return results;
}

/** A session row written straight to D1, for tests that need many devices. */
export async function insertSession(id: string, now = Date.now(), lastSeenAt = now) {
  await env.DB.prepare(
    "INSERT INTO sessions (id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, now, now + 86_400_000, lastSeenAt)
    .run();
}

export async function insertSubscription(sessionId: string, endpoint: string, createdAt: number) {
  const sub = await browserSubscription(endpoint);
  await env.DB.prepare(
    "INSERT INTO push_subscriptions (id, session_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      sessionId,
      endpoint,
      sub.json.keys.p256dh,
      sub.json.keys.auth,
      createdAt,
    )
    .run();
  return sub;
}
