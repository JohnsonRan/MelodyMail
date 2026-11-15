import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { LOCKOUT_WINDOW_MS } from "../src/auth/lockout";
import { Client, setupOwner, totpCode } from "./helpers";

const UNKNOWN_KEY = "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA";

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

const attempts = () => env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts").first("n");

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
    const wrongKey = await recover(UNKNOWN_KEY, await nextCode(owner.totpSecret));
    const badCode = await recover(owner.recoveryKey, await wrongCode(owner.totpSecret));
    expect(wrongKey.res.status).toBe(401);
    expect(badCode.res.status).toBe(401);
    expect(wrongKey.body).toEqual(badCode.body);
    expect(await attempts()).toBe(2);
  });

  it("locks after 5 failures in 15 minutes, even for the right credentials", async () => {
    const owner = await setupOwner();
    const bad = await wrongCode(owner.totpSecret);
    for (let i = 0; i < 5; i++) {
      expect((await recover(owner.recoveryKey, bad)).res.status).toBe(401);
    }
    const locked = await recover(owner.recoveryKey, await nextCode(owner.totpSecret));
    expect(locked.res.status).toBe(429);
    expect(locked.body.error).toBe("locked");
    expect(locked.body.retryAfter).toBeGreaterThan(890);
    expect(locked.body.retryAfter).toBeLessThanOrEqual(900);
    expect(locked.res.headers.get("retry-after")).toBe(String(locked.body.retryAfter));
    // Attempts while locked are not counted, so they cannot extend the lock.
    expect(await attempts()).toBe(5);
  });

  it("opens again once the 15-minute window has passed", async () => {
    const owner = await setupOwner();
    const bad = await wrongCode(owner.totpSecret);
    for (let i = 0; i < 5; i++) await recover(owner.recoveryKey, bad);
    await env.DB.prepare("UPDATE login_attempts SET created_at = created_at - ?")
      .bind(LOCKOUT_WINDOW_MS)
      .run();
    const res = await recover(owner.recoveryKey, await nextCode(owner.totpSecret));
    expect(res.res.status).toBe(200);
    expect(await attempts()).toBe(0);
  });

  it("opens again when the owner clears login_attempts (the README command)", async () => {
    const owner = await setupOwner();
    const bad = await wrongCode(owner.totpSecret);
    for (let i = 0; i < 5; i++) await recover(owner.recoveryKey, bad);
    await env.DB.prepare("DELETE FROM login_attempts").run();
    const res = await recover(owner.recoveryKey, await nextCode(owner.totpSecret));
    expect(res.res.status).toBe(200);
  });

  it("does not lock when 5 failures spread over more than 15 minutes", async () => {
    const owner = await setupOwner();
    const now = Date.now();
    for (const minutesAgo of [20, 19, 18, 17]) {
      await env.DB.prepare("INSERT INTO login_attempts (scope, created_at) VALUES ('recover', ?)")
        .bind(now - minutesAgo * 60_000)
        .run();
    }
    await recover(owner.recoveryKey, await wrongCode(owner.totpSecret));
    const res = await recover(owner.recoveryKey, await nextCode(owner.totpSecret));
    expect(res.res.status).toBe(200);
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

  it("drops failures older than twice the window", async () => {
    await env.DB.prepare("INSERT INTO login_attempts (scope, created_at) VALUES ('recover', ?)")
      .bind(Date.now() - 2 * LOCKOUT_WINDOW_MS - 1)
      .run();
    await recover(UNKNOWN_KEY, "123456");
    expect(await attempts()).toBe(1);
  });

  it("answers verification_failed before setup", async () => {
    const res = await recover(UNKNOWN_KEY, "123456");
    expect(res.res.status).toBe(401);
    expect(res.body).toEqual({ error: "verification_failed" });
  });
});
