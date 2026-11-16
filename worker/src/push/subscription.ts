// Validation of a browser's PushSubscription at the API boundary (docs/M4b-pwa.md, "Routes").
// The Worker POSTs to the endpoint, so only the known push services are accepted: with any
// other host a stolen session could turn the Worker into a request relay.

const EXACT_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com"]);
const HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];
const ENDPOINT_MAX = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** An uncompressed P-256 point: 0x04, then X and Y of 32 bytes each. */
const P256_POINT_BYTES = 65;
const AUTH_BYTES = 16;

export type Subscription = { endpoint: string; p256dh: string; auth: string };

export function isAllowedEndpoint(value: string): boolean {
  if (value.length > ENDPOINT_MAX) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname;
  return (
    EXACT_HOSTS.has(host) ||
    HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)
  );
}

function base64urlBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length > 128 || !BASE64URL.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

/** The subscription from a `PushSubscription.toJSON()` body, or null when it is not acceptable. */
export function parseSubscription(body: Record<string, unknown>): Subscription | null {
  const { endpoint, keys } = body;
  if (typeof endpoint !== "string" || !isAllowedEndpoint(endpoint)) return null;
  if (keys === null || typeof keys !== "object") return null;
  const { p256dh, auth } = keys as Record<string, unknown>;
  const point = base64urlBytes(p256dh);
  const secret = base64urlBytes(auth);
  if (point?.length !== P256_POINT_BYTES || point[0] !== 0x04) return null;
  if (secret?.length !== AUTH_BYTES) return null;
  return { endpoint, p256dh: p256dh as string, auth: auth as string };
}
