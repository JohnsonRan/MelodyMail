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

  it("lets a forward-only address left without targets be edited", async () => {
    const client = await owner();
    await client.json("POST", "/api/domains", { name: "example.com" }, 201);
    const target = (
      await client.json("POST", "/api/forward-targets", { email: "me@out.test" }, 201)
    ).target as { id: number };
    const created = await client.json(
      "POST",
      "/api/addresses",
      { localPart: "shop", domain: "example.com", forwardOnly: true, targetIds: [target.id] },
      201,
    );
    const path = `/api/addresses/${(created.address as { id: number }).id}`;
    await client.json("DELETE", `/api/forward-targets/${target.id}?detach=1`);
    const off = await client.json("PATCH", path, { enabled: false });
    expect(off.address).toMatchObject({ enabled: false, forwardOnly: true, targetIds: [] });
    // Turning forward-only on again, or keeping it with an empty target list, is still refused.
    expect(await client.json("PATCH", path, { targetIds: [] }, 400)).toEqual({
      error: "forward_only_needs_target",
    });
    const fixed = await client.json("PATCH", path, { forwardOnly: false });
    expect(fixed.address).toMatchObject({ forwardOnly: false, targetIds: [] });
    expect(await client.json("PATCH", path, { forwardOnly: true }, 400)).toEqual({
      error: "forward_only_needs_target",
    });
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
