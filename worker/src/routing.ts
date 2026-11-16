import type { Handler, Hono, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { authenticateKey, type Scope } from "./api/keys";
import { readSession } from "./auth/session";
import type { AppEnv } from "./env";
import { fail } from "./http";

// Three route kinds (worker/AGENTS.md #authz; docs/M6-rules-api.md, "Authorization matrix"):
// - publicRoute: no credential;
// - apiRoute(scopes): an API key in `Authorization: Bearer`, never the session cookie;
// - every other route: the session cookie, never an API key.
// The route-walking test in test/authz.spec.ts lists every route with its kind.
const publicHandlers = new WeakSet<object>();
// Public handlers that another origin calls (a server-to-server webhook), so the CSRF guard does
// not apply; they authenticate the request by its signature instead.
const crossOriginHandlers = new WeakSet<object>();
// /api/v1/ handlers and the scopes of which a key needs one.
const apiHandlers = new WeakMap<object, readonly Scope[]>();

export function publicRoute(
  app: Hono<AppEnv>,
  method: "GET" | "POST",
  path: string,
  ...handlers: Handler<AppEnv>[]
): void {
  const last = handlers.at(-1);
  if (last) publicHandlers.add(last);
  app.on(method, [path], ...handlers);
}

/** A public POST from another server, verified by its own signature (the Resend webhook). */
export function signedWebhookRoute(app: Hono<AppEnv>, path: string, handler: Handler<AppEnv>) {
  crossOriginHandlers.add(handler);
  publicRoute(app, "POST", path, handler);
}

/**
 * An /api/v1/ route: a key holding one of `scopes`. The handler is wrapped, so a function that a
 * session route also uses is still told apart by its registration.
 */
export function apiRoute(
  v1: Hono<AppEnv>,
  method: "GET" | "POST" | "PATCH",
  path: string,
  scopes: readonly Scope[],
  handler: Handler<AppEnv>,
): void {
  const registered: Handler<AppEnv> = (c, next) => handler(c, next);
  apiHandlers.set(registered, scopes);
  v1.on(method, [path], registered);
}

function endpointOf(c: Parameters<MiddlewareHandler<AppEnv>>[0]) {
  return matchedRoutes(c)
    .filter((r) => r.method !== "ALL")
    .at(-1);
}

export function isPublicHandler(handler: object): boolean {
  return publicHandlers.has(handler);
}

/** The scopes of an /api/v1/ handler, or undefined for any other route. */
export function apiScopes(handler: object): readonly Scope[] | undefined {
  return apiHandlers.get(handler);
}

/**
 * Default deny: a matched route without the public marker answers 401 without its credential:
 * a key for an /api/v1/ route, a session for every other.
 */
export const requireAuthorization: MiddlewareHandler<AppEnv> = async (c, next) => {
  const endpoint = endpointOf(c);
  if (!endpoint || isPublicHandler(endpoint.handler)) return next();
  const scopes = apiScopes(endpoint.handler);
  if (scopes) return (await authenticateKey(c, scopes)) ?? next();
  const session = await readSession(c);
  if (!session) return fail(c, 401, "unauthorized");
  c.set("sessionId", session.id);
  c.set("reauthAt", session.reauthAt);
  c.set("recoveryFreshUntil", session.recoveryFreshUntil);
  return next();
};

/**
 * CSRF guard: a state-changing API request must come from this origin. SameSite=Strict cookies
 * are the second layer. /api/v1/ routes skip it: they accept no ambient credential, and a
 * browser cannot add `Authorization` to a cross-origin request without a preflight, which the
 * Worker never answers.
 */
export const requireSameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  const endpoint = endpointOf(c);
  if (
    endpoint &&
    (crossOriginHandlers.has(endpoint.handler) || apiHandlers.has(endpoint.handler))
  ) {
    return next();
  }
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    if (c.req.header("origin") !== new URL(c.req.url).origin) return fail(c, 403, "bad_origin");
  }
  return next();
};
