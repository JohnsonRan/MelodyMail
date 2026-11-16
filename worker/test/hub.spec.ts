import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

import { handleQueue } from "../src/mail/consumer";
import { FOREGROUND_TTL_MS, Hub, SESSION_ENDED } from "../src/mail/hub";
import { Client, login, ORIGIN, setupOwner, totpCode } from "./helpers";
import { ageReports, attachments, report } from "./hub-helpers";
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

  it("does not accept a socket that the Worker did not tag with a session", async () => {
    const res = await env.HUB.getByName("hub").fetch("https://hub/", {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(400);
    expect(res.webSocket).toBeNull();
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

describe("foreground reports", () => {
  it("keeps the last fg or bg on the socket and ignores anything else", async () => {
    const { client } = await setupOwner();
    const socket = await connect(client);
    expect(await attachments()).toEqual([null]);
    await report(socket.ws, "fg");
    const [first] = await attachments();
    expect(first).toEqual({ foreground: true, at: expect.any(Number) });
    for (const other of ["FG", "fg ", '"bg"', "foreground", new Uint8Array([98, 103])]) {
      socket.ws.send(other);
    }
    socket.ws.send("ping");
    await within(() => expect(socket.messages).toEqual(["pong"]));
    expect(await attachments()).toEqual([first]);
    await report(socket.ws, "bg");
    expect(await attachments()).toEqual([{ foreground: false, at: expect.any(Number) }]);
  });

  it("marks new mail quiet while a page is in the foreground, read by a fresh Hub", async () => {
    const owner = await setupOwner();
    const hidden = await connect(owner.client);
    const front = await connect((await login(owner.authenticator)).client);
    await report(front.ws, "fg");
    // A new instance holds nothing in memory, as after hibernation; it reads the attachments.
    await runInDurableObject(env.HUB.getByName("hub"), async (_hub, state) => {
      expect(await new Hub(state, env).notify({ type: "message", id: "q1" })).toBe(2);
      expect(await new Hub(state, env).notify({ type: "changed", id: "q2" })).toBe(2);
    });
    for (const page of [hidden, front]) {
      await within(() =>
        expect(page.messages.map((m) => JSON.parse(m))).toEqual([
          { type: "message", id: "q1", quiet: true },
          { type: "changed", id: "q2" },
        ]),
      );
    }
  });

  it("counts an fg older than 75 s as background until the page repeats it", async () => {
    const { client } = await setupOwner();
    const socket = await connect(client);
    const quiet = async (id: string) => {
      await env.HUB.getByName("hub").notify({ type: "message", id });
      await within(() => expect(socket.messages.at(-1)).toContain(`"${id}"`));
      return JSON.parse(socket.messages.at(-1) ?? "{}").quiet === true;
    };
    await report(socket.ws, "fg");
    await ageReports(FOREGROUND_TTL_MS - 1000);
    expect(await quiet("t1")).toBe(true);
    await ageReports(2000);
    expect(await quiet("t2")).toBe(false);
    await report(socket.ws, "fg");
    expect(await quiet("t3")).toBe(true);
  });

  it("does not mark new mail quiet when every page is in the background", async () => {
    const { client } = await setupOwner();
    const socket = await connect(client);
    await report(socket.ws, "fg");
    await report(socket.ws, "bg");
    await env.HUB.getByName("hub").notify({ type: "message", id: "q3" });
    await within(() =>
      expect(socket.messages.map((m) => JSON.parse(m))).toEqual([{ type: "message", id: "q3" }]),
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
