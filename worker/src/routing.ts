import type { Handler, Hono, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { readSession } from "./auth/session";
import type { AppEnv } from "./env";
import { fail } from "./http";

// Handlers registered through publicRoute. Every other route needs a session
// (worker/AGENTS.md #authz); the route-walking test in test/authz.spec.ts enforces it.
const publicHandlers = new WeakSet<object>();
// Public handlers that another origin calls (a server-to-server webhook), so the CSRF guard does
// not apply; they authenticate the request by its signature instead.
const crossOriginHandlers = new WeakSet<object>();

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

function endpointOf(c: Parameters<MiddlewareHandler<AppEnv>>[0]) {
  return matchedRoutes(c)
    .filter((r) => r.method !== "ALL")
    .at(-1);
}

export function isPublicHandler(handler: object): boolean {
  return publicHandlers.has(handler);
}

/** Default deny: a matched route without the public marker answers 401 without a session. */
export const requireAuthorization: MiddlewareHandler<AppEnv> = async (c, next) => {
  const endpoint = endpointOf(c);
  if (!endpoint || isPublicHandler(endpoint.handler)) return next();
  const session = await readSession(c);
  if (!session) return fail(c, 401, "unauthorized");
  c.set("sessionId", session.id);
  c.set("reauthAt", session.reauthAt);
  c.set("recoveryFreshUntil", session.recoveryFreshUntil);
  return next();
};

/**
 * CSRF guard: a state-changing API request must come from this origin. SameSite=Strict cookies
 * are the second layer.
 */
export const requireSameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  const endpoint = endpointOf(c);
  if (endpoint && crossOriginHandlers.has(endpoint.handler)) return next();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    if (c.req.header("origin") !== new URL(c.req.url).origin) return fail(c, 403, "bad_origin");
  }
  return next();
};
