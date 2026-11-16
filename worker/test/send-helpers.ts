import { env, exports } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { vi } from "vitest";
import { sha256Hex } from "../src/auth/crypto";
import { Client, ORIGIN } from "./helpers";
import { addAddress } from "./mail-helpers";

// Shared set-up for the sending suites. Resend is never reached: `stubResend` answers every
// request to RESEND_API_URL and records it; any other outbound request still fails.

/** A signed-in client without the Passkey ceremony: a session row and its cookie. */
export async function signedIn(): Promise<Client> {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?)",
  )
    .bind(await sha256Hex(token), now, now + 86_400_000, now)
    .run();
  const client = new Client();
  client.cookies.set("mm_session", token);
  return client;
}

/** An enabled address on a domain with sending turned on; returns its id. */
export async function sender(
  localPart = "me",
  options: { domain?: string; enabled?: boolean; send?: boolean; displayName?: string } = {},
): Promise<number> {
  const domain = options.domain ?? "example.com";
  const id = await addAddress(localPart, { domain, enabled: options.enabled });
  await env.DB.batch([
    env.DB.prepare("UPDATE domains SET send_enabled = ? WHERE name = ?").bind(
      options.send === false ? 0 : 1,
      domain,
    ),
    env.DB.prepare("UPDATE addresses SET display_name = ? WHERE id = ?").bind(
      options.displayName ?? "",
      id,
    ),
  ]);
  return id;
}

export type ResendCall = { headers: Headers; body: Record<string, unknown> };

/** Answers requests to Resend with `answer(n)` (n counts from 0) and records each request. */
export function stubResend(answer: (n: number) => Response | Promise<Response>) {
  const calls: ResendCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (!req.url.startsWith(env.RESEND_API_URL)) throw new Error("outbound fetch is off in tests");
    calls.push({ headers: req.headers, body: (await req.json()) as Record<string, unknown> });
    return answer(calls.length - 1);
  });
  return calls;
}

export function resendOk(id = "re_1", daily = 12, monthly = 340): Response {
  return Response.json(
    { id },
    {
      headers: { "x-resend-daily-quota": String(daily), "x-resend-monthly-quota": String(monthly) },
    },
  );
}

/** An error answer as Resend sends it, with upstream text that must never reach the client. */
export function resendError(status: number, name: string): Response {
  return Response.json(
    { statusCode: status, name, message: "UPSTREAM-SECRET-TEXT about the request" },
    { status },
  );
}

export const sendBody = (fromAddressId: number, extra: Record<string, unknown> = {}) => ({
  fromAddressId,
  to: ["friend@example.org"],
  subject: "Hello",
  text: "**Hi**",
  html: "<p><strong>Hi</strong></p>",
  idempotencyKey: crypto.randomUUID(),
  ...extra,
});

/** PUT /api/uploads with a raw body. */
export function upload(client: Client, body: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${ORIGIN}/api/uploads`, {
    method: "PUT",
    headers: {
      origin: ORIGIN,
      cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      "content-type": "text/plain",
      "content-length": String(new TextEncoder().encode(body).byteLength),
      "x-filename": encodeURIComponent("notes.txt"),
      ...headers,
    },
    body,
  });
}

/** A webhook request signed like Svix signs it. */
export function webhookRequest(
  payload: unknown,
  options: { id?: string; at?: Date; secret?: string } = {},
): Request {
  const raw = JSON.stringify(payload);
  const id = options.id ?? `msg_${crypto.randomUUID()}`;
  const at = options.at ?? new Date();
  const signature = new Webhook(options.secret ?? (env.RESEND_WEBHOOK_SECRET as string)).sign(
    id,
    at,
    raw,
  );
  return new Request(`${ORIGIN}/api/webhooks/resend`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(at.getTime() / 1000)),
      "svix-signature": signature,
    },
    body: raw,
  });
}

export async function messageRow(id: string) {
  return env.DB.prepare(
    `SELECT status, error, resend_id AS resendId, direction, thread_key AS threadKey,
       in_reply_to AS inReplyTo, references_hdr AS refs, subject, read FROM messages WHERE id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
}
