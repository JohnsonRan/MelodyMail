import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

import { handleQueue } from "../src/mail/consumer";
import { SESSION_ENDED } from "../src/mail/hub";
import { Client, login, ORIGIN, setupOwner, totpCode } from "./helpers";
import { messageRows } from "./mail-helpers";
import { fetchWith } from "./mailbox-helpers";

const open: WebSocket[] = [];

afterEach(() => {
  for (const ws of open.splice(0)) {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
});

function cookie(client: Client) {
  return [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}

function upgrade(client: Client, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${ORIGIN}/api/events`, {
    headers: { upgrade: "websocket", origin: ORIGIN, cookie: cookie(client), ...headers },
  });
}

type Socket = {
  ws: WebSocket;
  messages: string[];
  closed: Promise<{ code: number }>;
};

async function connect(client: Client): Promise<Socket> {
  const res = await upgrade(client);
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no socket");
  ws.accept();
  open.push(ws);
  const messages: string[] = [];
  ws.addEventListener("message", (e) => {
    messages.push(String(e.data));
  });
  const closed = new Promise<{ code: number }>((resolve) =>
    ws.addEventListener("close", (e) => resolve({ code: e.code })),
  );
  return { ws, messages, closed };
}

/** A stored message as email() leaves it, without a queue job. */
async function storeRow(id: string) {
  const key = `raw/2026/11/${id}.eml`;
  await env.MAIL.put(key, "From: a@example.org\r\nSubject: Hi\r\n\r\nBody\r\n");
  await env.DB.prepare(
    `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
       raw_size, r2_key, received_at) VALUES (?, 1, 'in', 'stored', 'a@example.org', 'b@example.com', 10, ?, ?)`,
  )
    .bind(id, key, Date.now())
    .run();
}

function batch(id: string) {
  const message = { body: { id }, ack: vi.fn(), retry: vi.fn() };
  return { message, batch: { messages: [message] } as unknown as MessageBatch<InboundJob> };
}

const within = (assertion: () => void) => vi.waitFor(assertion, { timeout: 2000, interval: 10 });

describe("events upgrade", () => {
  it("refuses a request from another origin or without one", async () => {
    const { client } = await setupOwner();
    for (const origin of ["https://evil.example", ""]) {
      const res = await upgrade(client, { origin });
      expect(res.status, origin).toBe(403);
      expect(await res.json()).toEqual({ error: "bad_origin" });
    }
  });

  it("refuses a request without a session", async () => {
    const { client } = await setupOwner();
    client.cookies.clear();
    const res = await upgrade(client);
    expect(res.status).toBe(401);
  });

  it("asks for an upgrade on a plain GET", async () => {
    const { client } = await setupOwner();
    const res = await client.request("GET", "/api/events");
    expect(res.status).toBe(426);
  });

  it("answers ping without a handler", async () => {
    const { client } = await setupOwner();
    const socket = await connect(client);
    socket.ws.send("ping");
    await within(() => expect(socket.messages).toEqual(["pong"]));
  });
});

describe("notify", () => {
  it("reaches a connected page after the consumer parsed a message", async () => {
    const { client } = await setupOwner();
    const socket = await connect(client);
    await storeRow("n1");
    const { message, batch: b } = batch("n1");
    await handleQueue(b, env);
    expect(message.ack).toHaveBeenCalledOnce();
    await within(() =>
      expect(socket.messages.map((m) => JSON.parse(m))).toEqual([{ type: "message", id: "n1" }]),
    );
  });

  it("does not fail the parse when the hub is unavailable", async () => {
    await storeRow("n2");
    const warn = vi.spyOn(console, "warn");
    const broken = {
      ...env,
      HUB: {
        getByName: () => ({ notify: () => Promise.reject(new Error("hub down")) }),
      },
    } as unknown as Env;
    const { message, batch: b } = batch("n2");
    await handleQueue(b, broken);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect((await messageRows())[0]?.status).toBe("parsed");
    expect(warn.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toContain(
      "hub_notify_failed",
    );
  });
});

describe("closing sessions", () => {
  it("closes the page of a session that signs out, and only that one", async () => {
    const owner = await setupOwner();
    const other = (await login(owner.authenticator)).client;
    const mine = await connect(owner.client);
    const theirs = await connect(other);
    await owner.client.json("POST", "/api/auth/logout");
    expect(await mine.closed).toEqual({ code: SESSION_ENDED });
    // The other page still gets events.
    await storeRow("n3");
    await handleQueue(batch("n3").batch, env);
    await within(() => expect(theirs.messages).toHaveLength(1));
  });

  it("closes the pages of sessions signed out from elsewhere", async () => {
    const owner = await setupOwner();
    const other = (await login(owner.authenticator)).client;
    const mine = await connect(owner.client);
    const theirs = await connect(other);
    expect(await owner.client.json("DELETE", "/api/auth/sessions/others")).toEqual({ revoked: 1 });
    expect(await theirs.closed).toEqual({ code: SESSION_ENDED });
    await storeRow("n4");
    await handleQueue(batch("n4").batch, env);
    await within(() => expect(mine.messages).toHaveLength(1));
  });

  it("closes every other page after a recovery", async () => {
    const owner = await setupOwner();
    const page = await connect(owner.client);
    const res = await new Client().request("POST", "/api/auth/recover", {
      recoveryKey: owner.recoveryKey,
      totpCode: await totpCode(owner.totpSecret, 1),
    });
    expect(res.status).toBe(200);
    expect(await page.closed).toEqual({ code: SESSION_ENDED });
  });

  it("still signs out when the hub is unavailable", async () => {
    const owner = await setupOwner();
    const warn = vi.spyOn(console, "warn");
    const cookieHeader = cookie(owner.client);
    const broken = {
      ...env,
      HUB: { getByName: () => ({ closeSessions: () => Promise.reject(new Error("hub down")) }) },
    } as unknown as Env;
    const res = await fetchWith(
      new Request(`${ORIGIN}/api/auth/logout`, {
        method: "POST",
        headers: { origin: ORIGIN, cookie: cookieHeader },
      }),
      broken,
    );
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).toEqual({ n: 0 });
    expect(warn.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toContain(
      "hub_close_failed",
    );
  });
});
