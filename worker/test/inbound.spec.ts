import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { handleScheduled, requeueStored, STUCK_AFTER_MS } from "../src/mail/consumer";
import { FORWARDED_HEADER, handleEmail, parseRecipient } from "../src/mail/inbound";
import { addAddress, asMessage, inbound, messageRows, r2Keys } from "./mail-helpers";

async function auditDetails(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT detail FROM audit_log WHERE event = 'mail_forwarded'",
  ).all<{ detail: string }>();
  return results.map((r) => r.detail);
}

/** Waits until the real queue consumer has parsed every stored message. */
async function waitParsed() {
  await vi.waitFor(
    async () => {
      const rows = await messageRows();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((r) => r.status)).toEqual(rows.map(() => "parsed"));
    },
    { timeout: 4000, interval: 25 },
  );
}

afterEach(async () => {
  await env.DB.exec("DROP TRIGGER IF EXISTS fail_message_insert");
  await env.DB.exec("DROP TRIGGER IF EXISTS fail_audit");
  await env.DB.exec("DROP TRIGGER IF EXISTS fail_forward_record");
});

describe("recipient", () => {
  it("lowercases and splits the tag at the first plus", () => {
    expect(parseRecipient("Shop+News+X@Example.COM")).toEqual({
      localPart: "shop",
      domain: "example.com",
      tag: "news+x",
    });
    expect(parseRecipient("shop+@example.com")?.tag).toBeNull();
    expect(parseRecipient("no-at-sign")).toBeNull();
    expect(parseRecipient("@example.com")).toBeNull();
  });
});

describe("email() rejects before storing", () => {
  it("rejects unknown, disabled and receive-off recipients and stores nothing", async () => {
    await addAddress("off", { enabled: false });
    await addAddress("shop", { domain: "quiet.example", receive: false });
    for (const to of [
      "nobody@example.com",
      "off@example.com",
      "shop@quiet.example",
      "shop@unknown.example",
      "not-an-address",
    ]) {
      const message = inbound(to);
      await handleEmail(asMessage(message), env);
      expect(message.setReject, to).toHaveBeenCalledWith("Address not found");
      expect(message.forward).not.toHaveBeenCalled();
    }
    expect(await messageRows()).toEqual([]);
    expect(await r2Keys()).toEqual([]);
  });
});

describe("email() stores", () => {
  it("stores the raw message, the row and the sub-address tag", async () => {
    const id = await addAddress("shop");
    const message = inbound("shop+news@example.com");
    await handleEmail(asMessage(message), env);
    expect(message.setReject).not.toHaveBeenCalled();
    const [row] = await messageRows();
    expect(row).toMatchObject({
      address_id: id,
      direction: "in",
      envelope_from: "sender@example.org",
      envelope_to: "shop+news@example.com",
      subaddress_tag: "news",
      raw_size: message.rawSize,
      forward_failed: 0,
    });
    expect(row?.r2_key).toMatch(/^raw\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.eml$/);
    expect(row?.r2_key).toContain(row?.id);
    const object = await env.MAIL.get(row?.r2_key ?? "");
    expect(await object?.text()).toContain("Body text.");
    const address = await env.DB.prepare("SELECT last_received_at FROM addresses").first();
    expect(address?.last_received_at).toBe(row?.received_at);
  });

  it("matches a recipient in any case", async () => {
    const id = await addAddress("shop");
    await handleEmail(asMessage(inbound("SHOP@Example.COM")), env);
    const [row] = await messageRows();
    expect(row?.address_id).toBe(id);
    expect(row?.subaddress_tag).toBeNull();
  });

  it("enqueues the stored message and the consumer parses it", async () => {
    await addAddress("shop");
    await handleEmail(asMessage(inbound("shop@example.com")), env);
    await waitParsed();
    expect((await messageRows())[0]?.subject).toBe("Hello");
  });
});

describe("email() forwards", () => {
  it("forward-only: forwards to each target once with the loop header and stores nothing", async () => {
    const id = await addAddress("fwd", {
      forwardOnly: true,
      targets: ["a@dest.example", "b@dest.example"],
    });
    const message = inbound("fwd@example.com");
    await handleEmail(asMessage(message), env);
    expect(message.forward).toHaveBeenCalledTimes(2);
    expect(message.forward.mock.calls.map((c) => c[0]).sort()).toEqual([
      "a@dest.example",
      "b@dest.example",
    ]);
    for (const [, headers] of message.forward.mock.calls) {
      expect(headers?.get(FORWARDED_HEADER)).toBe("1");
    }
    expect(await messageRows()).toEqual([]);
    expect(await r2Keys()).toEqual([]);
    expect(await auditDetails()).toEqual([`address ${id}: 2/2`]);
  });

  it("forward-only: keeps a message that carries the loop header instead of forwarding it", async () => {
    await addAddress("fwd", { forwardOnly: true, targets: ["a@dest.example"] });
    const message = inbound("fwd@example.com", undefined, { [FORWARDED_HEADER]: "1" });
    await handleEmail(asMessage(message), env);
    expect(message.forward).not.toHaveBeenCalled();
    expect(await messageRows()).toHaveLength(1);
    expect(await r2Keys()).toHaveLength(1);
  });

  it("forward-only: keeps the message when every forward fails, without trying again", async () => {
    const id = await addAddress("fwd", {
      forwardOnly: true,
      targets: ["a@dest.example", "b@dest.example"],
    });
    const message = inbound("fwd@example.com");
    message.forward.mockRejectedValue(new Error("destination address not verified"));
    await handleEmail(asMessage(message), env);
    expect(message.forward).toHaveBeenCalledTimes(2);
    const rows = await messageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.forward_failed).toBe(2);
    expect(await auditDetails()).toEqual([`address ${id}: 0/2`]);
  });

  it("forward-only: one forward through is enough; no copy is kept", async () => {
    await addAddress("fwd", { forwardOnly: true, targets: ["a@dest.example", "b@dest.example"] });
    const message = inbound("fwd@example.com");
    message.forward.mockRejectedValueOnce(new Error("temporary"));
    await handleEmail(asMessage(message), env);
    expect(message.forward).toHaveBeenCalledTimes(2);
    expect(await messageRows()).toEqual([]);
  });

  it("store and forward: stores first, forwards once per target, records a failure without throwing", async () => {
    await addAddress("shop", { targets: ["a@dest.example", "b@dest.example"] });
    const message = inbound("shop@example.com");
    const rowsAtForward: number[] = [];
    message.forward.mockImplementation(async (to: string) => {
      rowsAtForward.push((await messageRows()).length);
      if (to === "b@dest.example") throw new Error("destination address not verified");
      return { messageId: "" };
    });
    await expect(handleEmail(asMessage(message), env)).resolves.toBeUndefined();
    expect(message.forward).toHaveBeenCalledTimes(2);
    expect(rowsAtForward).toEqual([1, 1]);
    const [row] = await messageRows();
    expect(row?.forward_failed).toBe(1);
    expect(await auditDetails()).toEqual([]);
  });

  it("store and forward: a looped message is stored but not forwarded", async () => {
    await addAddress("shop", { targets: ["a@dest.example"] });
    const message = inbound("shop@example.com", undefined, { [FORWARDED_HEADER]: "1" });
    await handleEmail(asMessage(message), env);
    expect(message.forward).not.toHaveBeenCalled();
    expect(await messageRows()).toHaveLength(1);
  });
});

describe("email() failures", () => {
  it("never throws once a forward went out, even when the writes after it fail", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'D1 down'); END",
    );
    await env.DB.exec(
      "CREATE TRIGGER fail_forward_record BEFORE UPDATE OF forward_failed ON messages BEGIN SELECT RAISE(ABORT, 'D1 down'); END",
    );
    await addAddress("fwd", { forwardOnly: true, targets: ["a@dest.example"] });
    const forwardOnly = inbound("fwd@example.com");
    await expect(handleEmail(asMessage(forwardOnly), env)).resolves.toBeUndefined();
    expect(forwardOnly.forward).toHaveBeenCalledOnce();

    await addAddress("shop", { targets: ["a@dest.example"] });
    const kept = inbound("shop@example.com");
    kept.forward.mockRejectedValue(new Error("destination address not verified"));
    await expect(handleEmail(asMessage(kept), env)).resolves.toBeUndefined();
    expect(kept.forward).toHaveBeenCalledOnce();
    const logged = error.mock.calls.join(" ");
    expect(logged).toContain("mail_audit_failed");
    expect(logged).toContain("mail_forward_record_failed");
  });

  it("logs a failed forward without the addresses in the error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await addAddress("shop", { targets: ["a@dest.example"] });
    const message = inbound("shop@example.com");
    message.forward.mockRejectedValue(new Error("a@dest.example is not a verified destination"));
    await handleEmail(asMessage(message), env);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("mail_forward_failed"));
    expect(JSON.parse(line ?? "{}")).toEqual({
      level: "warn",
      event: "mail_forward_failed",
      addressId: id,
      error: "… is not a verified destination",
    });
  });

  it("throws before any forward when R2 fails, and stores no row", async () => {
    await addAddress("shop", { targets: ["a@dest.example"] });
    const message = inbound("shop@example.com");
    const failing = { ...env, MAIL: { put: () => Promise.reject(new Error("R2 down")) } };
    await expect(handleEmail(asMessage(message), failing as unknown as Env)).rejects.toThrow(
      "R2 down",
    );
    expect(message.forward).not.toHaveBeenCalled();
    expect(await messageRows()).toEqual([]);
  });

  it("throws before any forward when D1 fails", async () => {
    await addAddress("shop", { targets: ["a@dest.example"] });
    await env.DB.exec(
      "CREATE TRIGGER fail_message_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'D1 down'); END",
    );
    const message = inbound("shop@example.com");
    await expect(handleEmail(asMessage(message), env)).rejects.toThrow();
    expect(message.forward).not.toHaveBeenCalled();
    expect(await messageRows()).toEqual([]);
  });

  it("leaves the row stored when the queue send fails, and the cron step re-enqueues it", async () => {
    await addAddress("shop");
    const send = vi.spyOn(env.INBOUND, "send").mockRejectedValue(new Error("queue down"));
    await expect(handleEmail(asMessage(inbound("shop@example.com")), env)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    const [row] = await messageRows();
    expect(row?.status).toBe("stored");

    // Not yet 15 minutes old: the cron step leaves it alone.
    expect(await requeueStored(env, Date.now())).toBe(0);

    const receivedAt = row?.received_at as number;
    await handleScheduled(
      { scheduledTime: receivedAt + STUCK_AFTER_MS } as ScheduledController,
      env,
    );
    await waitParsed();
  });

  it("re-enqueues at most 100 stuck messages per run", async () => {
    const now = Date.now();
    const insert = env.DB.prepare(
      `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
         raw_size, r2_key, received_at) VALUES (?, 1, 'in', ?, 'a@b.c', 'shop@example.com', 1, 'k', ?)`,
    );
    await env.DB.batch([
      ...Array.from({ length: 101 }, (_, i) =>
        insert.bind(`s${i}`, "stored", now - STUCK_AFTER_MS - i),
      ),
      insert.bind("p", "parsed", now - STUCK_AFTER_MS - 500),
    ]);
    const sendBatch = vi.spyOn(env.INBOUND, "sendBatch").mockResolvedValue(undefined as never);
    expect(await requeueStored(env, now)).toBe(100);
    const sent = sendBatch.mock.calls[0]?.[0] as { body: { id: string } }[];
    expect(sent).toHaveLength(100);
    // Oldest first; the parsed row and the newest stuck row wait for the next run.
    expect(sent[0]?.body.id).toBe("s100");
    expect(sent.map((m) => m.body.id)).not.toContain("p");
    expect(sent.map((m) => m.body.id)).not.toContain("s0");
  });

  it("logs a failing cron job by name and fails the run", async () => {
    vi.spyOn(env.INBOUND, "sendBatch").mockRejectedValue(new Error("queue down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare(
      `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
         raw_size, r2_key, received_at) VALUES ('x', 1, 'in', 'stored', 'a@b.c', 'shop@example.com', 1, 'k', 0)`,
    ).run();
    await expect(
      handleScheduled({ scheduledTime: Date.now() } as ScheduledController, env),
    ).rejects.toThrow("1 cron job(s) failed");
    expect(error.mock.calls.join(" ")).toContain('"job":"requeue_stored"');
  });
});
