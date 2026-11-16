import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { Client, login, ORIGIN, setupOwner, totpCode } from "./helpers";
import { fetchWith } from "./mailbox-helpers";
import {
  browserSubscription,
  decryptPush,
  insertSession,
  insertSubscription,
  pushRows,
  stubPushService,
  vapidClaims,
} from "./push-helpers";

const subscribe = (client: Client, body: unknown) =>
  client.request("PUT", "/api/push/subscription", body);

async function subscribed() {
  const owner = await setupOwner();
  const sub = await browserSubscription();
  expect((await subscribe(owner.client, sub.json)).status).toBe(200);
  return { ...owner, sub };
}

function cookieOf(client: Client) {
  return [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}

describe("push key", () => {
  it("returns the VAPID public key", async () => {
    const { client } = await setupOwner();
    expect(await client.json("GET", "/api/push/key")).toEqual({ key: env.VAPID_PUBLIC_KEY });
  });

  it("answers 404 while push is not configured", async () => {
    const { client } = await setupOwner();
    const req = new Request(`${ORIGIN}/api/push/key`, { headers: { cookie: cookieOf(client) } });
    for (const missing of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) {
      const res = await fetchWith(req.clone(), { [missing]: undefined });
      expect(res.status, missing).toBe(404);
      expect(await res.json()).toEqual({ error: "push_not_configured" });
    }
  });
});

describe("subscription endpoint check", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://jmt17.google.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QGx",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ])("accepts %s", async (endpoint) => {
    const { client } = await setupOwner();
    const sub = await browserSubscription(endpoint);
    expect((await subscribe(client, sub.json)).status).toBe(200);
    expect((await pushRows()).map((r) => r.endpoint)).toEqual([endpoint]);
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://evil.example/fcm/send/abc",
    "https://fcm.googleapis.com@evil.example/",
    "https://user:pw@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://fcm.googleapis.com.evil.example/x",
    "https://push.apple.com/x",
    "https://evilpush.apple.com/x",
    "https://push.apple.com.evil.example/x",
    "https://notify.windows.com.evil.example/x",
    "https://192.0.2.1/x",
    "https://[::1]/x",
    "https://127.0.0.1/x",
    "ftp://fcm.googleapis.com/x",
    "not a url",
    `https://fcm.googleapis.com/${"a".repeat(2100)}`,
  ])("refuses %s", async (endpoint) => {
    const { client } = await setupOwner();
    const sub = await browserSubscription(endpoint);
    const res = await subscribe(client, sub.json);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_subscription" });
    expect(await pushRows()).toEqual([]);
  });

  it("logs the refused push service's host, never the endpoint path", async () => {
    const { client } = await setupOwner();
    const sub = await browserSubscription("https://push.example.net/send/device-secret-path");
    const warn = vi.spyOn(console, "warn");
    expect((await subscribe(client, sub.json)).status).toBe(400);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("push_subscription_rejected"));
    expect(JSON.parse(line ?? "{}")).toMatchObject({ host: "push.example.net" });
    expect(line).not.toContain("device-secret-path");
  });

  it("refuses keys of the wrong length or form", async () => {
    const { client } = await setupOwner();
    const { json } = await browserSubscription();
    const b64 = (bytes: number[]) =>
      btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    const point = (length: number, first = 4) => b64([first, ...new Array(length - 1).fill(7)]);
    const cases: [string, unknown][] = [
      ["p256dh 64 bytes", { ...json.keys, p256dh: point(64) }],
      ["p256dh 66 bytes", { ...json.keys, p256dh: point(66) }],
      ["p256dh compressed", { ...json.keys, p256dh: point(65, 2) }],
      ["p256dh not base64url", { ...json.keys, p256dh: `${json.keys.p256dh.slice(1)}+` }],
      // Standard base64 with padding decodes to the same 65 bytes; only base64url is accepted.
      [
        "p256dh padded base64",
        { ...json.keys, p256dh: `${json.keys.p256dh.replaceAll("-", "+").replaceAll("_", "/")}=` },
      ],
      ["auth 15 bytes", { ...json.keys, auth: b64(new Array(15).fill(1)) }],
      ["auth 17 bytes", { ...json.keys, auth: b64(new Array(17).fill(1)) }],
      ["auth missing", { p256dh: json.keys.p256dh }],
      ["no keys", undefined],
    ];
    for (const [name, keys] of cases) {
      const res = await subscribe(client, { endpoint: json.endpoint, keys });
      expect(res.status, name).toBe(400);
    }
    expect((await subscribe(client, "[]")).status).toBe(400);
    expect(await pushRows()).toEqual([]);
  });
});

describe("subscription store", () => {
  it("upserts by endpoint and keeps one subscription per session", async () => {
    const owner = await setupOwner();
    const first = await browserSubscription();
    await subscribe(owner.client, first.json);
    await subscribe(owner.client, first.json);
    expect(await pushRows()).toHaveLength(1);
    const second = await browserSubscription();
    await subscribe(owner.client, second.json);
    expect((await pushRows()).map((r) => r.endpoint)).toEqual([second.json.endpoint]);
  });

  it("moves an endpoint that another session stored to this session", async () => {
    const owner = await setupOwner();
    const sub = await browserSubscription();
    await subscribe(owner.client, sub.json);
    const other = (await login(owner.authenticator)).client;
    await subscribe(other, sub.json);
    const rows = await pushRows();
    expect(rows).toHaveLength(1);
    await other.request("DELETE", "/api/push/subscription");
    expect(await pushRows()).toEqual([]);
  });

  it("keeps the 10 newest subscriptions", async () => {
    const owner = await setupOwner();
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      await insertSession(`s${i}`, now);
      await insertSubscription(
        `s${i}`,
        `https://fcm.googleapis.com/fcm/send/old${i}`,
        now - 1000 + i,
      );
    }
    const sub = await browserSubscription();
    await subscribe(owner.client, sub.json);
    const endpoints = (await pushRows()).map((r) => r.endpoint);
    expect(endpoints).toHaveLength(10);
    expect(endpoints).not.toContain("https://fcm.googleapis.com/fcm/send/old0");
    expect(endpoints).toContain("https://fcm.googleapis.com/fcm/send/old1");
    expect(endpoints).toContain(sub.json.endpoint);
  });

  it("deletes only the current session's subscription", async () => {
    const owner = await setupOwner();
    await subscribe(owner.client, (await browserSubscription()).json);
    const other = (await login(owner.authenticator)).client;
    const kept = await browserSubscription();
    await subscribe(other, kept.json);
    expect(await owner.client.json("DELETE", "/api/push/subscription")).toEqual({ ok: true });
    expect((await pushRows()).map((r) => r.endpoint)).toEqual([kept.json.endpoint]);
  });
});

describe("subscriptions end with their session", () => {
  it("sign-out removes the device's subscription", async () => {
    const { client } = await subscribed();
    await client.json("POST", "/api/auth/logout", {});
    expect(await pushRows()).toEqual([]);
  });

  it("signing out other sessions removes theirs and keeps this one", async () => {
    const owner = await subscribed();
    const other = (await login(owner.authenticator)).client;
    await subscribe(other, (await browserSubscription()).json);
    await owner.client.json("DELETE", "/api/auth/sessions/others");
    expect((await pushRows()).map((r) => r.endpoint)).toEqual([owner.sub.json.endpoint]);
  });

  it("a recovery removes every other session's subscription", async () => {
    const owner = await subscribed();
    const res = await new Client().request("POST", "/api/auth/recover", {
      recoveryKey: owner.recoveryKey,
      totpCode: await totpCode(owner.totpSecret, 1),
    });
    expect(res.status).toBe(200);
    expect(await pushRows()).toEqual([]);
  });

  it("a kept browser subscription stored again after sign-in delivers again", async () => {
    const { client, authenticator, sub } = await subscribed();
    await client.json("POST", "/api/auth/logout", {});
    await login(authenticator, client);
    expect(await pushRows()).toEqual([]);
    // What the app does when the signed-in shell opens (web/src/pwa/push.ts, resyncSubscription).
    expect((await subscribe(client, sub.json)).status).toBe(200);
    const sent = stubPushService(201);
    expect(await client.json("POST", "/api/push/test", {})).toEqual({ ok: true });
    expect(sent.map((s) => s.url)).toEqual([sub.json.endpoint]);
  });

  it("an expired session's subscription goes when the session is swept", async () => {
    const { client } = await subscribed();
    await env.DB.prepare("UPDATE sessions SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    expect((await client.request("GET", "/api/push/key")).status).toBe(401);
    expect(await pushRows()).toEqual([]);
  });
});

describe("test notification", () => {
  it("sends an encrypted, VAPID-signed message to this device", async () => {
    const { client, sub } = await subscribed();
    const sent = stubPushService(201);
    expect(await client.json("POST", "/api/push/test", {})).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    const [req] = sent;
    if (!req) throw new Error("nothing sent");
    expect(req.url).toBe(sub.json.endpoint);
    expect(req.headers.get("content-encoding")).toBe("aes128gcm");
    expect(req.headers.get("ttl")).toBe("86400");
    expect(req.headers.get("urgency")).toBe("normal");
    const claims = await vapidClaims(
      req.headers.get("authorization") ?? "",
      env.VAPID_PUBLIC_KEY ?? "",
    );
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe(ORIGIN);
    expect(claims.exp * 1000).toBeGreaterThan(Date.now());
    expect(await decryptPush(req.body, sub)).toEqual({ type: "test" });
  });

  it("answers not_subscribed without a subscription", async () => {
    const { client } = await setupOwner();
    const sent = stubPushService(201);
    const res = await client.request("POST", "/api/push/test", {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_subscribed" });
    expect(sent).toEqual([]);
  });

  it("deletes a subscription the push service reports gone", async () => {
    const { client } = await subscribed();
    stubPushService(410);
    const res = await client.request("POST", "/api/push/test", {});
    expect(res.status).toBe(404);
    expect(await pushRows()).toEqual([]);
  });

  it("reports a push service failure without its detail and keeps the subscription", async () => {
    const { client } = await subscribed();
    stubPushService(500);
    const warn = vi.spyOn(console, "warn");
    const res = await client.request("POST", "/api/push/test", {});
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "push_failed" });
    expect(await pushRows()).toHaveLength(1);
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("push_failed"));
    expect(JSON.parse(line ?? "{}")).toMatchObject({ status: 500 });
    expect(line).not.toContain("fcm.googleapis.com");
  });

  it("is rate limited", async () => {
    const { client } = await subscribed();
    const sent = stubPushService(201);
    const req = new Request(`${ORIGIN}/api/push/test`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: cookieOf(client) },
    });
    const limiter = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const res = await fetchWith(req, { PUSH_LIMITER: limiter });
    expect(res.status).toBe(429);
    expect(sent).toEqual([]);
  });

  it("answers 404 while push is not configured", async () => {
    const { client } = await subscribed();
    const req = new Request(`${ORIGIN}/api/push/test`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: cookieOf(client) },
    });
    const res = await fetchWith(req, { VAPID_PRIVATE_KEY: undefined });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "push_not_configured" });
  });
});
