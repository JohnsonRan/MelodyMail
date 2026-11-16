import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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
// 2026-11-16): a delivery failure Resend reports is final.

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
