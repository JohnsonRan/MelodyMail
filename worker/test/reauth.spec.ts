import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { REAUTH_MS } from "../src/auth/session";
import { Client, login, SoftAuthenticator, setupOwner, totpCode } from "./helpers";

type Json = Record<string, unknown>;

function setReauthAt(value: number | null) {
  return env.DB.prepare("UPDATE sessions SET reauth_at = ?").bind(value).run();
}

async function reauth(client: Client, authenticator: SoftAuthenticator, origin?: string) {
  const start = await client.json("POST", "/api/auth/reauth/options", {});
  const options = start.options as Json;
  const credential = await authenticator.authenticate(options, "mail.test", origin);
  return client.request("POST", "/api/auth/reauth/verify", { credential });
}

// Each sensitive action, with the status it answers once re-authentication is fresh.
const ACTIONS: [name: string, method: string, path: string, freshStatus: number][] = [
  ["start adding a Passkey", "POST", "/api/auth/passkeys/options", 200],
  ["delete a Passkey", "DELETE", "/api/auth/passkeys/unknown", 404],
  ["sign out other sessions", "DELETE", "/api/auth/sessions/others", 200],
  ["regenerate the recovery key", "POST", "/api/auth/recovery-key", 200],
];

describe("step-up re-authentication", () => {
  it.each(ACTIONS)("needs a recent Passkey to %s", async (_name, method, path, freshStatus) => {
    const { client, authenticator } = await setupOwner();
    await setReauthAt(Date.now() - REAUTH_MS - 1);
    const stale = await client.request(method, path, method === "DELETE" ? undefined : {});
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "reauth_required" });

    expect((await reauth(client, authenticator)).status).toBe(200);
    const fresh = await client.request(method, path, method === "DELETE" ? undefined : {});
    expect(fresh.status).toBe(freshStatus);
  });

  it("treats a new sign-in as fresh and expires it after 5 minutes", async () => {
    const owner = await setupOwner();
    const { client } = await login(owner.authenticator);
    expect((await client.request("POST", "/api/auth/recovery-key", {})).status).toBe(200);
    await setReauthAt(Date.now() - REAUTH_MS + 5_000);
    expect((await client.request("POST", "/api/auth/recovery-key", {})).status).toBe(200);
    await setReauthAt(Date.now() - REAUTH_MS - 1);
    expect((await client.request("POST", "/api/auth/recovery-key", {})).status).toBe(403);
  });

  it("treats a session from before the column existed as not fresh", async () => {
    const { client } = await setupOwner();
    await setReauthAt(null);
    expect((await client.request("DELETE", "/api/auth/sessions/others")).status).toBe(403);
  });

  it("lets the owner add a Passkey right after a recovery", async () => {
    const owner = await setupOwner();
    const recovered = new Client();
    const res = await recovered.request("POST", "/api/auth/recover", {
      recoveryKey: owner.recoveryKey,
      totpCode: await totpCode(owner.totpSecret, 1),
    });
    expect(res.status).toBe(200);
    const authenticator = await SoftAuthenticator.create();
    const start = await recovered.json("POST", "/api/auth/passkeys/options", {});
    const credential = await authenticator.register(start.options as Json);
    await recovered.json("POST", "/api/auth/passkeys/verify", { credential });
  });

  it("rejects a re-authentication assertion for another origin and stays stale", async () => {
    const { client, authenticator } = await setupOwner();
    const stale = Date.now() - REAUTH_MS - 1;
    await setReauthAt(stale);
    expect((await reauth(client, authenticator, "https://evil.test")).status).toBe(401);
    expect(await env.DB.prepare("SELECT reauth_at AS t FROM sessions").first("t")).toBe(stale);
  });

  it("refreshes only the current session", async () => {
    const owner = await setupOwner();
    const other = await login(owner.authenticator);
    const stale = Date.now() - REAUTH_MS - 1;
    await setReauthAt(stale);
    expect((await reauth(owner.client, owner.authenticator)).status).toBe(200);
    expect((await other.client.request("POST", "/api/auth/recovery-key", {})).status).toBe(403);
  });

  it("add-passkey survives a step-up between options and verify", async () => {
    const { client, authenticator } = await setupOwner();
    const second = await SoftAuthenticator.create();
    const start = await client.json("POST", "/api/auth/passkeys/options", {});
    const credential = await second.register(start.options as Json);
    // The 5-minute window lapses while the owner is at the authenticator prompt.
    await setReauthAt(Date.now() - REAUTH_MS - 1);
    // What the web app does: on reauth_required, re-authenticate and retry.
    let res = await client.request("POST", "/api/auth/passkeys/verify", { credential });
    if (res.status === 403) {
      expect((await reauth(client, authenticator)).status).toBe(200);
      res = await client.request("POST", "/api/auth/passkeys/verify", { credential });
    }
    expect(res.status, `retry ${res.status} ${await res.clone().text()}`).toBe(200);
  });
});

describe("recovery key regeneration", () => {
  it("returns a new key once and the old key stops working", async () => {
    const owner = await setupOwner();
    const done = await owner.client.json("POST", "/api/auth/recovery-key", {});
    const newKey = done.recoveryKey as string;
    expect(newKey).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);

    const code = await totpCode(owner.totpSecret, 1);
    const old = await new Client().request("POST", "/api/auth/recover", {
      recoveryKey: owner.recoveryKey,
      totpCode: code,
    });
    expect(old.status).toBe(401);
    const fresh = await new Client().request("POST", "/api/auth/recover", {
      recoveryKey: newKey,
      totpCode: code,
    });
    expect(fresh.status).toBe(200);
    const events = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE event = 'recovery_key_regenerated'",
    ).first("n");
    expect(events).toBe(1);
  });
});
