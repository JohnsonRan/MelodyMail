import type { Context } from "hono";
import type { AppEnv } from "../env";
import { log } from "../http";

// Session location (owner request 2026-11-15). The owner's IP is sent to ip.sb, a third party;
// when ip.sb fails or is slow, Cloudflare's own request.cf data is used instead.
const GEOIP_URL = "https://api.ip.sb/geoip/";
const GEOIP_TIMEOUT_MS = 2_000;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The client IP from cf-connecting-ip when it parses as IPv4 or IPv6, else null. */
export function clientIp(c: Context<AppEnv>): string | null {
  const value = c.req.header("cf-connecting-ip")?.trim() ?? "";
  if (value.length > 45) return null;
  const v4 = value.match(IPV4);
  if (v4) return v4.slice(1).every((part) => Number(part) <= 255) ? value : null;
  return /^[0-9a-f:.]+$/i.test(value) && value.includes(":") ? value.toLowerCase() : null;
}

/** Loopback, private, link-local and shared (CGNAT) addresses: nothing to look up. */
export function isLocalIp(ip: string): boolean {
  const mapped = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const v4 = mapped.match(IPV4);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return ip === "::1" || ip === "::" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

type Location = {
  country: string | null;
  region: string | null;
  city: string | null;
  organization: string | null;
  source: "ip.sb" | "cf";
};

const text = (value: unknown) => (typeof value === "string" && value ? value.slice(0, 128) : null);

async function fromIpSb(ip: string): Promise<Location> {
  const res = await fetch(GEOIP_URL + encodeURIComponent(ip), {
    headers: { "user-agent": "MelodyMail" },
    signal: AbortSignal.timeout(GEOIP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  return {
    country: text(data.country_code) ?? text(data.country),
    region: text(data.region),
    city: text(data.city),
    organization: text(data.isp) ?? text(data.organization) ?? text(data.asn_organization),
    source: "ip.sb",
  };
}

function fromCf(cf: Record<string, unknown> | undefined): Location {
  return {
    country: text(cf?.country),
    region: text(cf?.region),
    city: text(cf?.city),
    organization: text(cf?.asOrganization),
    source: "cf",
  };
}

/**
 * Fills in the location of a new session after the response has gone out. It never changes the
 * outcome of the sign-in: every failure ends in the request.cf fallback or a warning.
 */
export async function locateSession(
  db: D1Database,
  sessionId: string,
  ip: string,
  cf: Record<string, unknown> | undefined,
): Promise<void> {
  let location: Location;
  try {
    location = await fromIpSb(ip);
  } catch (err) {
    // The IP is the owner's; the log names only the failure.
    log("warn", "geoip_failed", { reason: err instanceof Error ? err.name : "unknown" });
    location = fromCf(cf);
  }
  try {
    await db
      .prepare(
        "UPDATE sessions SET country = ?, region = ?, city = ?, organization = ?, geo_source = ? WHERE id = ?",
      )
      .bind(
        location.country,
        location.region,
        location.city,
        location.organization,
        location.source,
        sessionId,
      )
      .run();
  } catch (err) {
    log("warn", "geoip_store_failed", { reason: err instanceof Error ? err.name : "unknown" });
  }
}

/** Runs the lookup for a public IP after the response; tests without an ExecutionContext skip it. */
export function scheduleLocate(c: Context<AppEnv>, sessionId: string, ip: string | null): void {
  if (!ip || isLocalIp(ip)) return;
  const task = locateSession(c.env.DB, sessionId, ip, c.req.raw.cf as Record<string, unknown>);
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // No ExecutionContext (a direct app.fetch call): let the task run on its own.
  }
}
