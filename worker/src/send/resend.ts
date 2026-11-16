import { type CreateEmailOptions, Resend } from "resend";
import type { Env } from "../env";

// The one call to Resend (docs/M5-sending.md, "Sending", 3-5), through the official SDK. The SDK
// sends one request and does not retry. Its error message is upstream text: it is never returned
// or logged; only the HTTP status and the error name are kept.

export type Quota = { dailyUsed: number; monthlyUsed: number };

/** Error codes stored on the message and returned to the client. */
export type SendError =
  | "daily_quota_exceeded"
  | "monthly_quota_exceeded"
  | "rate_limited"
  | "send_rejected"
  | "send_failed";

/**
 * Resend still holds the first request under this key, or holds one with another body. The
 * message may be on its way, so the row is left "sending" for the first request to finish.
 */
export type InProgress = "send_in_progress";

const IDEMPOTENCY_CONFLICTS = new Set([
  "concurrent_idempotent_requests",
  "invalid_idempotent_request",
]);

export type SendOutcome =
  | { ok: true; resendId: string; quota: Quota | null }
  | {
      ok: false;
      code: SendError | InProgress;
      status: number | null;
      /** Resend's error name, kept only when it looks like one (a short snake_case word). */
      name: string | null;
      quota: Quota | null;
    };

export type Outgoing = Pick<
  CreateEmailOptions,
  "from" | "to" | "cc" | "bcc" | "subject" | "text" | "html" | "headers"
> & { attachments: { filename: string; path: string }[] };

function count(value: string | undefined): number | null {
  const n = Number(value);
  return value !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function quotaFrom(headers: Record<string, string> | null): Quota | null {
  const daily = count(headers?.["x-resend-daily-quota"]);
  const monthly = count(headers?.["x-resend-monthly-quota"]);
  return daily === null || monthly === null ? null : { dailyUsed: daily, monthlyUsed: monthly };
}

function errorCode(status: number | null, name: string): SendError | InProgress {
  if (status === 409 && IDEMPOTENCY_CONFLICTS.has(name)) return "send_in_progress";
  if (status === 429) {
    if (name === "daily_quota_exceeded" || name === "monthly_quota_exceeded") return name;
    return "rate_limited";
  }
  if (status !== null && status >= 400 && status < 500) return "send_rejected";
  return "send_failed";
}

export async function callResend(
  env: Env,
  apiKey: string,
  email: Outgoing,
  idempotencyKey: string,
): Promise<SendOutcome> {
  const resend = new Resend(apiKey, { baseUrl: env.RESEND_API_URL });
  // Open and click tracking stays off (owner ruling 2026-11-16). Resend sets tracking per domain,
  // not per email; the README tells the owner to leave it off there.
  const { data, error, headers } = await resend.emails.send(email as CreateEmailOptions, {
    idempotencyKey,
  });
  const quota = quotaFrom(headers);
  if (data?.id) return { ok: true, resendId: data.id, quota };
  const status = error?.statusCode ?? null;
  const rawName = typeof error?.name === "string" ? error.name : "";
  return {
    ok: false,
    code: errorCode(status, rawName),
    status,
    name: /^[a-z_]{1,64}$/.test(rawName) ? rawName : null,
    quota,
  };
}
