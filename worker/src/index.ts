import { Hono } from "hono";

export type Env = {
  ASSETS: Fetcher;
};

export const app = new Hono<{ Bindings: Env }>().basePath("/api");

// Public: liveness probe for deploy checks. Carries no data.
app.get("/health", (c) => c.json({ ok: true }));

app.notFound((c) => c.json({ error: "not_found" }, 404));

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
