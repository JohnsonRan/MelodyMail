import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { Client, login, setupOwner, totpCode } from "./helpers";

// A fresh documentation-range address per test: the rate limiter counts per IP across tests.
let lastOctet = 0;
const publicIp = () => `203.0.113.${++lastOctet}`;

type Row = {
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  organization: string | null;
  geoSource: string | null;
};

/** The session row of the client's current cookie, read by the newest created_at. */
function newestSession() {
  return env.DB.prepare(
    "SELECT ip, country, region, city, organization, geo_source AS geoSource FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).first<Row>();
}

/** Waits for the lookup that runs after the response. */
function located() {
  return vi.waitFor(
    async () => {
      const row = await newestSession();
      if (!row?.geoSource) throw new Error("not located yet");
      return row;
    },
    { timeout: 3_000, interval: 20 },
  );
}

async function signInFrom(ip: string, cf?: Record<string, unknown>) {
  const owner = await setupOwner();
  const client = new Client();
  client.ip = ip;
  client.cf = cf;
  const { res } = await login(owner.authenticator, client);
  return { res, client };
}

describe("session location", () => {
  it("stores the client IP on the new session", async () => {
    const address = publicIp();
    await signInFrom(address);
    expect((await newestSession())?.ip).toBe(address);
  });

  it("stores the ip.sb answer after the response", async () => {
    const address = publicIp();
    // The Response is built inside the call: workerd ties a body to the request that made it.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        country_code: "JP",
        country: "Japan",
        region: "Tokyo",
        city: "Chiyoda",
        isp: "Example ISP",
      }),
    );
    const { res } = await signInFrom(address);
    expect(res.status).toBe(200);
    expect(await located()).toEqual({
      ip: address,
      country: "JP",
      region: "Tokyo",
      city: "Chiyoda",
      organization: "Example ISP",
      geoSource: "ip.sb",
    });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe(`https://api.ip.sb/geoip/${address}`);
  });

  it("falls back to request.cf when ip.sb fails", async () => {
    const address = publicIp();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ message: "busy" }, { status: 503 }),
    );
    const cf = { country: "DE", region: "Berlin", city: "Berlin", asOrganization: "Example AS" };
    await signInFrom(address, cf);
    expect(await located()).toMatchObject({
      country: "DE",
      region: "Berlin",
      city: "Berlin",
      organization: "Example AS",
      geoSource: "cf",
    });
  });

  it("does not look up a loopback or private address", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const owner = await setupOwner();
    for (const ip of ["127.0.0.1", "192.168.1.20", "::1"]) {
      await env.DB.prepare("DELETE FROM sessions").run();
      const client = new Client();
      client.ip = ip;
      await login(owner.authenticator, client);
      expect(await newestSession()).toMatchObject({ ip, geoSource: "local" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still signs in when ip.sb throws", async () => {
    const address = publicIp();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new TypeError("network down");
    });
    const { res, client } = await signInFrom(address);
    expect(res.status).toBe(200);
    expect(await client.json("GET", "/api/auth/state")).toMatchObject({ authenticated: true });
    expect((await located()).geoSource).toBe("cf");
  });

  it("lists the IP and location of each session", async () => {
    const address = publicIp();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ country_code: "JP", region: "Tokyo", city: "Chiyoda", isp: "Example ISP" }),
    );
    const { client } = await signInFrom(address);
    await located();
    const list = await client.json("GET", "/api/auth/sessions");
    expect(list.sessions).toContainEqual(
      expect.objectContaining({
        ip: address,
        country: "JP",
        city: "Chiyoda",
        organization: "Example ISP",
        geoSource: "ip.sb",
        current: true,
      }),
    );
  });

  it("locates the sessions that setup and recovery open", async () => {
    const address = publicIp();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ country_code: "JP", city: "Chiyoda" }),
    );
    const setupClient = new Client();
    setupClient.ip = address;
    const owner = await setupOwner(setupClient);
    expect(await located()).toMatchObject({ ip: address, geoSource: "ip.sb" });

    const recovered = new Client();
    recovered.ip = publicIp();
    const res = await recovered.request("POST", "/api/auth/recover", {
      recoveryKey: owner.recoveryKey,
      totpCode: await totpCode(owner.totpSecret, 1),
    });
    expect(res.status).toBe(200);
    expect(await located()).toMatchObject({ ip: recovered.ip, geoSource: "ip.sb" });
  });

  it("ignores a cf-connecting-ip that is not an IP address", async () => {
    await signInFrom("not-an-ip");
    expect(await newestSession()).toMatchObject({ ip: null, geoSource: null });
  });
});
