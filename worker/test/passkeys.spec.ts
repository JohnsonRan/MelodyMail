import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type Client, login, SoftAuthenticator, setupOwner } from "./helpers";

type Passkey = { id: string; label: string };

async function addPasskey(client: Client, label?: string) {
  const authenticator = await SoftAuthenticator.create();
  const start = await client.json("POST", "/api/auth/passkeys/options", {});
  const credential = await authenticator.register(start.options as Record<string, unknown>);
  await client.json("POST", "/api/auth/passkeys/verify", { credential, label });
  return { authenticator, options: start.options as { excludeCredentials: unknown[] } };
}

describe("passkey management", () => {
  it("adds a second Passkey that can sign in", async () => {
    const { client } = await setupOwner();
    const { authenticator, options } = await addPasskey(client, "Laptop");
    expect(options.excludeCredentials).toHaveLength(1);
    const list = (await client.json("GET", "/api/auth/passkeys")).passkeys as Passkey[];
    expect(list.map((p) => p.label)).toEqual(["Passkey", "Laptop"]);
    expect((await login(authenticator)).res.status).toBe(200);
  });

  it("refuses to delete the last Passkey", async () => {
    const { client, authenticator } = await setupOwner();
    const path = `/api/auth/passkeys/${authenticator.credentialId}`;
    expect(await client.json("DELETE", path, undefined, 409)).toEqual({ error: "last_passkey" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys").first("n")).toBe(1);
  });

  it("deletes a Passkey while another remains, and it can no longer sign in", async () => {
    const { client, authenticator } = await setupOwner();
    const second = await addPasskey(client);
    await client.json("DELETE", `/api/auth/passkeys/${authenticator.credentialId}`);
    expect((await login(authenticator)).res.status).toBe(401);
    const lastPath = `/api/auth/passkeys/${second.authenticator.credentialId}`;
    await client.json("DELETE", lastPath, undefined, 409);
  });

  it("rejects passkeys/verify without its challenge or for another origin", async () => {
    const { client } = await setupOwner();
    const authenticator = await SoftAuthenticator.create();
    const start = await client.json("POST", "/api/auth/passkeys/options", {});
    const options = start.options as Record<string, unknown>;
    const foreign = await authenticator.register(options, "https://evil.test");
    await client.json("POST", "/api/auth/passkeys/verify", { credential: foreign }, 401);
    // The failed attempt used the challenge up.
    const credential = await authenticator.register(options);
    await client.json("POST", "/api/auth/passkeys/verify", { credential }, 401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys").first("n")).toBe(1);
  });

  it("does not accept a login challenge for adding a Passkey", async () => {
    const { client } = await setupOwner();
    const authenticator = await SoftAuthenticator.create();
    const start = await client.json("POST", "/api/auth/passkeys/options", {});
    const login = await client.json("POST", "/api/auth/login/options", {});
    const options = {
      ...(start.options as object),
      challenge: (login.options as { challenge: string }).challenge,
    };
    const credential = await authenticator.register(options);
    await client.json("POST", "/api/auth/passkeys/verify", { credential }, 401);
  });

  it("answers 409 passkey_exists when the same credential is registered again", async () => {
    const { client, authenticator } = await setupOwner();
    const start = await client.json("POST", "/api/auth/passkeys/options", {});
    const credential = await authenticator.register(start.options as Record<string, unknown>);
    const res = await client.json("POST", "/api/auth/passkeys/verify", { credential }, 409);
    expect(res).toEqual({ error: "passkey_exists" });
  });

  it("answers 500 internal, not passkey_exists, when the insert fails for another reason", async () => {
    const { client } = await setupOwner();
    const authenticator = await SoftAuthenticator.create();
    const start = await client.json("POST", "/api/auth/passkeys/options", {});
    const credential = await authenticator.register(start.options as Record<string, unknown>);
    await env.DB.prepare("ALTER TABLE audit_log RENAME TO audit_log_away").run();
    try {
      const res = await client.json("POST", "/api/auth/passkeys/verify", { credential }, 500);
      expect(res).toEqual({ error: "internal" });
    } finally {
      await env.DB.prepare("ALTER TABLE audit_log_away RENAME TO audit_log").run();
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys").first("n")).toBe(1);
  });

  it("answers 404 for an unknown Passkey id", async () => {
    const { client } = await setupOwner();
    await client.json("DELETE", "/api/auth/passkeys/nope", undefined, 404);
  });
});
