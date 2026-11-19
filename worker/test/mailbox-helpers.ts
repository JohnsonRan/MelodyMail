import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { app } from "../src/index";

export type Seed = {
  id: string;
  addressId?: number;
  receivedAt?: number;
  read?: boolean;
  starred?: boolean;
  archived?: boolean;
  trashed?: boolean;
  trashedAt?: number | null;
  spam?: boolean;
  spamAt?: number | null;
  fromKey?: string | null;
  direction?: "in" | "out";
  status?: "stored" | "parsed" | "parse_failed";
  threadKey?: string | null;
  subject?: string | null;
  from?: string | null;
  snippet?: string | null;
  /** Written to R2 under the row's key; null writes no object. */
  raw?: string | null;
  /** Written to messages_fts as the consumer would. */
  body?: string;
};

export const rawKey = (id: string) => `raw/2026/11/${id}.eml`;

/** A messages row (and its R2 object and FTS row) written straight to storage. */
export async function seedMessage(seed: Seed): Promise<void> {
  const raw = seed.raw === undefined ? `Subject: ${seed.subject ?? ""}\r\n\r\nbody\r\n` : seed.raw;
  if (raw !== null) await env.MAIL.put(rawKey(seed.id), raw);
  await env.DB.prepare(
    `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
       thread_key, subject, from_hdr, to_hdr, snippet, raw_size, r2_key, read, starred, archived,
       trashed, trashed_at, spam, spam_at, from_key, received_at)
     VALUES (?, ?, ?, ?, 'env@example.org', 'shop@example.com', ?, ?, ?, 'shop@example.com', ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      seed.id,
      seed.addressId ?? 1,
      seed.direction ?? "in",
      seed.status ?? "parsed",
      seed.threadKey ?? null,
      seed.subject ?? null,
      seed.from === undefined ? "Sender <sender@example.org>" : seed.from,
      seed.snippet ?? null,
      raw?.length ?? 0,
      rawKey(seed.id),
      seed.read ? 1 : 0,
      seed.starred ? 1 : 0,
      seed.archived ? 1 : 0,
      seed.trashed ? 1 : 0,
      seed.trashedAt ?? (seed.trashed ? Date.now() : null),
      seed.spam ? 1 : 0,
      seed.spamAt ?? (seed.spam ? Date.now() : null),
      seed.fromKey ?? null,
      seed.receivedAt ?? Date.now(),
    )
    .run();
  if (seed.body !== undefined) {
    await env.DB.prepare(
      "INSERT INTO messages_fts (message_id, subject, sender, body) VALUES (?, ?, ?, ?)",
    )
      .bind(seed.id, seed.subject ?? "", seed.from ?? "", seed.body)
      .run();
  }
}

export async function seedMany(seeds: Seed[]): Promise<void> {
  for (const s of seeds) await seedMessage(s);
}

/** Runs the app with some bindings replaced, as the owner's browser would call it. */
export async function fetchWith(request: Request, overrides: Partial<Env>): Promise<Response> {
  return app.fetch(request, { ...env, ...overrides } as Env, createExecutionContext());
}
