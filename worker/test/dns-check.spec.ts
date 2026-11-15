import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { txtValue } from "../src/domains/dns";
import { type Client, setupOwner } from "./helpers";

type Zone = Record<string, { Status?: number; Answer?: { type: number; data: string }[] }>;

const MX = 15;
const TXT = 16;
const CF_MX = [
  "route1.mx.cloudflare.net.",
  "route2.mx.cloudflare.net.",
  "route3.mx.cloudflare.net.",
];
const mx = (hosts: string[]) => hosts.map((h, i) => ({ type: MX, data: `${10 + i} ${h}` }));
const txt = (...values: string[]) => values.map((v) => ({ type: TXT, data: v }));

/** Answers DoH queries from a fake zone keyed "name TYPE"; unknown names are NXDOMAIN. */
function mockDoh(zone: Zone) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(`${url.origin}${url.pathname}`).toBe(env.DOH_URL);
    expect(new Headers(init?.headers).get("accept")).toBe("application/dns-json");
    const key = `${url.searchParams.get("name")} ${url.searchParams.get("type")}`;
    return Response.json(zone[key] ?? { Status: 3 });
  });
}

async function ownerWithDomain(): Promise<Client> {
  const { client } = await setupOwner();
  await client.json("POST", "/api/domains", { name: "example.com" }, 201);
  return client;
}

async function check(client: Client) {
  const res = await client.json("POST", "/api/domains/example.com/dns/check", {});
  return Object.fromEntries(
    (res.records as { id: string; status: string }[]).map((r) => [r.id, r.status]),
  );
}

describe("DNS check", () => {
  it("reports every record found", async () => {
    const client = await ownerWithDomain();
    const fetch = mockDoh({
      // A resolver may put a CNAME in the answer before the records asked for.
      "example.com MX": {
        Status: 0,
        Answer: [{ type: 5, data: "alias.example.net." }, ...mx(CF_MX)],
      },
      "example.com TXT": {
        Status: 0,
        Answer: txt(
          '"google-site-verification=abc"',
          '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
        ),
      },
      "_dmarc.example.com TXT": { Status: 0, Answer: txt('"v=DMARC1; p=none;"') },
    });
    expect(await check(client)).toEqual({ mx: "found", spf: "found", dmarc: "found" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("reports missing records on an empty or unknown name", async () => {
    const client = await ownerWithDomain();
    mockDoh({ "example.com MX": { Status: 0 }, "example.com TXT": { Status: 0, Answer: [] } });
    expect(await check(client)).toEqual({ mx: "missing", spf: "missing", dmarc: "missing" });
  });

  it("reports records that differ from what Email Routing needs", async () => {
    const client = await ownerWithDomain();
    mockDoh({
      "example.com MX": { Status: 0, Answer: mx([...CF_MX, "mx.other.test."]) },
      "example.com TXT": { Status: 0, Answer: txt('"v=spf1 include:other.test ~all"') },
      "_dmarc.example.com TXT": { Status: 0, Answer: txt('"not a policy"') },
    });
    expect(await check(client)).toEqual({ mx: "different", spf: "different", dmarc: "different" });
  });

  it("counts two SPF records as different, and a partial MX set as different", async () => {
    const client = await ownerWithDomain();
    mockDoh({
      "example.com MX": { Status: 0, Answer: mx(CF_MX.slice(0, 2)) },
      "example.com TXT": {
        Status: 0,
        Answer: txt('"v=spf1 include:_spf.mx.cloudflare.net ~all"', '"v=spf1 -all"'),
      },
      "_dmarc.example.com TXT": { Status: 0, Answer: txt('"v=DMARC1; p=none;"') },
    });
    expect(await check(client)).toEqual({ mx: "different", spf: "different", dmarc: "found" });
  });

  it("joins TXT strings split by the resolver", () => {
    expect(txtValue('"v=spf1 include:_spf.mx." "cloudflare.net ~all"')).toBe(
      "v=spf1 include:_spf.mx.cloudflare.net ~all",
    );
    expect(txtValue('"a \\"quoted\\" word"')).toBe('a "quoted" word');
  });

  it("answers 502 dns_check_failed without detail when DoH fails", async () => {
    const client = await ownerWithDomain();
    const path = "/api/domains/example.com/dns/check";
    // The default mock: every outbound fetch rejects.
    expect(await client.json("POST", path, {}, 502)).toEqual({ error: "dns_check_failed" });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("busy", { status: 503 }));
    expect(await client.json("POST", path, {}, 502)).toEqual({ error: "dns_check_failed" });

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ Status: 0 }, { status: 500 }),
    );
    expect(await client.json("POST", path, {}, 502)).toEqual({ error: "dns_check_failed" });

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ Status: 2 }));
    expect(await client.json("POST", path, {}, 502)).toEqual({ error: "dns_check_failed" });

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("<html>"));
    expect(await client.json("POST", path, {}, 502)).toEqual({ error: "dns_check_failed" });
  });

  it("answers 404 for a domain that is not added, without a lookup", async () => {
    const client = await ownerWithDomain();
    const fetch = mockDoh({});
    expect(await client.json("POST", "/api/domains/other.com/dns/check", {}, 404)).toEqual({
      error: "not_found",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
