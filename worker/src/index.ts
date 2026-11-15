import { Hono } from "hono";
import { registerAddressRoutes } from "./addresses/routes";
import { registerTargetRoutes } from "./addresses/targets";
import { registerAccountRoutes } from "./auth/account";
import { registerAuthRoutes } from "./auth/routes";
import { registerDomainRoutes } from "./domains/routes";
import type { AppEnv, Env } from "./env";
import { fail, log } from "./http";
import { handleQueue, handleScheduled } from "./mail/consumer";
import { handleEmail } from "./mail/inbound";
import { publicRoute, requireAuthorization, requireSameOrigin } from "./routing";

export type { Env };

export const app = new Hono<AppEnv>().basePath("/api");

app.use("*", requireSameOrigin, requireAuthorization);

// Liveness probe for deploy checks. Carries no data.
publicRoute(app, "GET", "/health", (c) => c.json({ ok: true }));

// basePath shares the router, so these handlers are the ones the authorization check sees.
const auth = app.basePath("/auth");
registerAuthRoutes(auth);
registerAccountRoutes(auth);

// Settings: none of these is public.
registerDomainRoutes(app.basePath("/domains"));
registerAddressRoutes(app.basePath("/addresses"));
registerTargetRoutes(app.basePath("/forward-targets"));

app.notFound((c) => fail(c, 404, "not_found"));
app.onError((err, c) => {
  log("error", "unhandled", { error: err instanceof Error ? err.message : String(err) });
  return fail(c, 500, "internal");
});

export default {
  fetch: app.fetch,
  email: handleEmail,
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env, InboundJob>;
