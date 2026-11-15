import type { Context } from "hono";
import type { AppEnv } from "../env";

// Session location (owner ruling G, amended 2026-11-16): taken only from Cloudflare's own
// request.cf, which comes with every request at no cost. No third party sees the owner's IP.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The client IP from cf-connecting-ip when it parses as IPv4 or IPv6, else null. */
export function clientIp(c: Context<AppEnv>): string | null {
  const value = c.req.header("cf-connecting-ip")?.trim() ?? "";
  if (value.length > 45) return null;
  const v4 = value.match(IPV4);
  if (v4) return v4.slice(1).every((part) => Number(part) <= 255) ? value : null;
  return /^[0-9a-f:.]+$/i.test(value) && value.includes(":") ? value.toLowerCase() : null;
}

/** Loopback, private, link-local and shared (CGNAT) addresses: no location to show. */
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

export type SessionLocation = {
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  organization: string | null;
  /** "cf" when request.cf gave a location, "local" for a local address, else null. */
  geoSource: "cf" | "local" | null;
};

const text = (value: unknown) => (typeof value === "string" && value ? value.slice(0, 128) : null);

/** Where the request comes from, for the session it opens. */
export function sessionLocation(c: Context<AppEnv>): SessionLocation {
  const ip = clientIp(c);
  const none = { country: null, region: null, city: null, organization: null };
  if (ip && isLocalIp(ip)) return { ip, ...none, geoSource: "local" };
  const cf = c.req.raw.cf as Record<string, unknown> | undefined;
  const found = {
    country: text(cf?.country),
    region: text(cf?.region),
    city: text(cf?.city),
    organization: text(cf?.asOrganization),
  };
  const any = Object.values(found).some((v) => v !== null);
  return any ? { ip, ...found, geoSource: "cf" } : { ip, ...none, geoSource: null };
}
