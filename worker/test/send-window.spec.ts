import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { RETRY_WINDOW_MS } from "../src/send/retry";
import {
  type ResendCall,
  resendError,
  resendOk,
  sendBody,
  sender,
  signedIn,
  stubResend,
  upload,
} from "./send-helpers";

// Owner ruling 13 (2026-11-16): a same-key retry goes out only inside Resend's idempotency
// window, counted from the first attempt, and then with the same body. Past the window a row
// whose outcome is unknown is refused, and the owner sends it as a new message; a row that
// Resend refused every time (429) is re-signed and sent as a fresh attempt.

type Client = Awaited<ReturnType<typeof signedIn>>;
const HOUR = 3600_000;
const send = (client: Client, body: unknown) => client.request("POST", "/api/messages/send", body);
const retry = (client: Client, key: string) => send(client, { idempotencyKey: key });
const network = (): Response => {
  throw new TypeError("network down");
};

/** Moves the clock to `at`, keeping the session alive there. */
async function clockAt(at: number) {
  await env.DB.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ?")
    .bind(at + 86_400_000, at)
    .run();
  vi.spyOn(Date, "now").mockReturnValue(at);
}

/** As if Resend accepted the attempt made at `at` and its answer was lost on the way back. */
function lost(key: string, at: number) {
  return env.DB.prepare(
    `UPDATE messages SET status = 'sending', error = NULL, resend_id = NULL, received_at = ?
     WHERE idempotency_key = ?`,
  )
    .bind(at, key)
    .run();
}

function row(key: string) {
  return env.DB.prepare(
    `SELECT id, status, error, resend_id AS resendId, received_at AS receivedAt,
       first_attempt_at AS firstAttemptAt, maybe_accepted AS maybeAccepted, r2_key AS r2Key
     FROM messages WHERE idempotency_key = ?`,
  )
    .bind(key)
    .first<{ id: string; r2Key: string } & Record<string, unknown>>();
}

async function uploaded(client: Client, headers: Record<string, string> = {}): Promise<string> {
  const res = await upload(client, "attachment bytes", headers);
  return ((await res.json()) as { upload: { id: string } }).upload.id;
}

const exp = (call: ResendCall | undefined) => {
  const [a] = (call?.body.attachments ?? []) as { path: string }[];
  return Number(new URL(a?.path ?? "").searchParams.get("exp"));
};

describe("the retry window counts from the first attempt", () => {
  it("refuses a retry past the window although a later claim reset the row", async () => {
    const client = await signedIn();
    const from = await sender();
    const fileId = await uploaded(client);
    const calls = stubResend(() => resendOk());
    const body = sendBody(from, { uploadIds: [fileId] });
    const t0 = Date.now();
    expect((await send(client, body)).status).toBe(200);
    await lost(body.idempotencyKey, t0);

    // Near the end of the window a Retry claims the row; its answer is lost as well.
    const nearEnd = t0 + 23 * HOUR + 50 * 60_000;
    await clockAt(nearEnd);
    expect((await retry(client, body.idempotencyKey)).status).toBe(200);
    expect(JSON.stringify(calls[1]?.body)).toBe(JSON.stringify(calls[0]?.body));
    await lost(body.idempotencyKey, nearEnd);

    // 24 h 30 min after the first attempt the row looks 40 minutes old; Resend's key is gone.
    await clockAt(t0 + 24 * HOUR + 30 * 60_000);
    const before = await row(body.idempotencyKey);
    const refused = await retry(client, body.idempotencyKey);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "send_status_unknown", id: before?.id });
    expect(calls).toHaveLength(2);
    expect(await row(body.idempotencyKey)).toEqual(before);
    // The message may have gone out: its attachment stays with it.
    expect((await client.request("DELETE", `/api/uploads/${fileId}`)).status).toBe(409);
  });

  it("sends a byte-identical body on a retry late inside the window", async () => {
    const client = await signedIn();
    const from = await sender();
    const fileId = await uploaded(client);
    const calls = stubResend((n) => (n === 0 ? network() : resendOk()));
    const body = sendBody(from, { uploadIds: [fileId] });
    const t0 = Date.now();
    expect((await send(client, body)).status).toBe(502);

    await clockAt(t0 + RETRY_WINDOW_MS - 60_000);
    expect((await retry(client, body.idempotencyKey)).status).toBe(200);
    expect(JSON.stringify(calls[1]?.body)).toBe(JSON.stringify(calls[0]?.body));
  });

  it("refuses a row that failed with a network error once the window has passed", async () => {
    const client = await signedIn();
    const from = await sender();
    const calls = stubResend(network);
    const body = sendBody(from);
    const t0 = Date.now();
    expect((await send(client, body)).status).toBe(502);

    // Two minutes before Resend's 24 hours end: inside the safety margin, already refused.
    await clockAt(t0 + 24 * HOUR - 2 * 60_000);
    const before = await row(body.idempotencyKey);
    expect(before).toMatchObject({ status: "failed", error: "send_failed", maybeAccepted: 1 });
    // The reader judges the same from the message detail.
    const detail = await client.json("GET", `/api/messages/${before?.id}`);
    expect(detail.message).toMatchObject({
      firstAttemptAt: before?.firstAttemptAt,
      maybeAccepted: 1,
    });
    const refused = await retry(client, body.idempotencyKey);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "send_status_unknown", id: before?.id });
    expect(calls).toHaveLength(1);
    expect(await row(body.idempotencyKey)).toEqual(before);
  });
});

describe("a rejection past the window", () => {
  it("stays final: a repeat answers send_rejected without a call", async () => {
    const client = await signedIn();
    const from = await sender();
    const calls = stubResend((n) =>
      n === 0 ? resendError(500, "application_error") : resendError(422, "validation_error"),
    );
    const body = sendBody(from);
    const t0 = Date.now();
    expect((await send(client, body)).status).toBe(502);
    await clockAt(t0 + HOUR);
    expect((await retry(client, body.idempotencyKey)).status).toBe(422);

    await clockAt(t0 + 25 * HOUR);
    const repeat = await retry(client, body.idempotencyKey);
    expect(repeat.status).toBe(422);
    expect(await repeat.json()).toMatchObject({ error: "send_rejected" });
    expect(calls).toHaveLength(2);
  });
});

describe("a row Resend refused every time", () => {
  it("is re-signed past the stored expiry and sent", async () => {
    const client = await signedIn();
    const from = await sender();
    const fileId = await uploaded(client);
    const calls = stubResend((n) =>
      n < 2 ? resendError(429, "rate_limit_exceeded") : resendOk("re_late"),
    );
    const body = sendBody(from, { uploadIds: [fileId] });
    const t0 = Date.now();
    expect((await send(client, body)).status).toBe(429);
    await clockAt(t0 + HOUR);
    expect((await retry(client, body.idempotencyKey)).status).toBe(429);
    expect(JSON.stringify(calls[1]?.body)).toBe(JSON.stringify(calls[0]?.body));

    const late = t0 + 25 * HOUR;
    await clockAt(late);
    expect(exp(calls[0])).toBeLessThan(Math.floor(late / 1000));
    expect((await retry(client, body.idempotencyKey)).status).toBe(200);
    expect(exp(calls[2])).toBe(Math.floor(late / 1000) + 24 * 3600);
    const after = await row(body.idempotencyKey);
    expect(after).toMatchObject({ status: "sent", resendId: "re_late", firstAttemptAt: late });
    const stored = await (await env.MAIL.get(after?.r2Key ?? ""))?.json<{
      attachmentsExpireAt: number;
    }>();
    expect(stored?.attachmentsExpireAt).toBe(exp(calls[2]));
  });

  it.each([
    ["a 429, then a network error", ["429", "network"]],
    ["a network error, then a 429", ["network", "429"]],
    ["an attempt that never answered, then a 429", ["lost", "429"]],
  ])("is not assumed after %s: refused past the window", async (_, attempts) => {
    const client = await signedIn();
    const from = await sender();
    const calls = stubResend((n) => {
      const kind = attempts[n];
      if (kind === "network") return network();
      return kind === "429" ? resendError(429, "rate_limit_exceeded") : resendOk();
    });
    const body = sendBody(from);
    const t0 = Date.now();
    for (const [i, kind] of attempts.entries()) {
      const at = t0 + i * HOUR;
      await clockAt(at);
      await (i === 0 ? send(client, body) : retry(client, body.idempotencyKey));
      if (kind === "lost") await lost(body.idempotencyKey, at);
    }
    expect(calls).toHaveLength(2);

    await clockAt(t0 + 25 * HOUR);
    const refused = await retry(client, body.idempotencyKey);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "send_status_unknown" });
    expect(calls).toHaveLength(2);
  });
});

describe("sending an unknown message as a new one", () => {
  /** A message stuck at "sending" past the window, with one attachment. */
  async function stuck(client: Client) {
    const from = await sender();
    const fileId = await uploaded(client);
    const calls = stubResend(() => resendOk("re_new"));
    const old = sendBody(from, { uploadIds: [fileId], subject: "Invoice" });
    const t0 = Date.now();
    expect((await send(client, old)).status).toBe(200);
    await lost(old.idempotencyKey, t0);
    await clockAt(t0 + 25 * HOUR);
    expect((await retry(client, old.idempotencyKey)).status).toBe(409);
    // The browser copies the attachment: it downloads it and uploads it again for the new draft.
    const bytes = await (await client.request("GET", `/api/uploads/${fileId}`)).text();
    const copy = await upload(client, bytes, { "x-draft-id": "draft-again" });
    const copyId = ((await copy.json()) as { upload: { id: string } }).upload.id;
    return { from, fileId, copyId, calls, old };
  }

  it("sends under a new key and leaves the old row as it was", async () => {
    const client = await signedIn();
    const { copyId, calls, old } = await stuck(client);
    const before = await row(old.idempotencyKey);
    const key = crypto.randomUUID();

    const res = await send(client, { ...old, uploadIds: [copyId], idempotencyKey: key });
    expect(res.status).toBe(200);
    const { message } = (await res.json()) as { message: { id: string; status: string } };
    expect(message.status).toBe("sent");
    expect(message.id).not.toBe(before?.id);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.get("idempotency-key")).toBe(key);
    expect(calls[1]?.body).toMatchObject({
      subject: "Invoice",
      attachments: [{ filename: "notes.txt" }],
    });
    expect(await row(old.idempotencyKey)).toEqual(before);
  });

  it("keeps the old message's attachment with it and gives the new one its own copy", async () => {
    const client = await signedIn();
    const { fileId, copyId, old } = await stuck(client);
    const owner = (id: string) =>
      env.DB.prepare("SELECT message_id AS messageId FROM uploads WHERE id = ?")
        .bind(id)
        .first<{ messageId: string | null }>();
    const oldId = (await row(old.idempotencyKey))?.id;

    // The old upload cannot move to the new message, nor be deleted.
    const reuse = await send(client, {
      ...old,
      uploadIds: [fileId],
      idempotencyKey: crypto.randomUUID(),
    });
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toEqual({ error: "unknown_upload" });
    const res = await send(client, {
      ...old,
      uploadIds: [copyId],
      idempotencyKey: crypto.randomUUID(),
    });
    const { message } = (await res.json()) as { message: { id: string } };

    expect((await client.request("DELETE", `/api/uploads/${fileId}`)).status).toBe(409);
    expect((await client.request("DELETE", `/api/uploads/${copyId}`)).status).toBe(409);
    expect(await owner(fileId)).toEqual({ messageId: oldId });
    expect(await owner(copyId)).toEqual({ messageId: message.id });
    expect((await client.request("GET", `/api/uploads/${fileId}`)).status).toBe(200);
  });
});
