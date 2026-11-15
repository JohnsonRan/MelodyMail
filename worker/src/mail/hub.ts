import { DurableObject } from "cloudflare:workers";
import type { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import { errorText, fail, log } from "../http";

// Real-time push (docs/M4-mailbox.md). One Hub holds every open mailbox page as a hibernatable
// WebSocket tagged with its session id hash. Events carry message ids only; the page refetches
// through the authenticated routes. Clients send "ping", which the runtime answers without
// waking the object, so an idle connection is not billed for duration.

/** Set by the Worker after it validated the session; a client cannot reach the Hub directly. */
const SESSION_HEADER = "x-melodymail-session";
/** Close code a page reads as "signed out": it goes to sign-in instead of reconnecting. */
export const SESSION_ENDED = 4001;

export type HubEvent = { type: "message"; id: string };

export class Hub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    const session = request.headers.get(SESSION_HEADER);
    if (!session || request.headers.get("upgrade") !== "websocket") {
      return new Response(null, { status: 400 });
    }
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [session]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Sends the event to every open page; returns how many sockets it reached. */
  notify(event: HubEvent): number {
    const data = JSON.stringify(event);
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
        sent++;
      } catch {
        // A socket closing right now; its page reconnects and refetches.
      }
    }
    return sent;
  }

  /** Closes the pages of ended sessions; returns how many sockets it closed. */
  closeSessions(hashes: string[]): number {
    let closed = 0;
    for (const hash of hashes) {
      for (const ws of this.ctx.getWebSockets(hash)) {
        try {
          ws.close(SESSION_ENDED, "session ended");
          closed++;
        } catch {
          // Already closed.
        }
      }
    }
    return closed;
  }

  // Pages send nothing but "ping" (auto-answered); anything else is ignored.
  override webSocketMessage(): void {}
}

function hub(env: Env) {
  return env.HUB.getByName("hub");
}

/** Tells open pages a message changed. A failure is logged and never fails the caller. */
export async function notifyHub(env: Env, event: HubEvent): Promise<void> {
  try {
    await hub(env).notify(event);
  } catch (err) {
    log("warn", "hub_notify_failed", { messageId: event.id, error: errorText(err) });
  }
}

/** Closes the pages of ended sessions. A failure is logged and never fails the caller. */
export async function closeHubSessions(env: Env, hashes: string[]): Promise<void> {
  if (hashes.length === 0) return;
  try {
    await hub(env).closeSessions(hashes);
  } catch (err) {
    log("warn", "hub_close_failed", { count: hashes.length, error: errorText(err) });
  }
}

export function registerEventRoutes(app: Hono<AppEnv>): void {
  // Guarded like every non-public route. A WebSocket upgrade is a GET, which the CSRF guard lets
  // through, so the Origin is checked here: another site's page could otherwise open the socket
  // with the owner's cookie.
  app.get("/events", async (c) => {
    if (c.req.header("origin") !== new URL(c.req.url).origin) return fail(c, 403, "bad_origin");
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return fail(c, 426, "upgrade_required");
    }
    const headers = new Headers(c.req.raw.headers);
    headers.set(SESSION_HEADER, c.get("sessionId"));
    headers.set("upgrade", "websocket");
    return hub(c.env).fetch(new Request(c.req.raw.url, { headers }));
  });
}
