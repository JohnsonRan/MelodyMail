import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "./env";

/** The one error shape. Codes carry no internal or upstream detail. */
export function fail(c: Context<AppEnv>, status: ContentfulStatusCode, error: string) {
  return c.json({ error }, status);
}

/** Reads a JSON object body; returns null for anything else. */
export async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function str(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

export function clientInfo(c: Context<AppEnv>) {
  return {
    ip: c.req.header("cf-connecting-ip") ?? "",
    userAgent: (c.req.header("user-agent") ?? "").slice(0, 256),
  };
}

export function log(level: "debug" | "info" | "warn" | "error", event: string, fields = {}) {
  console[level](JSON.stringify({ level, event, ...fields }));
}

/** An error's message for a log line, with anything that looks like an email address removed. */
export function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/[^\s<>"'@]+@[^\s<>"']+/g, "…");
}
