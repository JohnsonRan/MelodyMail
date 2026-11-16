import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { apiScopes } from "../src/routing";
import { apiKey, v1 } from "./api-helpers";
import { seedMany } from "./mailbox-helpers";
import { check, documentedOperations } from "./openapi-check";
import { messageRow, resendOk, sender, signedIn, stubResend } from "./send-helpers";

// REST API v1 (docs/M6-rules-api.md, "REST API v1") against the session routes it shares its
// handlers with, and the OpenAPI document against the routes (owner ruling 2). `v1()` checks every
// answer against the document.

type Json = Record<string, unknown>;

const SEND = { from: 0, to: ["friend@example.org"], subject: "Hello", text: "Hi" };

async function body(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

describe("REST API v1", () => {
  it("reads what the session routes read", async () => {
    const session = await signedIn();
    const { key } = await apiKey(["mail:read"]);
    await seedMany([
      { id: "m1", receivedAt: 1000, threadKey: "t", subject: "Invoice one", body: "invoice" },
      { id: "m2", receivedAt: 2000, threadKey: "t", subject: "Invoice two", body: "invoice" },
      { id: "m3", receivedAt: 3000, archived: true, raw: "Subject: raw\r\n\r\nbytes\r\n" },
    ]);
    for (const path of [
      "/messages",
      "/messages?folder=archive",
      "/messages?address=1&limit=1",
      "/messages/m1",
      "/messages/m1/thread",
      "/search?q=invoice",
    ]) {
      const res = await v1(key, "GET", path);
      expect(res.status, path).toBe(200);
      expect(await res.json(), path).toEqual(await session.json("GET", `/api${path}`));
    }
    const raw = await v1(key, "GET", "/messages/m3/raw");
    expect(raw.headers.get("content-type")).toBe("application/octet-stream");
    expect(await raw.text()).toBe("Subject: raw\r\n\r\nbytes\r\n");
    expect((await v1(key, "GET", "/messages/none")).status).toBe(404);
    expect((await v1(key, "GET", "/messages?folder=spam")).status).toBe(400);
  });

  it("pages with the keyset cursor until nextCursor is null", async () => {
    const { key } = await apiKey(["mail:read"]);
    await seedMany([1, 2, 3].map((n) => ({ id: `p${n}`, receivedAt: n * 1000 })));
    const first = await body(await v1(key, "GET", "/messages?limit=2"));
    expect((first.messages as Json[]).map((m) => m.id)).toEqual(["p3", "p2"]);
    const next = encodeURIComponent(first.nextCursor as string);
    const second = await body(await v1(key, "GET", `/messages?limit=2&cursor=${next}`));
    expect((second.messages as Json[]).map((m) => m.id)).toEqual(["p1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("lists addresses with whether each may send", async () => {
    const { key } = await apiKey(["mail:send"]);
    const id = await sender("me");
    await sender("quiet", { domain: "other.example", send: false, enabled: false });
    const data = await body(await v1(key, "GET", "/addresses"));
    expect(data.addresses).toEqual([
      { id, address: "me@example.com", displayName: "", enabled: true, canSend: true },
      expect.objectContaining({ address: "quiet@other.example", enabled: false, canSend: false }),
    ]);
  });

  it("changes flags on one message and in bulk", async () => {
    const { key } = await apiKey(["mail:write"]);
    await seedMany([{ id: "f1" }, { id: "f2" }]);
    expect(await body(await v1(key, "PATCH", "/messages/f1", { starred: true }))).toEqual({
      ok: true,
    });
    const bulk = await v1(key, "PATCH", "/messages", { ids: ["f1", "f2", "gone"], read: true });
    expect(await bulk.json()).toEqual({ updated: 2 });
    const { results } = await env.DB.prepare(
      "SELECT id, read, starred FROM messages ORDER BY id",
    ).all();
    expect(results).toEqual([
      { id: "f1", read: 1, starred: 1 },
      { id: "f2", read: 1, starred: 0 },
    ]);
    const tooMany = Array.from({ length: 101 }, (_, i) => `x${i}`);
    expect((await v1(key, "PATCH", "/messages", { ids: tooMany, read: true })).status).toBe(400);
    expect((await v1(key, "PATCH", "/messages/f1", { read: "yes" })).status).toBe(400);
  });

  it("sends only with an Idempotency-Key and a well-typed body", async () => {
    const { key } = await apiKey(["mail:send"]);
    const from = await sender();
    const calls = stubResend(() => resendOk());
    const missing = await v1(key, "POST", "/messages/send", { ...SEND, from });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "idempotency_key_required" });
    const header = { "idempotency-key": crypto.randomUUID() };
    for (const [change, path] of [
      [{ from: "1" }, "from"],
      [{ to: ["a@example.org", 2] }, "to.1"],
      [{ cc: "a@example.org" }, "cc"],
      [{ text: undefined }, "text"],
      [{ html: 1 }, "html"],
      [{ uploadIds: ["u1"] }, "uploadIds"],
    ] as const) {
      const res = await v1(key, "POST", "/messages/send", { ...SEND, from, ...change }, header);
      expect(res.status, path).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request", path });
    }
    const badKey = await v1(
      key,
      "POST",
      "/messages/send",
      { ...SEND, from },
      {
        "idempotency-key": "short",
      },
    );
    expect(await badKey.json()).toEqual({ error: "bad_request", path: "Idempotency-Key" });
    const unknown = await v1(key, "POST", "/messages/send", { ...SEND, from: from + 9 }, header);
    expect(await unknown.json()).toEqual({ error: "unknown_address" });
    expect(calls).toHaveLength(0);
  });

  it("sends once per Idempotency-Key, repeated and concurrent, and replies in a thread", async () => {
    const { key } = await apiKey(["mail:send"]);
    const from = await sender();
    await seedMany([{ id: "source-message", threadKey: "thread-1" }]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = stubResend(async () => {
      await gate;
      return resendOk();
    });
    const header = { "idempotency-key": crypto.randomUUID() };
    const request = { ...SEND, from, html: "<p>Hi</p>", replyTo: "source-message" };
    const first = v1(key, "POST", "/messages/send", request, header);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const concurrent = await v1(key, "POST", "/messages/send", request, header);
    expect(await concurrent.json()).toEqual({ error: "send_in_progress" });
    release();
    const sent = await body(await first);
    const id = (sent.message as Json).id as string;
    expect(sent).toEqual({ message: { id, status: "sent" } });
    const again = await v1(key, "POST", "/messages/send", request, header);
    expect(await again.json()).toEqual(sent);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("idempotency-key")).toBe(header["idempotency-key"]);
    expect(calls[0]?.body).toMatchObject({
      to: ["friend@example.org"],
      subject: "Re: Hello",
      text: "Hi",
      html: "<p>Hi</p>",
    });
    expect(calls[0]?.body.attachments).toEqual([]);
    expect(await messageRow(id)).toMatchObject({ status: "sent", threadKey: "thread-1" });
  });
});

describe("OpenAPI document", () => {
  it("has exactly one operation, with its scopes, for every /api/v1/ route", () => {
    const routes = new Map(
      app.routes
        .filter((r) => r.method !== "ALL" && r.path.startsWith("/api/v1/"))
        .map((r) => [`${r.method} ${r.path}`, [...(apiScopes(r.handler) ?? [])].sort()]),
    );
    const documented = documentedOperations();
    expect(new Set(documented.map((o) => o.key)).size).toBe(documented.length);
    expect(Object.fromEntries(documented.map((o) => [o.key, [...o.scopes].sort()]))).toEqual(
      Object.fromEntries(routes),
    );
  });

  it("flags an undocumented field, a missing field, a wrong type and an unexpected null", () => {
    const schema = { $ref: "#/components/schemas/Address" };
    const address = { id: 1, address: "a@b.c", displayName: "", enabled: true, canSend: false };
    expect(check(schema, address)).toEqual([]);
    expect(check(schema, { ...address, extra: 1 })).toEqual(["$.extra: not documented"]);
    const { canSend: _, ...missing } = address;
    expect(check(schema, missing)).toEqual(["$.canSend: required"]);
    expect(check(schema, { ...address, id: "1" })).toEqual(["$.id: string is not integer"]);
    expect(check(schema, { ...address, address: null })).toEqual(["$.address: null is not string"]);
    const page = { $ref: "#/components/schemas/MessagePage" };
    expect(check(page, { messages: [], nextCursor: null })).toEqual([]);
    expect(check(page, { messages: [{ id: 1 }], nextCursor: null })).toContain(
      "$.messages[0].id: integer is not string",
    );
  });
});
