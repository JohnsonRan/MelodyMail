import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GLOBAL_FAILURES, LOCKOUT_WINDOW_MS, PER_IP_FAILURES } from "../src/auth/lockout";
import { Client, setupOwner, totpCode } from "./helpers";

const UNKNOWN_KEY = "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA";
const GLOBAL = "recover";
const ipScope = (client: Client) => `recover:ip:${client.ip}`;

async function recover(recoveryKey: string, code: string, client = new Client()) {
  const res = await client.request("POST", "/api/auth/recover", { recoveryKey, totpCode: code });
  return { client, res, body: (await res.json()) as Record<string, unknown> };
}

// Setup used the current TOTP step, so a first recovery uses the next one.
const nextCode = (secret: string) => totpCode(secret, 1);

async function wrongCode(secret: string): Promise<string> {
  const valid = new Set([
    await totpCode(secret, -1),
    await totpCode(secret),
    await totpCode(secret, 1),
  ]);
  let code = 0;
  while (valid.has(String(code).padStart(6, "0"))) code++;
  return String(code).padStart(6, "0");
}

function attempts(scope?: string) {
  const db = env.DB;
  return scope
    ? db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE scope = ?").bind(scope).first("n")
    : db.prepare("SELECT COUNT(*) AS n FROM login_attempts").first("n");
}

/** Sends `times` wrong attempts (right key, wrong code) from one client, one after another. */
async function fail(secret: string, recoveryKey: string, client: Client, times: number) {
  const bad = await wrongCode(secret);
  for (let i = 0; i < times; i++) await recover(recoveryKey, bad, client);
}

describe("recovery", () => {
  it("signs in, rotates the recovery key, and the old key stops working", async () => {
    const owner = await setupOwner();
    const first = await recover(owner.recoveryKey, await nextCode(owner.totpSecret));
    expect(first.res.status).toBe(200);
    const newKey = first.body.recoveryKey as string;
    expect(newKey).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
    expect(newKey).not.toBe(owner.recoveryKey);
    expect(await first.client.json("GET", "/api/auth/state")).toMatchObject({
      authenticated: true,
    });

    // Open the TOTP window again so that only the key decides.
    await env.DB.prepare("UPDATE owner SET totp_last_step = 0").run();
    const code = await totpCode(owner.totpSecret);
    const old = await recover(owner.recoveryKey, code);
    expect(old.res.status).toBe(401);
    expect(old.body).toEqual({ error: "verification_failed" });
    expect((await recover(newKey, code)).res.status).toBe(200);
  });

  it("accepts the key in lower case with spaces instead of dashes", async () => {
    const owner = await setupOwner();
    const typed = owner.recoveryKey.replaceAll("-", " ").toLowerCase();
    expect((await recover(typed, await nextCode(owner.totpSecret))).res.status).toBe(200);
  });

  it("rejects a replayed TOTP code", async () => {
    const owner = await setupOwner();
    const code = await nextCode(owner.totpSecret);
    const first = await recover(owner.recoveryKey, code);
    expect(first.res.status).toBe(200);
    const replay = await recover(first.body.recoveryKey as string, code);
    expect(replay.res.status).toBe(401);
    expect(replay.body).toEqual({ error: "verification_failed" });
  });

  it("rejects the TOTP code already used by setup", async () => {
    const owner = await setupOwner();
    const res = await recover(owner.recoveryKey, await totpCode(owner.totpSecret));
    expect(res.res.status).toBe(401);
  });

  it("gives the same answer for a wrong key and for a wrong code, and counts both", async () => {
    const owner = await setupOwner();
    const client = new Client();
    const wrongKey = await recover(UNKNOWN_KEY, await nextCode(owner.totpSecret), client);
    const badCode = await recover(owner.recoveryKey, await wrongCode(owner.totpSecret), client);
    expect(wrongKey.res.status).toBe(401);
    expect(badCode.res.status).toBe(401);
    expect(wrongKey.body).toEqual(badCode.body);
    expect(await attempts(ipScope(client))).toBe(2);
    expect(await attempts(GLOBAL)).toBe(2);
    const failed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE event = 'recover_failed'",
    ).first("n");
    expect(failed).toBe(2);
  });

  it("signs out every other session after a successful recovery", async () => {
    const owner = await setupOwner();
    const first = await recover(owner.recoveryKey, await nextCode(owner.totpSecret));
    expect(first.res.status).toBe(200);
    expect((await owner.client.request("GET", "/api/auth/passkeys")).status).toBe(401);
    expect((await first.client.request("GET", "/api/auth/passkeys")).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first("n")).toBe(1);
  });

  it("lets only one of two concurrent recoveries with the same key and code win", async () => {
    const owner = await setupOwner();
    const code = await nextCode(owner.totpSecret);
    const results = await Promise.all([
      recover(owner.recoveryKey, code),
      recover(owner.recoveryKey, code),
    ]);
    expect(results.map((r) => r.res.status).sort()).toEqual([200, 401]);
  });

  it("answers verification_failed before setup", async () => {
    const res = await recover(UNKNOWN_KEY, "123456");
    expect(res.res.status).toBe(401);
    expect(res.body).toEqual({ error: "verification_failed" });
  });
});

describe("recovery lockout", () => {
  it("locks one IP after 5 failures in 15 minutes, even for the right credentials", async () => {
    const owner = await setupOwner();
    const attacker = new Client();
    await fail(owner.totpSecret, owner.recoveryKey, attacker, PER_IP_FAILURES);
    const locked = await recover(owner.recoveryKey, await nextCode(owner.totpSecret), attacker);
    expect(locked.res.status).toBe(429);
    expect(locked.body.error).toBe("locked");
    expect(locked.body.retryAfter).toBeGreaterThan(890);
    expect(locked.body.retryAfter).toBeLessThanOrEqual(900);
    expect(locked.res.headers.get("retry-after")).toBe(String(locked.body.retryAfter));
    // Attempts while locked are not counted, so they cannot extend the lock.
    expect(await attempts(ipScope(attacker))).toBe(PER_IP_FAILURES);
    expect(await attempts(GLOBAL)).toBe(PER_IP_FAILURES);
  });

  it("does not lock the owner when another IP is locked below the global ceiling", async () => {
    const owner = await setupOwner();
    const attacker = new Client();
    await fail(owner.totpSecret, owner.recoveryKey, attacker, PER_IP_FAILURES + 3);
    const res = await recover(owner.recoveryKey, await nextCode(owner.totpSecret));
    expect(res.res.status).toBe(200);
  });

  it("locks every IP after 20 failures in 15 minutes from many IPs", async () => {
    const owner = await setupOwner();
    for (let i = 0; i < GLOBAL_FAILURES / PER_IP_FAILURES; i++) {
      await fail(owner.totpSecret, owner.recoveryKey, new Client(), PER_IP_FAILURES);
    }
    const res = await recover(owner.recoveryKey, await nextCode(owner.totpSecret));
    expect(res.res.status).toBe(429);
    expect(res.body.error).toBe("locked");
    expect(res.body.retryAfter).toBeGreaterThan(890);
  });

  it("evaluates at most 5 of 20 concurrent wrong attempts from one IP", async () => {
    const owner = await setupOwner();
    const bad = await wrongCode(owner.totpSecret);
    const attacker = new Client();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => recover(owner.recoveryKey, bad, attacker)),
    );
    const evaluated = results.filter((r) => r.res.status === 401).length;
    const locked = results.filter((r) => r.res.status === 429).length;
    expect(evaluated).toBeLessThanOrEqual(PER_IP_FAILURES);
    expect(evaluated + locked).toBe(20);
    expect(await attempts(ipScope(attacker))).toBeLessThanOrEqual(PER_IP_FAILURES);
  });

  it("evaluates at most 20 of 40 concurrent wrong attempts from 40 IPs", async () => {
    const owner = await setupOwner();
    const bad = await wrongCode(owner.totpSecret);
    const results = await Promise.all(
      Array.from({ length: 40 }, () => recover(owner.recoveryKey, bad)),
    );
    const evaluated = results.filter((r) => r.res.status === 401).length;
    expect(evaluated).toBeLessThanOrEqual(GLOBAL_FAILURES);
    expect(results.filter((r) => r.res.status === 429).length).toBe(40 - evaluated);
    expect(await attempts(GLOBAL)).toBeLessThanOrEqual(GLOBAL_FAILURES);
  });

  it("opens again once the 15-minute window has passed and clears both counters", async () => {
    const owner = await setupOwner();
    const client = new Client();
    await fail(owner.totpSecret, owner.recoveryKey, client, PER_IP_FAILURES);
    await env.DB.prepare("UPDATE login_attempts SET created_at = created_at - ?")
      .bind(LOCKOUT_WINDOW_MS)
      .run();
    const res = await recover(owner.recoveryKey, await nextCode(owner.totpSecret), client);
    expect(res.res.status).toBe(200);
    expect(await attempts()).toBe(0);
  });

  it("opens again when the owner clears login_attempts (the README command)", async () => {
    const owner = await setupOwner();
    for (let i = 0; i < GLOBAL_FAILURES / PER_IP_FAILURES; i++) {
      await fail(owner.totpSecret, owner.recoveryKey, new Client(), PER_IP_FAILURES);
    }
    await env.DB.prepare("DELETE FROM login_attempts").run();
    const res = await recover(owner.recoveryKey, await nextCode(owner.totpSecret));
    expect(res.res.status).toBe(200);
  });

  it("does not lock when 5 failures from one IP spread over more than 15 minutes", async () => {
    const owner = await setupOwner();
    const client = new Client();
    const now = Date.now();
    for (const minutesAgo of [20, 19, 18, 17]) {
      await env.DB.prepare("INSERT INTO login_attempts (scope, created_at) VALUES (?, ?)")
        .bind(ipScope(client), now - minutesAgo * 60_000)
        .run();
    }
    await recover(owner.recoveryKey, await wrongCode(owner.totpSecret), client);
    const res = await recover(owner.recoveryKey, await nextCode(owner.totpSecret), client);
    expect(res.res.status).toBe(200);
  });

  it("drops failures older than the window from both counters", async () => {
    const client = new Client();
    const old = Date.now() - LOCKOUT_WINDOW_MS - 1;
    for (const scope of [GLOBAL, ipScope(client)]) {
      await env.DB.prepare("INSERT INTO login_attempts (scope, created_at) VALUES (?, ?)")
        .bind(scope, old)
        .run();
    }
    await recover(UNKNOWN_KEY, "123456", client);
    expect(await attempts(GLOBAL)).toBe(1);
    expect(await attempts(ipScope(client))).toBe(1);
  });
});
