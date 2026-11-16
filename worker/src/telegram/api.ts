import type { Env } from "../env";
import { log } from "../http";

// The Bot API calls M5b makes (docs/M5b-telegram.md, "Libraries"): a typed wrapper over fetch.
// The token is part of every request URL, so neither the URL nor a fetch error's message is ever
// logged; a failure is logged with the method, the HTTP status, Telegram's error_code and a fixed
// classification, never Telegram's description.

export const BOT_API_TIMEOUT_MS = 10_000;

export type Failure =
  | "not_modified"
  | "blocked"
  | "chat_not_found"
  | "widget_refused"
  | "rate_limited"
  | "other";

export type CallResult<T> =
  | { ok: true; result: T }
  | { ok: false; status: number | null; kind: Failure };

type Answer = {
  ok?: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
};

/** The fixed classification of a failed call; reads the description, never passes it on. */
function classify(status: number | null, description: string): Failure {
  if (status === 429) return "rate_limited";
  if (status === 403) return "blocked";
  if (status === 400) {
    if (description.includes("message is not modified")) return "not_modified";
    if (description.includes("chat not found")) return "chat_not_found";
    if (description.includes("WIDGET")) return "widget_refused";
  }
  return "other";
}

/** Calls one Bot API method with a JSON body. Never throws; a failure is logged and returned. */
export async function callBot<T>(
  env: Env,
  method: string,
  body: Record<string, unknown>,
  options: { timeoutMs?: number; messageId?: string } = {},
): Promise<CallResult<T>> {
  const token = env.TELEGRAM_BOT_TOKEN ?? "";
  let res: Response;
  try {
    res = await fetch(`${env.TELEGRAM_API_URL}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? BOT_API_TIMEOUT_MS),
    });
  } catch (err) {
    log("warn", "telegram_call_failed", {
      messageId: options.messageId ?? null,
      method,
      status: null,
      kind: "other",
      error: err instanceof Error ? err.name : "unknown",
    });
    return { ok: false, status: null, kind: "other" };
  }
  const answer = (await res.json().catch(() => ({}))) as Answer;
  if (res.ok && answer.ok === true) return { ok: true, result: answer.result as T };
  const kind = classify(res.status, String(answer.description ?? ""));
  // An edit that changes nothing is a success for the caller; it is not worth a warning.
  log(kind === "not_modified" ? "info" : "warn", "telegram_call_failed", {
    messageId: options.messageId ?? null,
    method,
    status: res.status,
    errorCode: typeof answer.error_code === "number" ? answer.error_code : null,
    kind,
  });
  return { ok: false, status: res.status, kind };
}
