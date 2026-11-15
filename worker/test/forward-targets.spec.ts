import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type Client, setupOwner } from "./helpers";

type Json = Record<string, unknown>;

async function owner(): Promise<Client> {
  return (await setupOwner()).client;
}

describe("forwarding targets", () => {
  it("adds a target in lowercase with a note and lists its use", async () => {
    const client = await owner();
    const res = await client.json(
      "POST",
      "/api/forward-targets",
      { email: " Me@Out.TEST ", note: "phone" },
      201,
    );
    expect(res.target).toMatchObject({ email: "me@out.test", note: "phone", addressCount: 0 });
    const list = (await client.json("GET", "/api/forward-targets")).targets as Json[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ email: "me@out.test", addressCount: 0 });
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_log WHERE event = 'forward_target_added'",
    ).first("detail");
    expect(audit).toBe("me@out.test");
  });

  it("refuses a duplicate in any case and a malformed address", async () => {
    const client = await owner();
    await client.json("POST", "/api/forward-targets", { email: "me@out.test" }, 201);
    expect(
      await client.json("POST", "/api/forward-targets", { email: "ME@out.test" }, 409),
    ).toEqual({ error: "target_exists" });
    for (const email of [
      "",
      "me",
      "@out.test",
      "me@",
      "me@out",
      "m e@out.test",
      "<me>@out.test",
      1,
    ]) {
      expect(
        await client.json("POST", "/api/forward-targets", { email }, 400),
        String(email),
      ).toEqual({ error: "invalid_email" });
    }
    expect(
      await client.json(
        "POST",
        "/api/forward-targets",
        { email: "x@out.test", note: "n".repeat(201) },
        400,
      ),
    ).toEqual({ error: "invalid_note" });
  });

  it("refuses to remove a target in use, then detaches it when asked", async () => {
    const client = await owner();
    await client.json("POST", "/api/domains", { name: "example.com" }, 201);
    const target = (
      await client.json("POST", "/api/forward-targets", { email: "me@out.test" }, 201)
    ).target as { id: number };
    const created = await client.json(
      "POST",
      "/api/addresses",
      { localPart: "shop", domain: "example.com", targetIds: [target.id] },
      201,
    );
    const list = (await client.json("GET", "/api/forward-targets")).targets as Json[];
    expect(list[0]?.addressCount).toBe(1);

    const path = `/api/forward-targets/${target.id}`;
    expect(await client.json("DELETE", path, undefined, 409)).toEqual({ error: "target_in_use" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM address_forwards").first("n")).toBe(1);

    expect(await client.json("DELETE", `${path}?detach=1`)).toEqual({ ok: true });
    const address = (await client.json("GET", "/api/addresses")).addresses as Json[];
    expect(address[0]).toMatchObject({
      id: (created.address as Json).id,
      targetIds: [],
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM forward_targets").first("n")).toBe(0);
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_log WHERE event = 'forward_target_removed'",
    ).first("detail");
    expect(audit).toBe("me@out.test");
  });

  it("switches a forward-only address that loses its last target to store and forward", async () => {
    const client = await owner();
    await client.json("POST", "/api/domains", { name: "example.com" }, 201);
    const add = async (email: string) =>
      ((await client.json("POST", "/api/forward-targets", { email }, 201)).target as { id: number })
        .id;
    const only = await add("only@out.test");
    const other = await add("other@out.test");
    const post = (localPart: string, targetIds: number[]) =>
      client.json(
        "POST",
        "/api/addresses",
        { localPart, domain: "example.com", forwardOnly: true, targetIds },
        201,
      );
    await post("solo", [only]);
    await post("pair", [only, other]);
    await client.json("DELETE", `/api/forward-targets/${only}?detach=1`);
    const list = (await client.json("GET", "/api/addresses")).addresses as Json[];
    expect(list.find((x) => x.localPart === "solo")).toMatchObject({
      enabled: true,
      forwardOnly: false,
      targetIds: [],
    });
    expect(list.find((x) => x.localPart === "pair")).toMatchObject({
      enabled: true,
      forwardOnly: true,
      targetIds: [other],
    });
  });

  it("lets a forward-only address without targets from before the ruling be edited", async () => {
    const client = await owner();
    await client.json("POST", "/api/domains", { name: "example.com" }, 201);
    // A row that only an earlier build could write: forward-only with no target.
    const id = await env.DB.prepare(
      "INSERT INTO addresses (local_part, domain, forward_only, created_at) VALUES ('shop', 'example.com', 1, ?) RETURNING id",
    )
      .bind(Date.now())
      .first<number>("id");
    const path = `/api/addresses/${id}`;
    // Any edit leaves it as store and forward, and forward-only cannot come back without a target.
    const off = await client.json("PATCH", path, { enabled: false });
    expect(off.address).toMatchObject({ enabled: false, forwardOnly: false, targetIds: [] });
    expect(await client.json("PATCH", path, { forwardOnly: true }, 400)).toEqual({
      error: "forward_only_needs_target",
    });
  });

  it("ends a create racing a detach in a state some serial order gives", async () => {
    const client = await owner();
    await client.json("POST", "/api/domains", { name: "example.com" }, 201);
    for (let i = 0; i < 20; i++) {
      const target = (
        await client.json("POST", "/api/forward-targets", { email: `t${i}@out.test` }, 201)
      ).target as { id: number };
      const [created, removed] = await Promise.all([
        client.request("POST", "/api/addresses", {
          localPart: `a${i}`,
          domain: "example.com",
          forwardOnly: true,
          targetIds: [target.id],
        }),
        client.request("DELETE", `/api/forward-targets/${target.id}?detach=1`),
      ]);
      expect(removed.status).toBe(200);
      const links = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM address_forwards WHERE target_id = ?",
      )
        .bind(target.id)
        .first("n");
      expect(links).toBe(0);
      // Create first, then detach: the address exists and is back to store and forward. Detach
      // first: the create is refused. Never a forward-only address without a target.
      if (created.status === 201) {
        const body = (await created.json()) as { address: { id: number } };
        const row = await env.DB.prepare("SELECT forward_only AS f FROM addresses WHERE id = ?")
          .bind(body.address.id)
          .first("f");
        expect(row).toBe(0);
      } else {
        expect(created.status).toBe(400);
        expect(await created.json()).toEqual({ error: "unknown_target" });
      }
    }
  });

  it("removes an unused target and answers 404 for an unknown one", async () => {
    const client = await owner();
    const target = (
      await client.json("POST", "/api/forward-targets", { email: "me@out.test" }, 201)
    ).target as { id: number };
    expect(
      await client.json("DELETE", `/api/forward-targets/${target.id}.0`, undefined, 404),
    ).toEqual({ error: "not_found" });
    expect(await client.json("DELETE", `/api/forward-targets/${target.id}`)).toEqual({ ok: true });
    expect(
      await client.json("DELETE", `/api/forward-targets/${target.id}`, undefined, 404),
    ).toEqual({ error: "not_found" });
    expect(await client.json("DELETE", "/api/forward-targets/zero", undefined, 404)).toEqual({
      error: "not_found",
    });
  });
});
