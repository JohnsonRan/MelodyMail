import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { Client, login, setupOwner, totpCode } from "./helpers";

// A fresh documentation-range address per test: the rate limiter counts per IP across tests.
let lastOctet = 0;
const publicIp = () => `203.0.113.${++lastOctet}`;
const CF = { country: "JP", region: "Tokyo", city: "Chiyoda", asOrganization: "Example AS" };

type Row = {
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  organization: string | null;
  geoSource: string | null;
};

function newestSession() {
  return env.DB.prepare(
    "SELECT ip, country, region, city, organization, geo_source AS geoSource FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).first<Row>();
}

function clientFrom(ip: string, cf?: Record<string, unknown>) {
  const client = new Client();
  client.ip = ip;
  client.cf = cf;
  return client;
}

describe("session location", () => {
  it("stores the IP and the request.cf location with the new session", async () => {
    const owner = await setupOwner();
    const address = publicIp();
    const { res } = await login(owner.authenticator, clientFrom(address, CF));
    expect(res.status).toBe(200);
    expect(await newestSession()).toEqual({
      ip: address,
      country: "JP",
      region: "Tokyo",
      city: "Chiyoda",
      organization: "Example AS",
      geoSource: "cf",
    });
  });

  it("locates the sessions that setup and recovery open", async () => {
    const setupAddress = publicIp();
    const owner = await setupOwner(clientFrom(setupAddress, CF));
    expect(await newestSession()).toMatchObject({ ip: setupAddress, city: "Chiyoda" });

    const recovered = clientFrom(publicIp(), { ...CF, city: "Shibuya" });
    const res = await recovered.request("POST", "/api/auth/recover", {
      recoveryKey: owner.recoveryKey,
      totpCode: await totpCode(owner.totpSecret, 1),
    });
    expect(res.status).toBe(200);
    expect(await newestSession()).toMatchObject({ ip: recovered.ip, city: "Shibuya" });
  });

  it("stores no location for a loopback or private address", async () => {
    const owner = await setupOwner();
    for (const ip of ["127.0.0.1", "192.168.1.20", "::1"]) {
      await login(owner.authenticator, clientFrom(ip, CF));
      expect(await newestSession()).toEqual({
        ip,
        country: null,
        region: null,
        city: null,
        organization: null,
        geoSource: "local",
      });
    }
  });

  it("signs in without a location when request.cf is missing", async () => {
    const owner = await setupOwner();
    const address = publicIp();
    const { res } = await login(owner.authenticator, clientFrom(address));
    expect(res.status).toBe(200);
    expect(await newestSession()).toMatchObject({ ip: address, country: null, geoSource: null });
  });

  it("makes no outbound request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const owner = await setupOwner();
    await login(owner.authenticator, clientFrom(publicIp(), CF));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists the IP and location of each session", async () => {
    const owner = await setupOwner();
    const address = publicIp();
    const { client } = await login(owner.authenticator, clientFrom(address, CF));
    const list = await client.json("GET", "/api/auth/sessions");
    expect(list.sessions).toContainEqual(
      expect.objectContaining({
        ip: address,
        country: "JP",
        region: "Tokyo",
        city: "Chiyoda",
        organization: "Example AS",
        geoSource: "cf",
        current: true,
      }),
    );
  });

  it("ignores a cf-connecting-ip that is not an IP address", async () => {
    const owner = await setupOwner();
    await login(owner.authenticator, clientFrom("not-an-ip"));
    expect(await newestSession()).toMatchObject({ ip: null, geoSource: null });
  });
});
