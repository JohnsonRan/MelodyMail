import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { Client, ORIGIN, SETUP_TOKEN, SoftAuthenticator, setupOwner, totpCode } from "./helpers";

describe("first-run setup", () => {
  it("creates the owner once, signs in, and answers 409 to a second setup", async () => {
    const owner = await setupOwner();
    expect(owner.recoveryKey).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
    expect(await owner.client.json("GET", "/api/auth/state")).toEqual({
      initialized: true,
      authenticated: true,
    });
    const row = await env.DB.prepare("SELECT recovery_key_hash AS h FROM owner").first<{
      h: string;
    }>();
    expect(row?.h).toMatch(/^[0-9a-f]{64}$/);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_challenges").first("n")).toBe(0);
    expect(owner.client.cookies.has("mm_challenge")).toBe(false);

    const again = new Client();
    const res = await again.json(
      "POST",
      "/api/auth/setup/options",
      { setupToken: SETUP_TOKEN },
      409,
    );
    expect(res).toEqual({ error: "already_initialized" });
  });

  it("answers 409 to a replayed setup/verify after success", async () => {
    const client = new Client();
    const authenticator = await SoftAuthenticator.create();
    const start = await client.json("POST", "/api/auth/setup/options", { setupToken: SETUP_TOKEN });
    const secret = (start.totp as { secret: string }).secret;
    const body = {
      setupToken: SETUP_TOKEN,
      credential: await authenticator.register(start.options as Record<string, unknown>),
      totpCode: await totpCode(secret),
    };
    const challengeCookie = client.cookies.get("mm_challenge") ?? "";
    await client.json("POST", "/api/auth/setup/verify", body);
    client.cookies.set("mm_challenge", challengeCookie);
    expect(await client.json("POST", "/api/auth/setup/verify", body, 409)).toEqual({
      error: "already_initialized",
    });
  });

  it("rejects a wrong setup token", async () => {
    const client = new Client();
    const res = await client.json(
      "POST",
      "/api/auth/setup/options",
      { setupToken: `${SETUP_TOKEN}x` },
      401,
    );
    expect(res).toEqual({ error: "invalid_setup_token" });
    expect(client.cookies.has("mm_challenge")).toBe(false);
  });

  it("refuses setup while SETUP_TOKEN is shorter than 32 characters", async () => {
    const short = "a".repeat(31);
    const res = await app.fetch(
      new Request(`${ORIGIN}/api/auth/setup/options`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ setupToken: short }),
      }),
      { ...env, SETUP_TOKEN: short },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "setup_disabled" });
  });

  it("lets the owner retry a mistyped TOTP code without a new Passkey", async () => {
    const client = new Client();
    const authenticator = await SoftAuthenticator.create();
    const start = await client.json("POST", "/api/auth/setup/options", { setupToken: SETUP_TOKEN });
    const secret = (start.totp as { secret: string }).secret;
    const credential = await authenticator.register(start.options as Record<string, unknown>);
    const good = await totpCode(secret);
    const wrong = good === "000000" ? "111111" : "000000";
    expect(
      await client.json(
        "POST",
        "/api/auth/setup/verify",
        { setupToken: SETUP_TOKEN, credential, totpCode: wrong },
        401,
      ),
    ).toEqual({ error: "verification_failed" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM owner").first("n")).toBe(0);
    await client.json("POST", "/api/auth/setup/verify", {
      setupToken: SETUP_TOKEN,
      credential,
      totpCode: good,
    });
  });

  async function startSetup() {
    const client = new Client();
    const authenticator = await SoftAuthenticator.create();
    const start = await client.json("POST", "/api/auth/setup/options", { setupToken: SETUP_TOKEN });
    const secret = (start.totp as { secret: string }).secret;
    return { client, authenticator, options: start.options as Record<string, unknown>, secret };
  }

  it("lets only one of two concurrent setups win", async () => {
    const { client, authenticator, options, secret } = await startSetup();
    const body = {
      setupToken: SETUP_TOKEN,
      credential: await authenticator.register(options),
      totpCode: await totpCode(secret),
    };
    const results = await Promise.all([
      client.request("POST", "/api/auth/setup/verify", body),
      client.request("POST", "/api/auth/setup/verify", body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(loser?.headers.getSetCookie().some((c) => c.startsWith("mm_session="))).toBe(false);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(1);
  });

  it("rejects setup/verify without the challenge from setup/options", async () => {
    const { client, authenticator, options, secret } = await startSetup();
    client.cookies.delete("mm_challenge");
    const body = {
      setupToken: SETUP_TOKEN,
      credential: await authenticator.register(options),
      totpCode: await totpCode(secret),
    };
    await client.json("POST", "/api/auth/setup/verify", body, 401);
  });

  it("rejects an expired setup challenge", async () => {
    const { client, authenticator, options, secret } = await startSetup();
    await env.DB.prepare("UPDATE auth_challenges SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    const body = {
      setupToken: SETUP_TOKEN,
      credential: await authenticator.register(options),
      totpCode: await totpCode(secret),
    };
    await client.json("POST", "/api/auth/setup/verify", body, 401);
  });

  it("rejects a Passkey registered for another origin", async () => {
    const { client, authenticator, options, secret } = await startSetup();
    const body = {
      setupToken: SETUP_TOKEN,
      credential: await authenticator.register(options, "https://evil.test"),
      totpCode: await totpCode(secret),
    };
    await client.json("POST", "/api/auth/setup/verify", body, 401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM owner").first("n")).toBe(0);
  });
});
