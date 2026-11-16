import { Hono } from "hono";
import { registerAddressRoutes } from "./addresses/routes";
import { registerTargetRoutes } from "./addresses/targets";
import { registerKeyRoutes } from "./api/keys";
import openapi from "./api/openapi.json";
import { registerApiV1 } from "./api/v1";
import { registerAccountRoutes } from "./auth/account";
import { registerAuthRoutes } from "./auth/routes";
import { registerDomainRoutes } from "./domains/routes";
import type { AppEnv, Env } from "./env";
import { fail, log } from "./http";
import { handleQueue, handleScheduled } from "./mail/consumer";
import { registerEventRoutes } from "./mail/hub";
import { handleEmail } from "./mail/inbound";
import { registerQuietRoutes } from "./mail/quiet";
import { registerMailboxRoutes, registerMessageRoutes } from "./mail/routes";
import { registerPushRoutes } from "./push/routes";
import { publicRoute, requireAuthorization, requireSameOrigin } from "./routing";
import { registerRuleRoutes } from "./rules/routes";
import { registerDraftRoutes } from "./send/drafts";
import { registerSendInfoRoutes } from "./send/info";
import { registerSendRoute } from "./send/send";
import { registerUploadBlobRoute, registerUploadRoutes } from "./send/uploads";
import { registerWebhookRoute } from "./send/webhook";
import { registerTelegramRoutes } from "./telegram/routes";
import { registerTelegramWebhook } from "./telegram/webhook";

export { Hub } from "./mail/hub";
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

// The mailbox: none of these is public.
registerMessageRoutes(app.basePath("/messages"));
registerMailboxRoutes(app);
registerEventRoutes(app);

// Web Push for new mail: none of these is public.
registerPushRoutes(app.basePath("/push"));

// Sending (docs/M5-sending.md). Public: the signed attachment URL Resend fetches and the Resend
// webhook; each checks its own signature.
registerSendRoute(app.basePath("/messages"));
registerSendInfoRoutes(app.basePath("/send"));
registerDraftRoutes(app.basePath("/drafts"));
registerUploadRoutes(app.basePath("/uploads"));
registerUploadBlobRoute(app);
registerWebhookRoute(app);

// Telegram notifications (docs/M5b-telegram.md). Public: the webhook, which checks the secret
// token Telegram sends.
registerTelegramRoutes(app.basePath("/telegram"));
registerTelegramWebhook(app);

// "Quiet while MelodyMail is open" (docs/M5c-foreground.md): not public.
registerQuietRoutes(app.basePath("/settings/quiet"));

// Rules (docs/M6-rules-api.md): not public; no API key reaches them.
registerRuleRoutes(app.basePath("/rules"));

// API keys and their document (docs/M6-rules-api.md): session routes; no API key reaches them.
registerKeyRoutes(app.basePath("/keys"));
app.get("/openapi.json", (c) => c.json(openapi));

// REST API v1: API keys only, never the session cookie (worker/src/routing.ts, apiRoute).
registerApiV1(app.basePath("/v1"));

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
