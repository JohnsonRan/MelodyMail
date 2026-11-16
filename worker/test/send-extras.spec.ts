import { env, exports } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { describe, expect, it } from "vitest";
import { handleScheduled } from "../src/mail/consumer";
import { UPLOAD_STALE_MS, WEBHOOK_KEEP_MS } from "../src/send/cleanup";
import { signUpload } from "../src/send/signed-url";
import { ORIGIN } from "./helpers";
import { fetchWith } from "./mailbox-helpers";
import {
  messageRow,
  resendOk,
  sendBody,
  sender,
  signedIn,
  stubResend,
  upload,
  webhookRequest,
} from "./send-helpers";

const secret = env.UPLOAD_URL_KEY as string;

async function uploaded(client: Awaited<ReturnType<typeof signedIn>>, headers = {}) {
  const res = await upload(client, "file body", headers);
  expect(res.status).toBe(200);
  return ((await res.json()) as { upload: { id: string } }).upload.id;
}

describe("uploads", () => {
  it("streams a file in and out, and refuses bad uploads", async () => {
    const client = await signedIn();
    const id = await uploaded(client, { "x-filename": encodeURIComponent("报告 1.pdf") });
    const res = await client.request("GET", `/api/uploads/${id}`);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("报告 1.pdf")}`,
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("file body");

    const over = await upload(client, "x", { "content-length": String(25 * 1024 * 1024 + 1) });
    expect(over.status).toBe(413);
    expect((await upload(client, "x", { "x-filename": "%E0%A4%A" })).status).toBe(400);
    expect((await upload(client, "x", { "x-filename": "a%0Ab" })).status).toBe(400);

    expect((await client.request("DELETE", `/api/uploads/${id}`)).status).toBe(200);
    expect((await client.request("GET", `/api/uploads/${id}`)).status).toBe(404);
    expect(await env.MAIL.get(`uploads/${id}`)).toBeNull();
  });

  it("opens the blob only with a valid, unexpired signature", async () => {
    const client = await signedIn();
    const id = await uploaded(client);
    const other = await uploaded(client);
    const nowS = Math.floor(Date.now() / 1000);
    const exp = nowS + 3600;
    const sig = await signUpload(secret, id, exp);
    const get = (path: string) => exports.default.fetch(`${ORIGIN}/api/uploads/${path}`);

    const ok = await get(`${id}/blob?exp=${exp}&sig=${sig}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/octet-stream");
    expect(await ok.text()).toBe("file body");

    const expired = await signUpload(secret, id, nowS - 1);
    const tampered = `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    for (const path of [
      `${id}/blob?exp=${nowS - 1}&sig=${expired}`,
      `${other}/blob?exp=${exp}&sig=${sig}`,
      `${id}/blob?exp=${exp + 1}&sig=${sig}`,
      `${id}/blob?exp=${exp}&sig=${tampered}`,
      `${id}/blob?exp=${exp}`,
      `${id}/blob?sig=${sig}`,
      `${id}/blob`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
  });
});

describe("drafts", () => {
  const draft = (key: string, extra = {}) => ({
    to: ["a@example.org"],
    subject: "Draft",
    text: "Some **markdown**",
    idempotencyKey: key,
    ...extra,
  });

  it("saves, lists, reads and deletes drafts", async () => {
    const client = await signedIn();
    const key = crypto.randomUUID();
    await client.json("PUT", "/api/drafts/draft-0001", draft(key));
    await client.json("PUT", "/api/drafts/draft-0001", draft(key, { subject: "Edited" }));
    const fileId = await uploaded(client, { "x-draft-id": "draft-0001" });

    const list = await client.json("GET", "/api/drafts");
    expect(list.drafts).toMatchObject([
      { id: "draft-0001", subject: "Edited", to: ["a@example.org"], snippet: "Some **markdown**" },
    ]);
    const one = await client.json("GET", "/api/drafts/draft-0001");
    expect(one.draft).toMatchObject({
      text: "Some **markdown**",
      idempotencyKey: key,
      attachments: [{ id: fileId, filename: "notes.txt", size: 9 }],
    });

    // Another key for the same draft id, or the key of another draft, is a conflict.
    const conflict = await client.request("PUT", "/api/drafts/draft-0001", draft("other-key-0001"));
    expect(conflict.status).toBe(409);
    const taken = await client.request("PUT", "/api/drafts/draft-0002", draft(key));
    expect(taken.status).toBe(409);

    await client.json("DELETE", "/api/drafts/draft-0001");
    expect((await client.request("GET", "/api/drafts/draft-0001")).status).toBe(404);
  });

  it("does not bring back a draft that was already sent", async () => {
    const client = await signedIn();
    const from = await sender();
    stubResend(() => resendOk());
    const body = sendBody(from);
    await client.json("PUT", "/api/drafts/draft-0003", draft(body.idempotencyKey));
    await client.json("POST", "/api/messages/send", body);
    expect((await client.json("GET", "/api/drafts")).drafts).toEqual([]);
    const late = await client.request("PUT", "/api/drafts/draft-0003", draft(body.idempotencyKey));
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "already_sent" });
  });
});

describe("Resend webhook", () => {
  async function sentMessage() {
    const client = await signedIn();
    const from = await sender();
    stubResend(() => resendOk("re_hook"));
    const res = await client.json("POST", "/api/messages/send", sendBody(from));
    return (res.message as { id: string }).id;
  }
  const event = (type: string, emailId = "re_hook") => ({ type, data: { email_id: emailId } });
  const post = (req: Request) => exports.default.fetch(req);

  it("matches Svix's published test vector", () => {
    const wh = new Webhook("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw");
    expect(
      wh.sign("msg_p5jXN8AQM9LWM0D4loKWxJek", new Date(1614265330 * 1000), '{"test": 2432232314}'),
    ).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("moves the status forward only and ignores replays", async () => {
    const id = await sentMessage();
    expect((await post(webhookRequest(event("email.delivered"), { id: "msg_1" }))).status).toBe(
      200,
    );
    expect((await messageRow(id))?.status).toBe("delivered");
    // A late "delayed" does not move a delivered message back.
    await post(webhookRequest(event("email.delivery_delayed")));
    expect((await messageRow(id))?.status).toBe("delivered");
    await post(webhookRequest(event("email.bounced")));
    expect((await messageRow(id))?.status).toBe("bounced");
    await post(webhookRequest(event("email.delivered")));
    expect((await messageRow(id))?.status).toBe("bounced");

    // A replayed svix-id is answered and does nothing, whatever it carries.
    await env.DB.prepare("UPDATE messages SET status = 'sent' WHERE id = ?").bind(id).run();
    const replay = await post(webhookRequest(event("email.delivered"), { id: "msg_1" }));
    expect(replay.status).toBe(200);
    expect((await messageRow(id))?.status).toBe("sent");

    for (const unknown of [event("email.delivered", "re_unknown"), event("email.opened")]) {
      expect((await post(webhookRequest(unknown))).status).toBe(200);
    }
    expect((await messageRow(id))?.status).toBe("sent");
  });

  it("refuses a bad signature or an old timestamp without detail", async () => {
    const id = await sentMessage();
    const old = new Date(Date.now() - 6 * 60 * 1000);
    for (const req of [
      webhookRequest(event("email.delivered"), { secret: "whsec_d3Jvbmcgc2VjcmV0IGtleSAxMjM0" }),
      webhookRequest(event("email.delivered"), { at: old }),
      new Request(`${ORIGIN}/api/webhooks/resend`, { method: "POST", body: "{}" }),
    ]) {
      const res = await post(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect((await messageRow(id))?.status).toBe("sent");
    const off = await fetchWith(webhookRequest(event("email.delivered")), {
      RESEND_WEBHOOK_SECRET: undefined,
    });
    expect(off.status).toBe(404);
  });
});

describe("cron clean-up", () => {
  it("removes stale uploads and old replay-guard rows only", async () => {
    const now = Date.now();
    const old = now - UPLOAD_STALE_MS - 1000;
    const rows: [string, number, string | null, string | null][] = [
      ["stale-loose", old, null, null],
      ["stale-gone-draft", old, "gone-draft", null],
      ["stale-gone-message", old, null, "gone-message"],
      ["young", now, null, null],
      ["live-draft", old, "live-draft", null],
      ["sent", old, null, "kept-message"],
    ];
    for (const [id, createdAt, draftId, messageId] of rows) {
      await env.MAIL.put(`uploads/${id}`, "x");
      await env.DB.prepare(
        `INSERT INTO uploads (id, r2_key, filename, content_type, size, created_at, draft_id, message_id)
         VALUES (?, ?, 'f', 'text/plain', 1, ?, ?, ?)`,
      )
        .bind(id, `uploads/${id}`, createdAt, draftId, messageId)
        .run();
    }
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO drafts (id, idempotency_key, created_at, updated_at) VALUES ('live-draft', 'key-live-0001', 1, 1)",
      ),
      env.DB.prepare(
        `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
           raw_size, r2_key, received_at) VALUES ('kept-message', 1, 'out', 'sent', 'a', 'b', 1, 'k', 1)`,
      ),
      env.DB.prepare(
        "INSERT INTO webhook_events (svix_id, received_at) VALUES ('old', ?), ('new', ?)",
      ).bind(now - WEBHOOK_KEEP_MS - 1000, now),
    ]);

    await handleScheduled({ scheduledTime: now } as ScheduledController, env);

    const { results } = await env.DB.prepare("SELECT id FROM uploads ORDER BY id").all();
    expect(results.map((r) => r.id)).toEqual(["live-draft", "sent", "young"]);
    expect(await env.MAIL.get("uploads/stale-loose")).toBeNull();
    expect(await env.MAIL.get("uploads/young")).not.toBeNull();
    const events = await env.DB.prepare("SELECT svix_id AS id FROM webhook_events").all();
    expect(events.results.map((r) => r.id)).toEqual(["new"]);
  });
});
