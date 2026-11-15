import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { clientInfo, str } from "../http";
import { base32Encode, randomBytes, sha256Hex } from "./crypto";

// Writes shared by the public auth routes and the signed-in account routes.

type Ctx = Context<AppEnv>;

export type NewPasskey = {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports?: string[];
};

export function audit(c: Ctx, event: string, now: number): D1PreparedStatement {
  const { ip, userAgent } = clientInfo(c);
  return c.env.DB.prepare(
    "INSERT INTO audit_log (event, created_at, ip, user_agent) VALUES (?, ?, ?, ?)",
  ).bind(event, now, ip, userAgent);
}

export function passkeyInsert(c: Ctx, credential: NewPasskey, label: string, now: number) {
  return c.env.DB.prepare(
    "INSERT INTO passkeys (id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(
    credential.id,
    isoBase64URL.fromBuffer(credential.publicKey),
    credential.counter,
    JSON.stringify(credential.transports ?? []),
    label,
    now,
  );
}

export function passkeyLabel(value: unknown): string {
  return str(typeof value === "string" ? value.trim() : value, 64) ?? "Passkey";
}

/** 160 random bits as 8 groups of 4 base32 characters. */
export function newRecoveryKey(): string {
  return (base32Encode(randomBytes(20)).match(/.{4}/g) ?? []).join("-");
}

export function hashRecoveryKey(key: string): Promise<string> {
  return sha256Hex(key.replace(/[^0-9a-z]/gi, "").toUpperCase());
}
