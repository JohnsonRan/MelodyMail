import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type Client, setupOwner } from "./helpers";

type Json = Record<string, unknown>;

async function owner(): Promise<Client> {
  return (await setupOwner()).client;
}

async function auditRows() {
  const { results } = await env.DB.prepare(
    "SELECT event, detail FROM audit_log WHERE event NOT IN ('setup') ORDER BY id",
  ).all<{ event: string; detail: string | null }>();
  return results;
}

describe("domains", () => {
  it("adds, lists and normalizes a domain", async () => {
    const client = await owner();
    const added = await client.json("POST", "/api/domains", { name: " Example.COM. " }, 201);
    expect(added.domain).toMatchObject({
      name: "example.com",
      receiveEnabled: true,
      sendEnabled: false,
      addressCount: 0,
    });
    const list = (await client.json("GET", "/api/domains")).domains as Json[];
    expect(list.map((d) => d.name)).toEqual(["example.com"]);
    expect(await auditRows()).toEqual([{ event: "domain_added", detail: "example.com" }]);
  });

  it("refuses a duplicate in any case", async () => {
    const client = await owner();
    await client.json("POST", "/api/domains", { name: "example.com" }, 201);
    expect(await client.json("POST", "/api/domains", { name: "EXAMPLE.com" }, 409)).toEqual({
      error: "domain_exists",
    });
  });

  it("refuses malformed and non-ASCII names", async () => {
    const client = await owner();
    for (const name of [
      "",
      "localhost",
      "-bad.com",
      "bad-.com",
      "a..com",
      "exa mple.com",
      "example.123",
      `${"a".repeat(64)}.com`,
      `${"a.".repeat(127)}com`,
      42,
    ]) {
      expect(await client.json("POST", "/api/domains", { name }, 400), String(name)).toEqual({
        error: "invalid_domain",
      });
    }
    expect(await client.json("POST", "/api/domains", { name: "bücher.de" }, 400)).toEqual({
      error: "domain_not_ascii",
    });
    await client.json("POST", "/api/domains", { name: "xn--bcher-kva.de" }, 201);
  });

  it("switches receiving and sending", async () => {
    const client = await owner();
    await client.json("POST", "/api/domains", { name: "example.com" }, 201);
    const off = await client.json("PATCH", "/api/domains/example.com", { receiveEnabled: false });
    expect(off.domain).toMatchObject({ receiveEnabled: false, sendEnabled: false });
    const on = await client.json("PATCH", "/api/domains/example.com", { sendEnabled: true });
    expect(on.domain).toMatchObject({ receiveEnabled: false, sendEnabled: true });
    expect(
      await client.json("PATCH", "/api/domains/example.com", { sendEnabled: "yes" }, 400),
    ).toEqual({ error: "bad_request" });
    expect(await client.json("PATCH", "/api/domains/other.com", {}, 404)).toEqual({
      error: "not_found",
    });
  });

  it("refuses to remove a domain with addresses unless asked to delete them", async () => {
    const client = await owner();
    await client.json("POST", "/api/domains", { name: "example.com" }, 201);
    // Rows written directly, so this file does not depend on the address routes.
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO forward_targets (id, email, created_at) VALUES (1, 'me@out.test', ?)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO addresses (id, local_part, domain, created_at) VALUES (1, 'shop', 'example.com', ?)",
      ).bind(now),
      env.DB.prepare("INSERT INTO address_forwards (address_id, target_id) VALUES (1, 1)"),
    ]);
    expect(await client.json("DELETE", "/api/domains/example.com", undefined, 409)).toEqual({
      error: "domain_has_addresses",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM domains").first("n")).toBe(1);

    const done = await client.json("DELETE", "/api/domains/example.com?deleteAddresses=1");
    expect(done).toEqual({ ok: true, deletedAddresses: 1 });
    for (const table of ["domains", "addresses", "address_forwards"]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n"), table).toBe(0);
    }
    // The target itself stays.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM forward_targets").first("n")).toBe(1);
    expect((await auditRows()).at(-1)).toEqual({
      event: "domain_removed",
      detail: "example.com (1 addresses)",
    });
  });

  it("removes an unused domain and answers 404 for an unknown one", async () => {
    const client = await owner();
    await client.json("POST", "/api/domains", { name: "example.com" }, 201);
    expect(await client.json("DELETE", "/api/domains/example.com")).toEqual({
      ok: true,
      deletedAddresses: 0,
    });
    expect(await client.json("DELETE", "/api/domains/example.com", undefined, 404)).toEqual({
      error: "not_found",
    });
  });

  it("lists the records the owner must publish", async () => {
    const client = await owner();
    await client.json("POST", "/api/domains", { name: "example.com" }, 201);
    const dns = await client.json("GET", "/api/domains/example.com/dns");
    expect(dns.receive).toEqual([
      {
        id: "mx",
        type: "MX",
        name: "example.com",
        values: [
          "route1.mx.cloudflare.net",
          "route2.mx.cloudflare.net",
          "route3.mx.cloudflare.net",
        ],
      },
      {
        id: "spf",
        type: "TXT",
        name: "example.com",
        values: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
      },
      { id: "dmarc", type: "TXT", name: "_dmarc.example.com", values: ["v=DMARC1; p=none;"] },
    ]);
    expect((dns.send as Json[]).map((r) => r.values)).toEqual([null, null, null]);
    expect(await client.json("GET", "/api/domains/other.com/dns", undefined, 404)).toEqual({
      error: "not_found",
    });
  });
});
