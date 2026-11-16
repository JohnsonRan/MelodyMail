import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { SENDING_STALE_MS } from "../src/send/send";
import {
  messageRow,
  resendError,
  resendOk,
  sendBody,
  sender,
  signedIn,
  stubResend,
  upload,
} from "./send-helpers";

// Retries and idempotency against Resend (owner rulings of 2026-11-16 on the M5 review): a retry
// sends a byte-identical request, Resend's idempotency conflicts never land as a retryable
// failure, and a final rejection lets the corrected message go out under a new key.

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
    // While a retry is still sending, autosave keeps working too.
    await env.DB.prepare("UPDATE messages SET status = 'sending' WHERE idempotency_key = ?")
      .bind(body.idempotencyKey)
      .run();
    const during = await client.request("PUT", "/api/drafts/draft-k1", draft(body.idempotencyKey));
    expect(during.status).toBe(200);
    // Not a final rejection: the session must keep its key, so a retry cannot send twice.
    const moved = await client.request("PUT", "/api/drafts/draft-k1", draft(crypto.randomUUID()));
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({ error: "draft_conflict" });
  });

  it("sends the corrected message under a new key after a final rejection", async () => {
    const client = await signedIn();
    const from = await sender();
    const res = await upload(client, "attachment bytes", { "x-draft-id": "draft-r1" });
    const fileId = ((await res.json()) as { upload: { id: string } }).upload.id;
    const calls = stubResend((n) => (n === 0 ? resendError(422, "validation_error") : resendOk()));
    const rejected = sendBody(from, { uploadIds: [fileId] });
    expect((await send(client, rejected)).status).toBe(422);

    // The compose session takes a new key; autosave moves the draft to it.
    const key = crypto.randomUUID();
    await client.json("PUT", "/api/drafts/draft-r1", draft(key, { subject: "Fixed" }));
    const reopened = await client.json("GET", "/api/drafts/draft-r1");
    expect(reopened.draft).toMatchObject({
      idempotencyKey: key,
      subject: "Fixed",
      attachments: [{ id: fileId }],
    });

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
