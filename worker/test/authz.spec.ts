import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { isPublicHandler } from "../src/routing";
import { Client } from "./helpers";

// The only routes that may answer without a session. Adding one is a reviewed decision.
const PUBLIC = [
  "GET /api/health",
  "GET /api/auth/state",
  "POST /api/auth/setup/options",
  "POST /api/auth/setup/verify",
  "POST /api/auth/login/options",
  "POST /api/auth/login/verify",
  "POST /api/auth/recover",
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
];

describe("authorization", () => {
  const endpoints = [
    ...new Map(
      app.routes.filter((r) => r.method !== "ALL").map((r) => [`${r.method} ${r.path}`, r]),
    ).values(),
  ];

  it("knows every registered route", () => {
    const all = endpoints.map((r) => `${r.method} ${r.path}`);
    expect(all.sort()).toEqual([...PUBLIC, ...GUARDED].sort());
  });

  it("marks exactly the reviewed routes as public", () => {
    const marked = endpoints
      .filter((r) => isPublicHandler(r.handler))
      .map((r) => `${r.method} ${r.path}`);
    expect(marked.sort()).toEqual([...PUBLIC].sort());
  });

  it("answers 401 without a session on every other route", async () => {
    const guarded = endpoints.filter((r) => !PUBLIC.includes(`${r.method} ${r.path}`));
    expect(guarded).toHaveLength(GUARDED.length);
    for (const route of guarded) {
      const key = `${route.method} ${route.path}`;
      const path = route.path.replaceAll(/:\w+/g, "x");
      const body = route.method === "GET" ? undefined : {};
      const res = await new Client().request(route.method, path, body);
      expect(res.status, key).toBe(401);
      expect(await res.json(), key).toEqual({ error: "unauthorized" });
    }
  });
});
