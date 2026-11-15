import { env } from "cloudflare:workers";
import { vi } from "vitest";

const encoder = new TextEncoder();

/** A domain, an address on it and its forwarding targets, written straight to D1. */
export async function addAddress(
  localPart: string,
  options: {
    domain?: string;
    enabled?: boolean;
    receive?: boolean;
    forwardOnly?: boolean;
    targets?: string[];
  } = {},
): Promise<number> {
  const domain = options.domain ?? "example.com";
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO domains (name, receive_enabled, created_at) VALUES (?, ?, ?)",
  )
    .bind(domain, options.receive === false ? 0 : 1, now)
    .run();
  const row = await env.DB.prepare(
    `INSERT INTO addresses (local_part, domain, enabled, forward_only, created_at)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(localPart, domain, options.enabled === false ? 0 : 1, options.forwardOnly ? 1 : 0, now)
    .first<{ id: number }>();
  const id = row?.id ?? 0;
  for (const email of options.targets ?? []) {
    await env.DB.prepare("INSERT OR IGNORE INTO forward_targets (email, created_at) VALUES (?, ?)")
      .bind(email, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO address_forwards (address_id, target_id) SELECT ?, id FROM forward_targets WHERE email = ?",
    )
      .bind(id, email)
      .run();
  }
  return id;
}

export const SAMPLE = [
  "From: Sender <sender@example.org>",
  "To: shop@example.com",
  "Subject: Hello",
  "Message-ID: <sample@example.org>",
  "",
  "Body text.",
  "",
].join("\r\n");

/** A stand-in for the message Email Routing hands to email(). */
export function inbound(
  to: string,
  raw: string | Uint8Array = SAMPLE,
  headers: Record<string, string> = {},
) {
  const bytes = typeof raw === "string" ? encoder.encode(raw) : raw;
  return {
    from: "sender@example.org",
    to,
    headers: new Headers(headers),
    raw: new Response(bytes).body as ReadableStream<Uint8Array>,
    rawSize: bytes.byteLength,
    canBeForwarded: true,
    setReject: vi.fn(),
    forward: vi.fn(async (_to: string, _headers?: Headers) => ({ messageId: "" })),
    reply: vi.fn(),
  };
}

export function asMessage(m: ReturnType<typeof inbound>): ForwardableEmailMessage {
  return m as unknown as ForwardableEmailMessage;
}

export type MessageRow = Record<string, unknown> & { id: string; status: string; r2_key: string };

export async function messageRows(): Promise<MessageRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM messages ORDER BY received_at").all();
  return results as MessageRow[];
}

export async function r2Keys(): Promise<string[]> {
  return (await env.MAIL.list()).objects.map((o) => o.key);
}
