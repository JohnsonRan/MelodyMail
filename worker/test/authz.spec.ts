import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { apiScopes, isPublicHandler } from "../src/routing";
import { ALL_SCOPES, apiKey, v1 } from "./api-helpers";
import { Client } from "./helpers";
import { signedIn } from "./send-helpers";

// The only routes that may answer without a session. Adding one is a reviewed decision.
const PUBLIC = [
  "GET /api/health",
  "GET /api/auth/state",
  "POST /api/auth/setup/options",
  "POST /api/auth/setup/verify",
  "POST /api/auth/login/options",
  "POST /api/auth/login/verify",
  "POST /api/auth/recover",
  // Resend fetches attachments here; HMAC-signed URL (docs/M5-sending.md).
  "GET /api/uploads/:id/blob",
  // Resend delivery events; Svix signature (docs/M5-sending.md).
  "POST /api/webhooks/resend",
  // Telegram updates; secret token header (docs/M5b-telegram.md).
  "POST /api/webhooks/telegram",
];

// Every other route, listed so that a new route fails this file until someone decides.
const GUARDED = [
  "POST /api/auth/logout",
  "GET /api/auth/passkeys",
  "POST /api/auth/passkeys/options",
  "POST /api/auth/passkeys/verify",
  "DELETE /api/auth/passkeys/:id",
  "GET /api/auth/sessions",
  "DELETE /api/auth/sessions/others",
  "POST /api/auth/reauth/options",
  "POST /api/auth/reauth/verify",
  "POST /api/auth/recovery-key",
  "GET /api/domains",
  "POST /api/domains",
  "PATCH /api/domains/:name",
  "DELETE /api/domains/:name",
  "GET /api/domains/:name/dns",
  "POST /api/domains/:name/dns/check",
  "GET /api/addresses",
  "POST /api/addresses",
  "PATCH /api/addresses/:id",
  "DELETE /api/addresses/:id",
  "GET /api/forward-targets",
  "POST /api/forward-targets",
  "DELETE /api/forward-targets/:id",
  "GET /api/messages",
  "PATCH /api/messages",
  "GET /api/messages/:id",
  "GET /api/messages/:id/thread",
  "GET /api/messages/:id/raw",
  "PATCH /api/messages/:id",
  "DELETE /api/messages/:id",
  "GET /api/search",
  "GET /api/counts",
  "GET /api/events",
  "GET /api/push/key",
  "PUT /api/push/subscription",
  "DELETE /api/push/subscription",
  "POST /api/push/test",
  "POST /api/messages/send",
  "GET /api/send/from",
  "GET /api/send/quota",
  "GET /api/contacts",
  "GET /api/drafts",
  "GET /api/drafts/:id",
  "PUT /api/drafts/:id",
  "DELETE /api/drafts/:id",
  "PUT /api/uploads",
  "GET /api/uploads/:id",
  "DELETE /api/uploads/:id",
  "GET /api/telegram",
  "POST /api/telegram/link",
  "DELETE /api/telegram/link",
  "DELETE /api/telegram",
  "POST /api/telegram/test",
  "GET /api/settings/quiet",
  "PUT /api/settings/quiet",
  "GET /api/rules",
  "POST /api/rules",
  "PUT /api/rules/order",
  "POST /api/rules/test",
  "PUT /api/rules/:id",
  "DELETE /api/rules/:id",
  "GET /api/keys",
  "POST /api/keys",
  "DELETE /api/keys/:id",
  "GET /api/openapi.json",
];

// The /api/v1/ routes: an API key only, with one of these scopes (docs/M6-rules-api.md).
const API: Record<string, string[]> = {
  "GET /api/v1/messages": ["mail:read"],
  "GET /api/v1/messages/:id": ["mail:read"],
  "GET /api/v1/messages/:id/thread": ["mail:read"],
  "GET /api/v1/messages/:id/raw": ["mail:read"],
  "GET /api/v1/search": ["mail:read"],
  "GET /api/v1/addresses": ["mail:read", "mail:send"],
  "PATCH /api/v1/messages": ["mail:write"],
  "PATCH /api/v1/messages/:id": ["mail:write"],
  "POST /api/v1/messages/send": ["mail:send"],
};

describe("authorization", () => {
  const endpoints = [
    ...new Map(
      app.routes.filter((r) => r.method !== "ALL").map((r) => [`${r.method} ${r.path}`, r]),
    ).values(),
  ];

  it("knows every registered route", () => {
    const all = endpoints.map((r) => `${r.method} ${r.path}`);
    expect(all.sort()).toEqual([...PUBLIC, ...GUARDED, ...Object.keys(API)].sort());
  });

  it("gives exactly the /api/v1/ routes a key kind with their scopes", () => {
    const marked = endpoints
      .filter((r) => apiScopes(r.handler) !== undefined)
      .map((r) => [`${r.method} ${r.path}`, [...(apiScopes(r.handler) ?? [])]]);
    expect(Object.fromEntries(marked)).toEqual(API);
    expect(endpoints.filter((r) => r.path.startsWith("/api/v1/")).length).toBe(marked.length);
  });

  it("marks exactly the reviewed routes as public", () => {
    const marked = endpoints
      .filter((r) => isPublicHandler(r.handler))
      .map((r) => `${r.method} ${r.path}`);
    expect(marked.sort()).toEqual([...PUBLIC].sort());
  });

  it("answers 401 without a session on every other route", async () => {
    const guarded = endpoints.filter((r) => !PUBLIC.includes(`${r.method} ${r.path}`));
    expect(guarded).toHaveLength(GUARDED.length + Object.keys(API).length);
    for (const route of guarded) {
      const key = `${route.method} ${route.path}`;
      const path = route.path.replaceAll(/:\w+/g, "x");
      const body = route.method === "GET" ? undefined : {};
      const res = await new Client().request(route.method, path, body);
      expect(res.status, key).toBe(401);
      expect(await res.json(), key).toEqual({ error: "unauthorized" });
    }
  });

  // The matrix of docs/M6-rules-api.md, "Authorization matrix", for every registered route.
  it("never lets a key reach a session route", async () => {
    const { key } = await apiKey(ALL_SCOPES);
    const client = new Client();
    for (const route of GUARDED) {
      const [method = "", path = ""] = route.split(" ");
      const headers = { authorization: `Bearer ${key}` };
      const body = method === "GET" ? undefined : {};
      const res = await client.request(method, path.replaceAll(/:\w+/g, "1"), body, headers);
      expect(res.status, route).toBe(401);
      expect(await res.json(), route).toEqual({ error: "unauthorized" });
    }
  });

  it("decides every /api/v1/ route by the key and its scope alone", async () => {
    const session = await signedIn();
    const cookie = [...session.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    for (const [route, scopes] of Object.entries(API)) {
      const [method = "", template = ""] = route.split(" ");
      const path = template.replace("/api/v1", "").replaceAll(/:\w+/g, "x");
      const body = method === "GET" ? undefined : {};
      // A valid session cookie is ignored, with or without a same-origin Origin header.
      const withCookie = await v1(null, method, path, body, {
        cookie,
        origin: "https://mail.test",
      });
      expect(withCookie.status, route).toBe(401);
      expect(await withCookie.json(), route).toEqual({ error: "unauthorized" });

      const others = ALL_SCOPES.filter((s) => !scopes.includes(s));
      const wrong = await v1((await apiKey(others)).key, method, path, body, { cookie });
      expect(wrong.status, route).toBe(403);
      expect(await wrong.json(), route).toEqual({ error: "insufficient_scope" });

      // Any one of the route's scopes is enough, and no Origin header is needed.
      for (const scope of scopes) {
        const right = await v1((await apiKey([scope])).key, method, path, body);
        expect([401, 403], `${route} ${scope}`).not.toContain(right.status);
      }
    }
  });
});
