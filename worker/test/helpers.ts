import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { base32Decode } from "../src/auth/crypto";
import { hotp, totpStep } from "../src/auth/totp";
import { ORIGIN, SoftAuthenticator } from "./soft-authenticator";

export { ORIGIN, SoftAuthenticator };

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
