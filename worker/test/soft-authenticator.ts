import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

// No cloudflare:* imports here, so the Bun benchmark can use this module too.

export const ORIGIN = "https://mail.test";

type Json = Record<string, unknown>;

/** A software Passkey: an ES256 key pair in Web Crypto with attestation format "none". */
export class SoftAuthenticator {
  readonly credentialId = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(16)));
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
        [-2, isoBase64URL.toBuffer(jwk.x ?? "")],
        [-3, isoBase64URL.toBuffer(jwk.y ?? "")],
      ]),
    );
    const credentialId = isoBase64URL.toBuffer(this.credentialId);
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
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
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
    const signed = concat(authData, await sha256(isoBase64URL.toBuffer(clientDataJSON)));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON,
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(derSignature(raw)),
        userHandle: isoBase64URL.fromBuffer(
          new Uint8Array(new TextEncoder().encode("melodymail-owner")),
        ),
      },
      clientExtensionResults: {},
    };
  }
}

function clientData(type: string, challenge: string, origin: string): string {
  const json = JSON.stringify({ type, challenge, origin });
  return isoBase64URL.fromBuffer(new Uint8Array(new TextEncoder().encode(json)));
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
function derSignature(raw: Uint8Array): Uint8Array<ArrayBuffer> {
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
