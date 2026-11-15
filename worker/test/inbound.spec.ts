import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { FORWARDED_HEADER, handleEmail, parseRecipient } from "../src/mail/inbound";
import { addAddress, asMessage, inbound, messageRows, r2Keys } from "./mail-helpers";

async function auditDetails(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT detail FROM audit_log WHERE event = 'mail_forwarded'",
  ).all<{ detail: string }>();
  return results.map((r) => r.detail);
}

afterEach(async () => {
  await env.DB.exec("DROP TRIGGER IF EXISTS fail_message_insert");
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

  it("keeps the stored row when the queue send fails", async () => {
    await addAddress("shop");
    const send = vi.spyOn(env.INBOUND, "send").mockRejectedValue(new Error("queue down"));
    await expect(handleEmail(asMessage(inbound("shop@example.com")), env)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    expect((await messageRows())[0]?.status).toBe("stored");
  });

  it("enqueues the id of the stored message", async () => {
    await addAddress("shop");
    const send = vi.spyOn(env.INBOUND, "send");
    await handleEmail(asMessage(inbound("shop@example.com")), env);
    expect(send).toHaveBeenCalledWith({ id: (await messageRows())[0]?.id });
  });
});
