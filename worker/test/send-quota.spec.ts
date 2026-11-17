import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Client } from "./helpers";
import { resendError, resendOk, sendBody, sender, signedIn, stubResend } from "./send-helpers";

// The stored quota after a send (worker/src/send/send.ts, quotaUpsert). Resend's quota headers lag
// behind its own count, so each accepted send counts locally as well.

const DAY_MS = 86_400_000;

async function quota(client: Client) {
  const body = await client.json("GET", "/api/send/quota");
  const { daily, monthly } = body as { daily: { used: number }; monthly: { used: number } };
  return [daily.used, monthly.used];
}

function seed(daily: number, monthly: number, seenAt: number) {
  return env.DB.prepare(
    "INSERT INTO send_quota (id, daily_used, monthly_used, seen_at) VALUES (1, ?, ?, ?)",
  )
    .bind(daily, monthly, seenAt)
    .run();
}

async function send(client: Client, from: number, key: string = crypto.randomUUID()) {
  const res = await client.request(
    "POST",
    "/api/messages/send",
    sendBody(from, { idempotencyKey: key }),
  );
  return res.status;
}

describe("send quota", () => {
  it("counts every accepted send while the header lags, and never goes down", async () => {
    const client = await signedIn();
    const from = await sender();
    const refusal = resendError(429, "rate_limited");
    refusal.headers.set("x-resend-daily-quota", "1");
    refusal.headers.set("x-resend-monthly-quota", "1");
    const calls = stubResend((n) => (n < 3 ? resendOk(`re_${n}`, 1, 1) : refusal));
    const first = crypto.randomUUID();
    expect(await send(client, from, first)).toBe(200);
    expect(await quota(client)).toEqual([1, 1]);
    expect(await send(client, from)).toBe(200);
    expect(await send(client, from)).toBe(200);
    expect(await quota(client)).toEqual([3, 3]);

    expect(await send(client, from)).toBe(429);
    expect(await quota(client)).toEqual([3, 3]);
    expect(await send(client, from, first)).toBe(200);
    expect(calls).toHaveLength(4);
    expect(await quota(client)).toEqual([3, 3]);
  });

  it("counts an accepted send that carries no quota headers", async () => {
    const client = await signedIn();
    const from = await sender();
    stubResend(() => Response.json({ id: "re_1" }));
    expect(await send(client, from)).toBe(200);
    expect(await quota(client)).toEqual([1, 1]);
  });

  it("keeps a header above the local count", async () => {
    const client = await signedIn();
    const from = await sender();
    await seed(2, 20, Date.now());
    stubResend(() => resendOk("re_1", 10, 300));
    expect(await send(client, from)).toBe(200);
    expect(await quota(client)).toEqual([10, 300]);
  });

  it("starts the local count again on a new UTC day and month", async () => {
    const client = await signedIn();
    const from = await sender();
    stubResend((n) => resendOk(`re_${n}`, 0, 0));
    const now = Date.now();
    await seed(40, 900, now - DAY_MS);
    expect(await send(client, from)).toBe(200);
    const sameMonth = new Date(now - DAY_MS).getUTCMonth() === new Date(now).getUTCMonth();
    expect(await quota(client)).toEqual([1, sameMonth ? 901 : 1]);

    // 40 days back is always another UTC month.
    await env.DB.prepare("UPDATE send_quota SET seen_at = ?")
      .bind(now - 40 * DAY_MS)
      .run();
    expect(await send(client, from)).toBe(200);
    expect(await quota(client)).toEqual([1, 1]);
  });

  it("adds nothing for a message another request already finished", async () => {
    const client = await signedIn();
    const from = await sender();
    stubResend(async () => {
      await env.DB.prepare("UPDATE messages SET status = 'sent' WHERE status = 'sending'").run();
      return resendOk("re_1", 0, 0);
    });
    expect(await send(client, from)).toBe(200);
    expect(await quota(client)).toEqual([0, 0]);
  });
});
