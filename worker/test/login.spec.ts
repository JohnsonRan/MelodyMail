import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Client, login, SoftAuthenticator, setupOwner } from "./helpers";

describe("passkey login", () => {
  it("signs in with the registered Passkey and stores the new counter", async () => {
    const { authenticator } = await setupOwner();
    const { client, res } = await login(authenticator);
    expect(res.status).toBe(200);
    expect(client.cookies.has("mm_session")).toBe(true);
    expect(client.cookies.has("mm_challenge")).toBe(false);
    expect(await client.json("GET", "/api/auth/state")).toEqual({
      initialized: true,
      authenticated: true,
    });
    const row = await env.DB.prepare("SELECT counter, last_used_at AS used FROM passkeys").first<{
      counter: number;
      used: number | null;
    }>();
    expect(row?.counter).toBe(authenticator.counter);
    expect(row?.used).not.toBeNull();
  });

  it("sets the session cookie HttpOnly, Secure and SameSite=Strict", async () => {
    const { authenticator } = await setupOwner();
    const client = new Client();
    const startRes = await client.request("POST", "/api/auth/login/options", {});
    const challenge =
      startRes.headers.getSetCookie().find((c) => c.startsWith("mm_challenge=")) ?? "";
    expect(challenge).toMatch(/HttpOnly/);
    expect(challenge).toMatch(/Secure/);
    expect(challenge).toMatch(/SameSite=Strict/);
    expect(challenge).toMatch(/Path=\/api\/auth/);
    expect(challenge).toMatch(/Max-Age=300/);
    const start = (await startRes.json()) as { options: Record<string, unknown> };
    const credential = await authenticator.authenticate(start.options);
    const res = await client.request("POST", "/api/auth/login/verify", { credential });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("mm_session=")) ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);
  });

  it("rejects a replayed challenge", async () => {
    const { authenticator } = await setupOwner();
    const client = new Client();
    const start = await client.json("POST", "/api/auth/login/options", {});
    const challengeCookie = client.cookies.get("mm_challenge") ?? "";
    const first = await authenticator.authenticate(start.options as Record<string, unknown>);
    await client.json("POST", "/api/auth/login/verify", { credential: first });

    const attacker = new Client();
    attacker.cookies.set("mm_challenge", challengeCookie);
    const second = await authenticator.authenticate(start.options as Record<string, unknown>);
    const res = await attacker.json("POST", "/api/auth/login/verify", { credential: second }, 401);
    expect(res).toEqual({ error: "verification_failed" });
    expect(attacker.cookies.has("mm_session")).toBe(false);
  });

  it("rejects an expired challenge", async () => {
    const { authenticator } = await setupOwner();
    const client = new Client();
    const start = await client.json("POST", "/api/auth/login/options", {});
    await env.DB.prepare("UPDATE auth_challenges SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    const credential = await authenticator.authenticate(start.options as Record<string, unknown>);
    await client.json("POST", "/api/auth/login/verify", { credential }, 401);
  });

  it("drops expired challenges when it stores a new one", async () => {
    const client = new Client();
    await client.json("POST", "/api/auth/login/options", {});
    await env.DB.prepare("UPDATE auth_challenges SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    await client.json("POST", "/api/auth/login/options", {});
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_challenges").first("n")).toBe(1);
  });

  it("rejects a sign counter that went backwards", async () => {
    const { authenticator } = await setupOwner();
    expect((await login(authenticator)).res.status).toBe(200);
    authenticator.counter -= 1; // a cloned authenticator replays an older counter
    const { res } = await login(authenticator);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "verification_failed" });
  });

  it("accepts an authenticator whose counter stays 0", async () => {
    const { authenticator } = await setupOwner();
    for (let i = 0; i < 2; i++) {
      authenticator.counter = -1; // authenticate() increments to 0
      expect((await login(authenticator)).res.status).toBe(200);
    }
  });

  it("rejects an unknown Passkey", async () => {
    await setupOwner();
    const stranger = await SoftAuthenticator.create();
    const { res } = await login(stranger);
    expect(res.status).toBe(401);
  });

  // Origin and RP ID are checked separately, so each case changes only one of them.
  it.each([
    ["another origin", "mail.test", "https://evil.test"],
    ["another RP ID", "evil.test", "https://mail.test"],
  ])("rejects an assertion made for %s", async (_case, rpId, origin) => {
    const { authenticator } = await setupOwner();
    const client = new Client();
    const start = await client.json("POST", "/api/auth/login/options", {});
    const options = start.options as Record<string, unknown>;
    const credential = await authenticator.authenticate(options, rpId, origin);
    await client.json("POST", "/api/auth/login/verify", { credential }, 401);
  });
});

describe("origin check", () => {
  it("answers 403 bad_origin to a POST from another origin or without Origin", async () => {
    const client = new Client();
    for (const origin of ["https://evil.test", ""]) {
      const res = await client.request("POST", "/api/auth/login/options", {}, { origin });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "bad_origin" });
    }
    expect(client.cookies.has("mm_challenge")).toBe(false);
  });

  it("lets a GET through without Origin", async () => {
    const client = new Client();
    const res = await client.request("GET", "/api/auth/state", undefined, { origin: "" });
    expect(res.status).toBe(200);
  });

  it("checks Origin before the session, so a signed-in cross-site POST fails too", async () => {
    const { client } = await setupOwner();
    const res = await client.request(
      "POST",
      "/api/auth/logout",
      {},
      { origin: "https://evil.test" },
    );
    expect(res.status).toBe(403);
  });
});

describe("rate limit", () => {
  it("answers 429 rate_limited after 10 public POSTs from one IP in a minute", async () => {
    const client = new Client();
    for (let i = 0; i < 10; i++) {
      expect((await client.request("POST", "/api/auth/login/options", {})).status).toBe(200);
    }
    const last = await client.request("POST", "/api/auth/login/options", {});
    expect(last.status).toBe(429);
    expect(await last.json()).toEqual({ error: "rate_limited" });
  });
});
