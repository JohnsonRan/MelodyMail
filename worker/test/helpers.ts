import { env, exports } from "cloudflare:workers";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { expect } from "vitest";
import { base32Decode, base64url, base64urlDecode } from "../src/auth/crypto";
import { hotp, totpStep } from "../src/auth/totp";

export const ORIGIN = "https://mail.test";
export const SETUP_TOKEN = env.SETUP_TOKEN ?? "";

type Json = Record<string, unknown>;

/** A browser stand-in: keeps cookies, sends this origin, and uses its own client IP. */
export class Client {
  cookies = new Map<string, string>();
  ip = `198.51.100.${Math.floor(Math.random() * 250)}-${crypto.randomUUID()}`;

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const init: RequestInit = {
      method,
      headers: {
        origin: ORIGIN,
        "cf-connecting-ip": this.ip,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const res = await exports.default.fetch(`${ORIGIN}${path}`, init);
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  async json(method: string, path: string, body?: unknown, expectedStatus = 200): Promise<Json> {
    const res = await this.request(method, path, body);
    const data = (await res.json()) as Json;
    expect(res.status, JSON.stringify(data)).toBe(expectedStatus);
    return data;
  }
}

/** A software Passkey: an ES256 key pair in Web Crypto with attestation format "none". */
export class SoftAuthenticator {
  readonly credentialId = base64url(crypto.getRandomValues(new Uint8Array(16)));
  counter = 0;
  private keys!: CryptoKeyPair;

  static async create(counter = 0): Promise<SoftAuthenticator> {
    const authenticator = new SoftAuthenticator();
    authenticator.counter = counter;
    authenticator.keys = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    return authenticator;
  }

  async register(options: Json, origin = ORIGIN): Promise<Json> {
    const rpId = (options.rp as { id: string }).id;
    const jwk = (await crypto.subtle.exportKey("jwk", this.keys.publicKey)) as JsonWebKey;
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, base64urlDecode(jwk.x ?? "")],
        [-3, base64urlDecode(jwk.y ?? "")],
      ]),
    );
    const credentialId = base64urlDecode(this.credentialId);
    const authData = concat(
      await sha256(new TextEncoder().encode(rpId)),
      new Uint8Array([0x45]), // UP | UV | AT
      uint32(this.counter),
      new Uint8Array(16), // AAGUID
      new Uint8Array([credentialId.length >> 8, credentialId.length & 0xff]),
      credentialId,
      cose,
    );
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]) as never,
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: clientData("webauthn.create", options.challenge as string, origin),
        attestationObject: base64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  async authenticate(options: Json, rpId = "mail.test", origin = ORIGIN): Promise<Json> {
    this.counter += 1;
    const clientDataJSON = clientData("webauthn.get", options.challenge as string, origin);
    const authData = concat(
      await sha256(new TextEncoder().encode(rpId)),
      new Uint8Array([0x05]), // UP | UV
      uint32(this.counter),
    );
    const signed = concat(authData, await sha256(base64urlDecode(clientDataJSON)));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON,
        authenticatorData: base64url(authData),
        signature: base64url(derSignature(raw)),
        userHandle: base64url(new TextEncoder().encode("melodymail-owner")),
      },
      clientExtensionResults: {},
    };
  }
}

/** The TOTP code for a step offset from now. */
export async function totpCode(secret: string, offset = 0): Promise<string> {
  return hotp(base32Decode(secret), totpStep(Date.now()) + offset);
}

export type Owner = {
  client: Client;
  authenticator: SoftAuthenticator;
  totpSecret: string;
  recoveryKey: string;
};

/** Runs the full first-run setup and returns a signed-in client. */
export async function setupOwner(): Promise<Owner> {
  const client = new Client();
  const authenticator = await SoftAuthenticator.create();
  const start = await client.json("POST", "/api/auth/setup/options", { setupToken: SETUP_TOKEN });
  const totpSecret = (start.totp as { secret: string }).secret;
  const credential = await authenticator.register(start.options as Json);
  const done = await client.json("POST", "/api/auth/setup/verify", {
    setupToken: SETUP_TOKEN,
    credential,
    totpCode: await totpCode(totpSecret),
  });
  return { client, authenticator, totpSecret, recoveryKey: done.recoveryKey as string };
}

/** Signs in with a Passkey on a fresh client. */
export async function login(authenticator: SoftAuthenticator, client = new Client()) {
  const start = await client.json("POST", "/api/auth/login/options", {});
  const credential = await authenticator.authenticate(start.options as Json);
  const res = await client.request("POST", "/api/auth/login/verify", { credential });
  return { client, res };
}

function clientData(type: string, challenge: string, origin: string): string {
  return base64url(new TextEncoder().encode(JSON.stringify({ type, challenge, origin })));
}

async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));
}

function uint32(value: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Web Crypto returns r || s; WebAuthn ES256 signatures are DER sequences. */
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let body = bytes.slice(start);
    if ((body[0] ?? 0) & 0x80) body = concat(new Uint8Array([0]), body);
    return concat(new Uint8Array([0x02, body.length]), body);
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}
