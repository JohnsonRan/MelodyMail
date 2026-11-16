import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { handleScheduled, MAX_ATTEMPTS, requeueStored, STUCK_AFTER_MS } from "../src/mail/consumer";
import { FORWARD_MAX, FORWARDED_HEADER, handleEmail, parseRecipient } from "../src/mail/inbound";
import { addAddress, addRule, asMessage, inbound, messageRows, r2Keys } from "./mail-helpers";

/** env with an R2 bucket whose writes fail. */
function r2Down(): Env {
  return { ...env, MAIL: { put: () => Promise.reject(new Error("R2 down")) } } as unknown as Env;
}

async function failMessageInsert() {
  await env.DB.exec(
    "CREATE TRIGGER fail_message_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'D1 down'); END",
  );
}

async function unstoredAudit(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT detail FROM audit_log WHERE event = 'mail_forwarded_unstored'",
  ).all<{ detail: string }>();
  return results.map((r) => r.detail);
}

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

  it("forwards instead of throwing when R2 fails and the address has targets", async () => {
    const id = await addAddress("shop", { targets: ["a@dest.example", "b@dest.example"] });
    const message = inbound("shop@example.com");
    await expect(handleEmail(asMessage(message), r2Down())).resolves.toBeUndefined();
    expect(message.forward).toHaveBeenCalledTimes(2);
    expect(message.forward.mock.calls[0]?.[1]?.get(FORWARDED_HEADER)).toBe("1");
    expect(await messageRows()).toEqual([]);
    expect(await unstoredAudit()).toEqual([`address ${id}: 2/2`]);
  });

  it("forwards instead of throwing when the D1 insert fails, naming the orphan raw object", async () => {
    const id = await addAddress("shop", { targets: ["a@dest.example"] });
    await failMessageInsert();
    const message = inbound("shop@example.com");
    await expect(handleEmail(asMessage(message), env)).resolves.toBeUndefined();
    expect(message.forward).toHaveBeenCalledOnce();
    expect(await messageRows()).toEqual([]);
    const [orphan] = await r2Keys();
    expect(orphan?.startsWith("raw/")).toBe(true);
    expect(await unstoredAudit()).toEqual([`address ${id}: 1/1; orphan ${orphan}`]);
  });

  it("throws when storage fails and no forward of the fallback goes out", async () => {
    await addAddress("shop", { targets: ["a@dest.example"] });
    const message = inbound("shop@example.com");
    message.forward.mockRejectedValue(new Error("destination address not verified"));
    await expect(handleEmail(asMessage(message), r2Down())).rejects.toThrow("R2 down");
    expect(message.forward).toHaveBeenCalledOnce();
    expect(await unstoredAudit()).toEqual([]);
  });

  it("throws before any forward when storage fails and the address has no targets", async () => {
    await addAddress("shop");
    await expect(handleEmail(asMessage(inbound("shop@example.com")), r2Down())).rejects.toThrow(
      "R2 down",
    );
    await failMessageInsert();
    await expect(handleEmail(asMessage(inbound("shop@example.com")), env)).rejects.toThrow();
    expect(await messageRows()).toEqual([]);
  });

  it("throws without forwarding when storage fails for a looped message", async () => {
    await addAddress("shop", { targets: ["a@dest.example"] });
    const message = inbound("shop@example.com", undefined, { [FORWARDED_HEADER]: "1" });
    await expect(handleEmail(asMessage(message), r2Down())).rejects.toThrow("R2 down");
    expect(message.forward).not.toHaveBeenCalled();
  });

  it("throws when a forward-only address cannot forward or store, trying each target once", async () => {
    await addAddress("fwd", { forwardOnly: true, targets: ["a@dest.example", "b@dest.example"] });
    const message = inbound("fwd@example.com");
    message.forward.mockRejectedValue(new Error("destination address not verified"));
    await expect(handleEmail(asMessage(message), r2Down())).rejects.toThrow("R2 down");
    expect(message.forward).toHaveBeenCalledTimes(2);
    expect(await unstoredAudit()).toEqual([]);
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

  it("re-enqueues no parse_failed or used-up message, and ends a used-up one", async () => {
    const now = Date.now();
    const old = now - STUCK_AFTER_MS - 1;
    const insert = env.DB.prepare(
      `INSERT INTO messages (id, address_id, direction, status, envelope_from, envelope_to,
         raw_size, r2_key, received_at, attempts) VALUES (?, 1, 'in', ?, 'a@b.c', 'shop@example.com', 1, 'k', ?, ?)`,
    );
    await env.DB.batch([
      insert.bind("used-up", "stored", old, MAX_ATTEMPTS),
      insert.bind("one-left", "stored", old, MAX_ATTEMPTS - 1),
      insert.bind("failed", "parse_failed", old, 1),
    ]);
    const sendBatch = vi.spyOn(env.INBOUND, "sendBatch").mockResolvedValue(undefined as never);
    expect(await requeueStored(env, now)).toBe(1);
    expect(sendBatch.mock.calls[0]?.[0]).toEqual([{ body: { id: "one-left" } }]);
    const { results } = await env.DB.prepare("SELECT id, status FROM messages ORDER BY id").all();
    expect(results).toEqual([
      { id: "failed", status: "parse_failed" },
      { id: "one-left", status: "stored" },
      { id: "used-up", status: "parse_failed" },
    ]);
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

describe("email() with rules", () => {
  const fromGithub = [{ field: "from", op: "contains", value: "github" }];
  const github = (to = "shop@example.com", headers: Record<string, string> = {}) =>
    inbound(to, undefined, { From: "GitHub <noreply@github.com>", ...headers });
  const forwardedTo = (m: ReturnType<typeof inbound>) => m.forward.mock.calls.map((c) => c[0]);
  const flags = async () =>
    (await messageRows()).map((r) => [r.read, r.starred, r.archived, r.trashed]);

  it("writes the flags in the INSERT and forwards to a rule target once beside the defaults", async () => {
    await addAddress("shop", { targets: ["a@dest.example", "b@dest.example"] });
    await addRule({ conditions: fromGithub, markRead: true, targets: ["b@dest.example"] });
    await addRule({
      conditions: fromGithub,
      star: true,
      archive: true,
      targets: ["c@dest.example"],
    });
    await addRule({
      conditions: fromGithub,
      trash: true,
      enabled: false,
      targets: ["d@dest.example"],
    });
    const message = github();
    await handleEmail(asMessage(message), env);
    expect(forwardedTo(message)).toEqual(["a@dest.example", "b@dest.example", "c@dest.example"]);
    expect(await flags()).toEqual([[1, 1, 1, 0]]);
    const unmatched = inbound("shop@example.com");
    await handleEmail(asMessage(unmatched), env);
    expect(forwardedTo(unmatched)).toEqual(["a@dest.example", "b@dest.example"]);
  });

  it("uses the rules as they are when each message arrives", async () => {
    await addAddress("shop");
    // The recipient condition reads the address without its sub-address tag.
    const recipient = { field: "recipient", op: "equals", value: "shop@example.com" };
    const id = await addRule({ conditions: [...fromGithub, recipient], trash: true });
    await handleEmail(asMessage(github("shop+news@example.com")), env);
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(id).run();
    await handleEmail(asMessage(github()), env);
    expect((await flags()).map((f) => f[3])).toEqual([1, 0]);
  });

  it("keeps the loop guard for rule targets but still applies the flags", async () => {
    await addAddress("shop");
    await addRule({ conditions: fromGithub, trash: true, targets: ["a@dest.example"] });
    const message = github("shop@example.com", { [FORWARDED_HEADER]: "1" });
    await handleEmail(asMessage(message), env);
    expect(message.forward).not.toHaveBeenCalled();
    expect(await flags()).toEqual([[0, 0, 0, 1]]);
  });

  it("forward-only: forwards to defaults and rule targets and stores nothing", async () => {
    const id = await addAddress("fwd", { forwardOnly: true, targets: ["a@dest.example"] });
    await addRule({ conditions: fromGithub, archive: true, targets: ["b@dest.example"] });
    const message = github("fwd@example.com");
    await handleEmail(asMessage(message), env);
    expect(forwardedTo(message)).toEqual(["a@dest.example", "b@dest.example"]);
    expect(await messageRows()).toEqual([]);
    expect(await auditDetails()).toEqual([`address ${id}: 2/2`]);
  });

  it("forward-only: stores with the flags when every forward fails", async () => {
    await addAddress("fwd", { forwardOnly: true, targets: ["a@dest.example"] });
    await addRule({ conditions: fromGithub, star: true, targets: ["b@dest.example"] });
    const message = github("fwd@example.com");
    message.forward.mockRejectedValue(new Error("destination address not verified"));
    await handleEmail(asMessage(message), env);
    expect(message.forward).toHaveBeenCalledTimes(2);
    expect(await flags()).toEqual([[0, 1, 0, 0]]);
    expect((await messageRows())[0]?.forward_failed).toBe(2);
  });

  it("forwards to rule targets instead when storage fails", async () => {
    const id = await addAddress("shop");
    await addRule({ conditions: fromGithub, targets: ["a@dest.example"] });
    const message = github();
    await handleEmail(asMessage(message), r2Down());
    expect(forwardedTo(message)).toEqual(["a@dest.example"]);
    expect(await unstoredAudit()).toEqual([`address ${id}: 1/1`]);
  });

  it("forwards to the first 10 distinct targets and audits the count", async () => {
    const defaults = ["d1", "d2", "d3"].map((n) => `${n}@dest.example`);
    const id = await addAddress("shop", { targets: defaults });
    const ruled = Array.from({ length: 10 }, (_, i) => `r${i}@dest.example`);
    await addRule({ conditions: fromGithub, targets: [defaults[0] ?? "", ...ruled.slice(0, 4)] });
    await addRule({ conditions: fromGithub, targets: ruled.slice(4, 9) });
    await addRule({ conditions: fromGithub, targets: ruled.slice(9) });
    const message = github();
    await handleEmail(asMessage(message), env);
    expect(forwardedTo(message)).toEqual([...defaults, ...ruled.slice(0, FORWARD_MAX - 3)]);
    const capped = await env.DB.prepare(
      "SELECT detail FROM audit_log WHERE event = 'mail_forward_capped'",
    ).all();
    expect(capped.results).toEqual([{ detail: `address ${id}: 13` }]);
  });

  it("reads no rules for a rejected recipient, and stores without rules when they cannot be read", async () => {
    await addAddress("shop", { targets: ["a@dest.example"] });
    await addRule({ conditions: fromGithub, trash: true, targets: ["b@dest.example"] });
    const prepare = vi.spyOn(env.DB, "prepare");
    await handleEmail(asMessage(github("nobody@example.com")), env);
    expect(prepare.mock.calls.some(([sql]) => sql.includes("FROM rules"))).toBe(false);

    await env.DB.exec("ALTER TABLE rules RENAME TO rules_away");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const message = github();
      await handleEmail(asMessage(message), env);
      expect(forwardedTo(message)).toEqual(["a@dest.example"]);
      expect(await flags()).toEqual([[0, 0, 0, 0]]);
      expect(error.mock.calls.join(" ")).toContain("rules_load_failed");
    } finally {
      await env.DB.exec("ALTER TABLE rules_away RENAME TO rules");
    }
  });
});
