import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { SENDING_STALE_MS } from "../src/send/send";
import { ORIGIN } from "./helpers";
import { fetchWith, seedMessage } from "./mailbox-helpers";
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

const send = (client: Awaited<ReturnType<typeof signedIn>>, body: unknown) =>
  client.request("POST", "/api/messages/send", body);

describe("sending", () => {
  it("sends once through Resend and stores the sent copy", async () => {
    const client = await signedIn();
    const from = await sender("me", { displayName: 'Me, "Myself"' });
    const calls = stubResend(() => resendOk("re_abc"));
    const body = sendBody(from, { cc: ["cc@example.org"], bcc: ["bcc@example.org"] });
    await env.DB.prepare(
      "INSERT INTO drafts (id, idempotency_key, created_at, updated_at) VALUES ('draft-1', ?, 1, 1)",
    )
      .bind(body.idempotencyKey)
      .run();

    const res = await send(client, body);
    const data = (await res.json()) as { message: { id: string; status: string } };
    expect(res.status).toBe(200);
    expect(data.message.status).toBe("sent");

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.headers.get("authorization")).toBe(`Bearer ${env.RESEND_API_KEY}`);
    expect(call?.headers.get("idempotency-key")).toBe(body.idempotencyKey);
    expect(call?.body).toEqual({
      from: '"Me, \\"Myself\\"" <me@example.com>',
      to: ["friend@example.org"],
      cc: ["cc@example.org"],
      bcc: ["bcc@example.org"],
      subject: "Hello",
      text: "**Hi**",
      html: "<p><strong>Hi</strong></p>",
      attachments: [],
    });

    const id = data.message.id;
    expect(await messageRow(id)).toMatchObject({
      status: "sent",
      resendId: "re_abc",
      direction: "out",
      threadKey: id,
      read: 1,
    });
    const copy = await (
      await env.MAIL.get(
        `sent/${new Date().getUTCFullYear()}/${String(new Date().getUTCMonth() + 1).padStart(2, "0")}/${id}.json`,
      )
    )?.json();
    expect(copy).toMatchObject({
      text: "**Hi**",
      html: "<p><strong>Hi</strong></p>",
      bcc: ["bcc@example.org"],
    });

    const ids = async (path: string) =>
      ((await client.json("GET", path)).messages as { id: string }[]).map((m) => m.id);
    expect(await ids("/api/messages?folder=sent")).toEqual([id]);
    expect(await ids("/api/messages")).toEqual([]);
    expect(await ids("/api/search?q=friend")).toEqual([id]);
    expect(await client.json("GET", "/api/send/quota")).toMatchObject({
      daily: { used: 12, limit: 100 },
      monthly: { used: 340, limit: 3000 },
    });
    expect(await client.json("GET", "/api/drafts")).toEqual({ drafts: [] });
  });

  it("refuses invalid requests without calling Resend", async () => {
    const client = await signedIn();
    const from = await sender("me");
    const disabled = await sender("off", { enabled: false });
    const noSend = await sender("quiet", { domain: "nosend.example", send: false });
    await env.DB.prepare(
      "INSERT INTO uploads (id, r2_key, filename, content_type, size, created_at) VALUES ('big-upload', 'uploads/big', 'big.bin', 'application/octet-stream', ?, 1)",
    )
      .bind(31 * 1024 * 1024)
      .run();
    const calls = stubResend(() => resendOk());
    const many = Array.from({ length: 26 }, (_, i) => `r${i}@example.org`);
    const cases: [Record<string, unknown>, number, string][] = [
      [sendBody(noSend), 400, "sending_disabled"],
      [sendBody(disabled), 400, "address_disabled"],
      [sendBody(9999), 400, "unknown_address"],
      [sendBody(from, { to: many, cc: many.slice(0, 25) }), 400, "too_many_recipients"],
      [sendBody(from, { to: ["not an address"] }), 400, "invalid_recipient"],
      [sendBody(from, { to: [] }), 400, "no_recipients"],
      [sendBody(from, { subject: "Hi\r\nBcc: victim@example.org" }), 400, "invalid_subject"],
      [sendBody(from, { uploadIds: ["missing-upload"] }), 400, "unknown_upload"],
      [sendBody(from, { uploadIds: ["big-upload"] }), 413, "attachments_too_large"],
      [sendBody(from, { sourceId: "missing-source", sourceKind: "reply" }), 400, "unknown_source"],
      [sendBody(from, { idempotencyKey: "short" }), 400, "bad_request"],
    ];
    for (const [body, status, error] of cases) {
      const res = await send(client, body);
      expect(res.status, error).toBe(status);
      expect(await res.json(), error).toEqual({ error });
    }
    expect(calls).toHaveLength(0);
  });

  it("sends once for the same key, sequentially and concurrently", async () => {
    const client = await signedIn();
    const from = await sender();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = stubResend(async () => {
      await gate;
      return resendOk();
    });
    const body = sendBody(from);
    const first = send(client, body);
    // The second request starts while the first waits for Resend.
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = await send(client, body);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "send_in_progress" });
    release();
    expect((await first).status).toBe(200);

    const again = await send(client, body);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { message: { status: string } }).message.status).toBe("sent");
    expect(calls).toHaveLength(1);
  });

  it("retries a failed or stale send with the same key and the stored copy", async () => {
    const client = await signedIn();
    const from = await sender();
    const calls = stubResend((n) =>
      n === 0 ? resendError(500, "internal_server_error") : resendOk(),
    );
    const body = sendBody(from);
    const failed = await send(client, body);
    expect(failed.status).toBe(502);
    const { id } = (await failed.json()) as { id: string };
    expect(await messageRow(id)).toMatchObject({ status: "failed", error: "send_failed" });

    // A retry with a changed body still sends the stored copy under the same key.
    const retried = await send(client, { ...body, subject: "Changed" });
    expect(retried.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.get("idempotency-key")).toBe(body.idempotencyKey);
    expect(calls[1]?.body).toEqual(calls[0]?.body);

    // A "sending" row: fresh means in progress, older than the stale limit is retried.
    const setSending = (age: number) =>
      env.DB.prepare("UPDATE messages SET status = 'sending', received_at = ? WHERE id = ?")
        .bind(Date.now() - age, id)
        .run();
    await setSending(1000);
    expect((await send(client, body)).status).toBe(409);
    await setSending(SENDING_STALE_MS + 1000);
    expect((await send(client, body)).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("threads replies and prefixes the subject once", async () => {
    const client = await signedIn();
    const from = await sender();
    await seedMessage({ id: "source-1", threadKey: "<root@example.org>", subject: "Plans" });
    await env.DB.prepare(
      "UPDATE messages SET message_id_hdr = '<m2@example.org>', references_hdr = '<root@example.org>' WHERE id = 'source-1'",
    ).run();
    const calls = stubResend((n) => resendOk(`re_${n}`));

    const reply = await send(
      client,
      sendBody(from, { subject: "Plans", sourceId: "source-1", sourceKind: "reply" }),
    );
    const replyId = ((await reply.json()) as { message: { id: string } }).message.id;
    expect(calls[0]?.body).toMatchObject({
      subject: "Re: Plans",
      headers: {
        "In-Reply-To": "<m2@example.org>",
        References: "<root@example.org> <m2@example.org>",
      },
    });
    expect(await messageRow(replyId)).toMatchObject({
      threadKey: "<root@example.org>",
      inReplyTo: "<m2@example.org>",
    });
    const thread = await client.json("GET", "/api/messages/source-1/thread");
    expect((thread.messages as { id: string }[]).map((m) => m.id)).toEqual(["source-1", replyId]);

    await send(
      client,
      sendBody(from, { subject: "RE: Plans", sourceId: "source-1", sourceKind: "replyAll" }),
    );
    expect(calls[1]?.body.subject).toBe("RE: Plans");
    await send(
      client,
      sendBody(from, { subject: "Plans", sourceId: "source-1", sourceKind: "forward" }),
    );
    expect(calls[2]?.body.subject).toBe("Fwd: Plans");
    expect(calls[2]?.body.headers).toBeUndefined();
  });

  it("attaches uploads as signed URLs that verify", async () => {
    const client = await signedIn();
    const from = await sender();
    const res = await upload(client, "attachment bytes");
    const { upload: file } = (await res.json()) as { upload: { id: string } };
    const calls = stubResend(() => resendOk());
    expect((await send(client, sendBody(from, { uploadIds: [file.id] }))).status).toBe(200);
    const attachments = calls[0]?.body.attachments as { filename: string; path: string }[];
    const [attachment] = attachments;
    expect(attachment?.filename).toBe("notes.txt");
    const url = new URL(attachment?.path ?? "");
    expect(url.origin).toBe(ORIGIN);
    const blob = await exports.default.fetch(url.href);
    expect(blob.status).toBe(200);
    expect(await blob.text()).toBe("attachment bytes");
    // Sent attachments stay with the message.
    expect((await client.request("DELETE", `/api/uploads/${file.id}`)).status).toBe(409);
  });

  it.each([
    [[429, "daily_quota_exceeded"], 429, "daily_quota_exceeded"],
    [[429, "monthly_quota_exceeded"], 429, "monthly_quota_exceeded"],
    [[429, "rate_limit_exceeded"], 429, "rate_limited"],
    [[422, "validation_error"], 422, "send_rejected"],
    [[500, "internal_server_error"], 502, "send_failed"],
    [null, 502, "send_failed"],
  ] as const)("maps a Resend failure to a short code (%#)", async (answer, status, error) => {
    const client = await signedIn();
    const from = await sender();
    const logged = vi.spyOn(console, "warn");
    stubResend(() => {
      if (!answer) throw new TypeError("network down");
      return resendError(answer[0], answer[1]);
    });
    const res = await send(client, sendBody(from));
    const text = await res.text();
    expect(res.status).toBe(status);
    const { id } = JSON.parse(text) as { id: string };
    expect(JSON.parse(text)).toEqual({ error, id });
    expect(await messageRow(id)).toMatchObject({ status: "failed", error });
    const logs = JSON.stringify(logged.mock.calls);
    expect(logs).toContain("send_failed");
    expect(`${text}${logs}`).not.toMatch(/UPSTREAM-SECRET-TEXT|network down/);
  });

  it("stays off without the Resend key and reports what is set up", async () => {
    const client = await signedIn();
    const from = await sender("me", { displayName: "Me" });
    await sender("other", { domain: "nosend.example", send: false });
    expect(await client.json("GET", "/api/send/from")).toEqual({
      configured: true,
      attachments: true,
      addresses: [{ id: from, address: "me@example.com", displayName: "Me" }],
    });
    const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const call = (method: string, path: string, body?: unknown) =>
      fetchWith(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: { origin: ORIGIN, cookie, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        { RESEND_API_KEY: undefined, UPLOAD_URL_KEY: undefined },
      );
    const sendRes = await call("POST", "/api/messages/send", sendBody(from));
    expect(sendRes.status).toBe(503);
    expect(await sendRes.json()).toEqual({ error: "send_not_configured" });
    expect(await (await call("GET", "/api/send/from")).json()).toMatchObject({
      configured: false,
      attachments: false,
    });
    const put = await call("PUT", "/api/uploads", "x");
    expect(await put.json()).toEqual({ error: "attachments_not_configured" });
  });
});
