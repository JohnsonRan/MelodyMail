import type { Handler, Hono, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { readSession } from "./auth/session";
import type { AppEnv } from "./env";
import { fail } from "./http";

// Handlers registered through publicRoute. Every other route needs a session
// (worker/AGENTS.md #authz); the route-walking test in test/authz.spec.ts enforces it.
const publicHandlers = new WeakSet<object>();

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

export function isPublicHandler(handler: object): boolean {
  return publicHandlers.has(handler);
}

/** Default deny: a matched route without the public marker answers 401 without a session. */
export const requireAuthorization: MiddlewareHandler<AppEnv> = async (c, next) => {
  const endpoint = matchedRoutes(c)
    .filter((r) => r.method !== "ALL")
    .at(-1);
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
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    if (c.req.header("origin") !== new URL(c.req.url).origin) return fail(c, 403, "bad_origin");
  }
  return next();
};
