import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SESSION_IDLE_MS } from "../src/auth/session";
import { type Client, login, setupOwner } from "./helpers";

const HOUR = 3_600_000;

async function status(client: Client) {
  return (await client.request("GET", "/api/auth/passkeys")).status;
}

const lastSeen = () => env.DB.prepare("SELECT last_seen_at AS t FROM sessions").first<number>("t");

describe("sessions", () => {
  it("stores only a hash of the session token", async () => {
    const { client } = await setupOwner();
    const token = client.cookies.get("mm_session") ?? "";
    const row = await env.DB.prepare("SELECT id FROM sessions").first<{ id: string }>();
    expect(row?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.id).not.toBe(token);
    const lifetime = await env.DB.prepare(
      "SELECT expires_at - created_at AS lifetime FROM sessions",
    ).first<number>("lifetime");
    expect(lifetime).toBe(30 * 24 * HOUR);
  });

  it("ends a session at its absolute expiry even while it is in use", async () => {
    const { client } = await setupOwner();
    expect(await status(client)).toBe(200);
    await env.DB.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ?")
      .bind(Date.now() - 1, Date.now())
      .run();
    expect(await status(client)).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(0);
  });

  it("ends a session after 7 days without use", async () => {
    const { client } = await setupOwner();
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ?")
      .bind(Date.now() - SESSION_IDLE_MS)
      .run();
    expect(await status(client)).toBe(401);
    expect(await client.json("GET", "/api/auth/state")).toMatchObject({ authenticated: false });
  });

  it("refreshes last_seen_at at most once an hour", async () => {
    const { client } = await setupOwner();
    const recent = Date.now() - HOUR / 2;
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ?").bind(recent).run();
    expect(await status(client)).toBe(200);
    expect(await lastSeen()).toBe(recent);

    const old = Date.now() - 2 * HOUR;
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ?").bind(old).run();
    expect(await status(client)).toBe(200);
    expect(await lastSeen()).toBeGreaterThan(old);
  });

  it("logs out: deletes the session and clears the cookie", async () => {
    const { client } = await setupOwner();
    await client.json("POST", "/api/auth/logout", {});
    expect(client.cookies.has("mm_session")).toBe(false);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(0);
  });

  it("lists sessions and signs out every other session", async () => {
    const owner = await setupOwner();
    const other = await login(owner.authenticator);
    const list = await owner.client.json("GET", "/api/auth/sessions");
    const sessions = list.sessions as { current: boolean }[];
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions[0]).not.toHaveProperty("id");

    expect(await owner.client.json("DELETE", "/api/auth/sessions/others")).toEqual({ revoked: 1 });
    expect(await status(other.client)).toBe(401);
    expect(await status(owner.client)).toBe(200);
  });

  it("hides ended sessions from the list and removes expired ones at the next login", async () => {
    const owner = await setupOwner();
    const insert = env.DB.prepare(
      "INSERT INTO sessions (id, created_at, expires_at, last_seen_at) VALUES (?, 0, ?, ?)",
    );
    const now = Date.now();
    await insert.bind("expired", now - 1, now).run();
    await insert.bind("idle", now + HOUR, now - SESSION_IDLE_MS).run();
    const list = await owner.client.json("GET", "/api/auth/sessions");
    expect(list.sessions).toHaveLength(1);
    await login(owner.authenticator);
    const ids = await env.DB.prepare("SELECT id FROM sessions").all<{ id: string }>();
    expect(ids.results.map((r) => r.id)).not.toContain("expired");
  });

  it("rejects a forged session cookie", async () => {
    const { client } = await setupOwner();
    client.cookies.set("mm_session", "forged");
    expect(await status(client)).toBe(401);
  });
});
