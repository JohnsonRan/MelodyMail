import { Hono } from "hono";
import { registerAccountRoutes } from "./auth/account";
import { registerAuthRoutes } from "./auth/routes";
import type { AppEnv, Env } from "./env";
import { fail, log } from "./http";
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

app.notFound((c) => fail(c, 404, "not_found"));
app.onError((err, c) => {
  log("error", "unhandled", { error: err instanceof Error ? err.message : String(err) });
  return fail(c, 500, "internal");
});

/**
 * Inbound mail. Until the address list exists (M2/M3) no address is configured, so every
 * message is rejected before anything is stored: the owner ruled that only addresses added in
 * the panel may receive mail.
 */
export async function handleEmail(message: ForwardableEmailMessage): Promise<void> {
  message.setReject("Address not found");
}

export default {
  fetch: app.fetch,
  email: handleEmail,
} satisfies ExportedHandler<Env>;
