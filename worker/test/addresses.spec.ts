import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type Client, setupOwner } from "./helpers";

type Json = Record<string, unknown>;

async function ownerWithDomain(): Promise<Client> {
  const { client } = await setupOwner();
  await client.json("POST", "/api/domains", { name: "example.com" }, 201);
  return client;
}

async function addTarget(client: Client, email: string): Promise<number> {
  const res = await client.json("POST", "/api/forward-targets", { email }, 201);
  return (res.target as { id: number }).id;
}

describe("addresses", () => {
  it("adds an address with its settings and lists it", async () => {
    const client = await ownerWithDomain();
    const target = await addTarget(client, "me@out.test");
    const res = await client.json(
      "POST",
      "/api/addresses",
      {
        localPart: "Shop.Orders",
        domain: "EXAMPLE.com",
        note: " orders ",
        displayName: "Shop",
        forwardOnly: true,
        targetIds: [target, target],
      },
      201,
    );
    expect(res.address).toMatchObject({
      localPart: "shop.orders",
      domain: "example.com",
      address: "shop.orders@example.com",
      note: "orders",
      displayName: "Shop",
      enabled: true,
      forwardOnly: true,
      targetIds: [target],
      lastReceivedAt: null,
    });
    const list = (await client.json("GET", "/api/addresses")).addresses as Json[];
    expect(list.map((a) => a.address)).toEqual(["shop.orders@example.com"]);
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_log WHERE event = 'address_added'",
    ).first("detail");
    expect(audit).toBe("shop.orders@example.com");
  });

  it("treats the prefix case-insensitively for uniqueness", async () => {
    const client = await ownerWithDomain();
    await client.json("POST", "/api/addresses", { localPart: "shop", domain: "example.com" }, 201);
    expect(
      await client.json(
        "POST",
        "/api/addresses",
        { localPart: "SHOP", domain: "example.com" },
        409,
      ),
    ).toEqual({ error: "address_exists" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM addresses").first("n")).toBe(1);
  });

  it("creates one address when two requests race", async () => {
    const client = await ownerWithDomain();
    const body = { localPart: "shop", domain: "example.com" };
    const results = await Promise.all([
      client.request("POST", "/api/addresses", body),
      client.request("POST", "/api/addresses", { ...body, localPart: "Shop" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM addresses").first("n")).toBe(1);
  });

  it("allows the same prefix on another domain", async () => {
    const client = await ownerWithDomain();
    await client.json("POST", "/api/domains", { name: "example.org" }, 201);
    await client.json("POST", "/api/addresses", { localPart: "shop", domain: "example.com" }, 201);
    await client.json("POST", "/api/addresses", { localPart: "shop", domain: "example.org" }, 201);
  });

  it("refuses '+' and other characters outside the allowed set", async () => {
    const client = await ownerWithDomain();
    for (const localPart of [
      "shop+tag",
      "",
      ".shop",
      "shop.",
      "sh..op",
      "sh op",
      "shöp",
      "a@b",
      "a".repeat(65),
      7,
    ]) {
      const res = await client.json(
        "POST",
        "/api/addresses",
        { localPart, domain: "example.com" },
        400,
      );
      expect(res, String(localPart)).toEqual({ error: "invalid_local_part" });
    }
    await client.json(
      "POST",
      "/api/addresses",
      { localPart: "a-b_c.9", domain: "example.com" },
      201,
    );
  });

  it("refuses an unknown domain, target or a bad field", async () => {
    const client = await ownerWithDomain();
    const post = (body: Json) => client.json("POST", "/api/addresses", body, 400);
    expect(await post({ localPart: "a", domain: "example.net" })).toEqual({
      error: "unknown_domain",
    });
    expect(await post({ localPart: "a", domain: "example.com", targetIds: [999] })).toEqual({
      error: "unknown_target",
    });
    expect(await post({ localPart: "a", domain: "example.com", targetIds: ["1"] })).toEqual({
      error: "bad_request",
    });
    expect(
      await post({ localPart: "a", domain: "example.com", displayName: "A\r\nBcc: x" }),
    ).toEqual({ error: "invalid_display_name" });
    expect(await post({ localPart: "a", domain: "example.com", note: "n".repeat(201) })).toEqual({
      error: "invalid_note",
    });
    expect(await post({ localPart: "a", domain: "example.com", enabled: "no" })).toEqual({
      error: "bad_request",
    });
    expect(await post({ localPart: "a", domain: "example.com", forwardOnly: true })).toEqual({
      error: "forward_only_needs_target",
    });
  });

  it("updates switches, note, name and targets", async () => {
    const client = await ownerWithDomain();
    const t1 = await addTarget(client, "one@out.test");
    const t2 = await addTarget(client, "two@out.test");
    const created = await client.json(
      "POST",
      "/api/addresses",
      { localPart: "shop", domain: "example.com", targetIds: [t1] },
      201,
    );
    const id = (created.address as { id: number }).id;
    const path = `/api/addresses/${id}`;
    const res = await client.json("PATCH", path, {
      enabled: false,
      note: "paused",
      displayName: "Shop Desk",
      targetIds: [t2],
      forwardOnly: true,
    });
    expect(res.address).toMatchObject({
      enabled: false,
      note: "paused",
      displayName: "Shop Desk",
      forwardOnly: true,
      targetIds: [t2],
    });
    // Absent fields stay as they are.
    const same = await client.json("PATCH", path, { enabled: true });
    expect(same.address).toMatchObject({ enabled: true, note: "paused", targetIds: [t2] });
    // Forward only cannot lose its last target.
    expect(await client.json("PATCH", path, { targetIds: [] }, 400)).toEqual({
      error: "forward_only_needs_target",
    });
    expect(await client.json("PATCH", path, { targetIds: [12345] }, 400)).toEqual({
      error: "unknown_target",
    });
    const cleared = await client.json("PATCH", path, { forwardOnly: false, targetIds: [] });
    expect(cleared.address).toMatchObject({ forwardOnly: false, targetIds: [] });
    expect(await client.json("PATCH", "/api/addresses/999", {}, 404)).toEqual({
      error: "not_found",
    });
    expect(await client.json("PATCH", "/api/addresses/abc", {}, 404)).toEqual({
      error: "not_found",
    });
  });

  it("deletes an address with its target links", async () => {
    const client = await ownerWithDomain();
    const target = await addTarget(client, "me@out.test");
    const created = await client.json(
      "POST",
      "/api/addresses",
      { localPart: "shop", domain: "example.com", targetIds: [target] },
      201,
    );
    const id = (created.address as { id: number }).id;
    expect(await client.json("DELETE", `/api/addresses/${id}`)).toEqual({ ok: true });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM address_forwards").first("n")).toBe(0);
    expect(await client.json("DELETE", `/api/addresses/${id}`, undefined, 404)).toEqual({
      error: "not_found",
    });
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_log WHERE event = 'address_removed'",
    ).first("detail");
    expect(audit).toBe("shop@example.com");
  });

  it("finds an address by (domain, local part) through the unique index", async () => {
    const client = await ownerWithDomain();
    await client.json("POST", "/api/addresses", { localPart: "shop", domain: "example.com" }, 201);
    const { results } = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM addresses WHERE domain = ? AND local_part = ?",
    )
      .bind("example.com", "shop")
      .all<{ detail: string }>();
    expect(results.map((r) => r.detail).join(" ")).toContain("addresses_domain_local_part");
  });
});
