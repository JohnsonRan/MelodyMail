import { env, exports } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { describe, expect, it, vi } from "vitest";
import { SENDING_STALE_MS } from "../src/send/retry";
import { WEBHOOK_BODY_MAX } from "../src/send/webhook";
import {
  messageRow,
  resendError,
  resendOk,
  sendBody,
  sender,
  signedIn,
  stubResend,
  upload,
  webhookRequest,
} from "./send-helpers";

// Sending against Resend beyond the basics in send.spec.ts and send-extras.spec.ts (owner rulings
// and review of 2026-11-16): a retry sends a byte-identical request; Resend's idempotency
// conflicts never land as a retryable failure; a final rejection lets the corrected message go
// out under a new key; a delivery failure Resend reports is final; a webhook event that arrives
// before the send stored Resend's id is left for Resend to retry; a webhook body too large is
// refused before its signature is computed.

type Client = Awaited<ReturnType<typeof signedIn>>;
const send = (client: Client, body: unknown) => client.request("POST", "/api/messages/send", body);

async function uploaded(client: Client): Promise<string> {
  const res = await upload(client, "attachment bytes");
  return ((await res.json()) as { upload: { id: string } }).upload.id;
}

describe("retrying a send", () => {
  it("signs attachment URLs for 24 hours from the stored copy, so a retry is identical", async () => {
    const client = await signedIn();
    const from = await sender();
    const fileId = await uploaded(client);
    const calls = stubResend((n) => (n === 0 ? resendError(500, "application_error") : resendOk()));
    const body = sendBody(from, { uploadIds: [fileId] });
    const before = Math.floor(Date.now() / 1000);
    expect((await send(client, body)).status).toBe(502);
    // The failed message keeps its attachment for the retry: it cannot be deleted meanwhile.
    expect((await client.request("DELETE", `/api/uploads/${fileId}`)).status).toBe(409);

    // The retry runs ten minutes later; the signed URLs must not change with it.
    const later = Date.now() + 10 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    expect((await send(client, body)).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.body)).toBe(JSON.stringify(calls[0]?.body));

    const [attachment] = (calls[0]?.body.attachments ?? []) as { path: string }[];
    const exp = Number(new URL(attachment?.path ?? "").searchParams.get("exp"));
    expect(exp - before).toBeGreaterThanOrEqual(24 * 3600);
    expect(exp - before).toBeLessThanOrEqual(24 * 3600 + 5);
  });
});

describe("retrying through another hostname", () => {
  it("signs attachment URLs with the origin of the first attempt", async () => {
    const client = await signedIn();
    const from = await sender();
    const fileId = await uploaded(client);
    const calls = stubResend((n) => (n === 0 ? resendError(500, "application_error") : resendOk()));
    const body = sendBody(from, { uploadIds: [fileId] });
    expect((await send(client, body)).status).toBe(502);

    const other = "https://mail.other.test";
    const retry = await exports.default.fetch(`${other}/api/messages/send`, {
      method: "POST",
      headers: {
        origin: other,
        "content-type": "application/json",
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: JSON.stringify({ idempotencyKey: body.idempotencyKey }),
    });
    expect(retry.status).toBe(200);
    expect(JSON.stringify(calls[1]?.body)).toBe(JSON.stringify(calls[0]?.body));
  });
});

describe("Resend's idempotency conflicts", () => {
  it.each(["concurrent_idempotent_requests", "invalid_idempotent_request"])(
    "leaves the row sending on 409 %s, so a concurrent success lands",
    async (name) => {
      const client = await signedIn();
      const from = await sender();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls = stubResend(async (n) => {
        if (n === 1) return resendError(409, name);
        await gate;
        return resendOk("re_first");
      });
      const body = sendBody(from);
      const first = send(client, body);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      // The first attempt looks stale, so a repeat claims the row and calls Resend again.
      const row = await env.DB.prepare(
        "UPDATE messages SET received_at = ? WHERE idempotency_key = ? RETURNING id",
      )
        .bind(Date.now() - SENDING_STALE_MS - 1000, body.idempotencyKey)
        .first<{ id: string }>();
      const id = row?.id as string;
      const second = await send(client, body);
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: "send_in_progress" });
      expect(await messageRow(id)).toMatchObject({ status: "sending", error: null });

      release();
      expect((await first).status).toBe(200);
      expect(await messageRow(id)).toMatchObject({ status: "sent", resendId: "re_first" });
    },
  );
});

describe("drafts after a failed send", () => {
  const draft = (key: string, extra = {}) => ({
    to: ["friend@example.org"],
    subject: "Hello",
    text: "Draft",
    idempotencyKey: key,
    ...extra,
  });

  it("keeps autosave working and the key fixed after a send that may be retried", async () => {
    const client = await signedIn();
    const from = await sender();
    stubResend(() => resendError(500, "application_error"));
    const body = sendBody(from);
    await client.json("PUT", "/api/drafts/draft-k1", draft(body.idempotencyKey));
    expect((await send(client, body)).status).toBe(502);

    const saved = await client.request("PUT", "/api/drafts/draft-k1", draft(body.idempotencyKey));
    expect(saved.status).toBe(200);
    // Not a final rejection: the session must keep its key, so a retry cannot send twice.
    const moved = await client.request("PUT", "/api/drafts/draft-k1", draft(crypto.randomUUID()));
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({ error: "draft_conflict" });
    // While a retry is still sending, autosave keeps working too.
    await env.DB.prepare("UPDATE messages SET status = 'sending' WHERE idempotency_key = ?")
      .bind(body.idempotencyKey)
      .run();
    const during = await client.request("PUT", "/api/drafts/draft-k1", draft(body.idempotencyKey));
    expect(during.status).toBe(200);
  });

  it("sends the corrected message under a new key after a final rejection", async () => {
    const client = await signedIn();
    const from = await sender();
    const res = await upload(client, "attachment bytes", { "x-draft-id": "draft-r1" });
    const fileId = ((await res.json()) as { upload: { id: string } }).upload.id;
    const calls = stubResend((n) => (n === 0 ? resendError(422, "validation_error") : resendOk()));
    const rejected = sendBody(from, { uploadIds: [fileId] });
    await client.json("PUT", "/api/drafts/draft-r1", draft(rejected.idempotencyKey));
    const first = await send(client, rejected);
    expect(first.status).toBe(422);
    const { id: rejectedId } = (await first.json()) as { id: string };

    // The compose session takes a new key; autosave moves the draft to it.
    const key = crypto.randomUUID();
    await client.json("PUT", "/api/drafts/draft-r1", draft(key, { subject: "Fixed" }));
    const reopened = await client.json("GET", "/api/drafts/draft-r1");
    expect(reopened.draft).toMatchObject({
      idempotencyKey: key,
      subject: "Fixed",
      attachments: [{ id: fileId }],
    });
    // The rejection is final: a Retry under the old key (the reader's) calls nobody.
    const retry = await client.request("POST", "/api/messages/send", {
      idempotencyKey: rejected.idempotencyKey,
    });
    expect(retry.status).toBe(422);
    expect(await retry.json()).toEqual({ error: "send_rejected", id: rejectedId });
    expect(calls).toHaveLength(1);

    const fixed = await send(client, { ...rejected, subject: "Fixed", idempotencyKey: key });
    expect(fixed.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.get("idempotency-key")).toBe(key);
    expect(calls[1]?.body).toMatchObject({
      subject: "Fixed",
      attachments: [{ filename: "notes.txt" }],
    });
    expect((await client.json("GET", "/api/drafts")).drafts).toEqual([]);
  });
});

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
    const read = vi.spyOn(Request.prototype, "arrayBuffer");
    const pad = "a".repeat(WEBHOOK_BODY_MAX);
    const signed = webhookRequest({ type: "email.delivered", data: { email_id: "re_big", pad } });
    const raw = await signed.text();
    const headers = Object.fromEntries(signed.headers);

    // With a Content-Length over the cap: refused before the body is read.
    const declared = await post(
      new Request(signed.url, {
        method: "POST",
        headers: { ...headers, "content-length": String(raw.length) },
        body: raw,
      }),
    );
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "payload_too_large" });
    expect(read).not.toHaveBeenCalled();

    // Chunked, without a length: refused once read, before the signature is computed.
    const bytes = new TextEncoder().encode(raw);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const chunked = await post(new Request(signed.url, { method: "POST", headers, body: stream }));
    expect(chunked.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
    expect(await messageRow(id)).toMatchObject({ status: "sent" });
    // A normal event still passes.
    expect((await post(webhookRequest(event("email.delivered", "re_big")))).status).toBe(200);
  });
});
