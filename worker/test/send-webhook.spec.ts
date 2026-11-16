import { exports } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { describe, expect, it, vi } from "vitest";
import { WEBHOOK_BODY_MAX } from "../src/send/webhook";
import {
  messageRow,
  resendOk,
  sendBody,
  sender,
  signedIn,
  stubResend,
  webhookRequest,
} from "./send-helpers";

// The Resend webhook beyond the basics in send-extras.spec.ts (owner rulings and review of
// 2026-11-16): a delivery failure Resend reports is final, and an event that arrives before the
// send stored Resend's id is left for Resend to retry. A body too large is refused before the
// signature is computed.

const event = (type: string, emailId: string) => ({ type, data: { email_id: emailId } });
const post = (req: Request) => exports.default.fetch(req);

describe("Resend webhook, final states", () => {
  it("keeps a reported delivery failure apart from a local one and never retries it", async () => {
    const client = await signedIn();
    const from = await sender();
    const calls = stubResend(() => resendOk("re_lost"));
    const body = sendBody(from);
    const sent = await client.json("POST", "/api/messages/send", body);
    const id = (sent.message as { id: string }).id;

    expect((await post(webhookRequest(event("email.failed", "re_lost")))).status).toBe(200);
    expect(await messageRow(id)).toMatchObject({ status: "delivery_failed", error: null });

    // A repeat under the same key returns the message; Resend is not called again.
    const repeat = await client.json("POST", "/api/messages/send", body);
    expect(repeat.message).toEqual({ id, status: "delivery_failed" });
    expect(calls).toHaveLength(1);
  });
});

describe("Resend webhook, ordering", () => {
  it("lets Resend retry an event that arrives before the send stored its id", async () => {
    const client = await signedIn();
    const from = await sender();
    const at = new Date();
    const delivered = () =>
      webhookRequest(event("email.delivered", "re_race"), { id: "msg_race", at });
    let early: Response | undefined;
    // Resend accepts the message and its webhook lands before the Worker stores resend_id.
    stubResend(async () => {
      early = await post(delivered());
      return resendOk("re_race");
    });
    const sent = await client.json("POST", "/api/messages/send", sendBody(from));
    const id = (sent.message as { id: string }).id;
    expect(early?.status).toBe(409);
    expect(await messageRow(id)).toMatchObject({ status: "sent" });

    // Resend retries a failed delivery with the same svix-id.
    expect((await post(delivered())).status).toBe(200);
    expect(await messageRow(id)).toMatchObject({ status: "delivered" });
  });
});

describe("Resend webhook, body size", () => {
  it("refuses a body over the cap before verifying it", async () => {
    const client = await signedIn();
    const from = await sender();
    stubResend(() => resendOk("re_big"));
    const sent = await client.json("POST", "/api/messages/send", sendBody(from));
    const id = (sent.message as { id: string }).id;
    const verify = vi.spyOn(Webhook.prototype, "verify");
    const pad = "a".repeat(WEBHOOK_BODY_MAX);
    const big = { type: "email.delivered", data: { email_id: "re_big", pad } };
    const res = await post(webhookRequest(big));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
    expect(verify).not.toHaveBeenCalled();
    expect(await messageRow(id)).toMatchObject({ status: "sent" });
    // A normal event still passes.
    expect((await post(webhookRequest(event("email.delivered", "re_big")))).status).toBe(200);
  });
});
