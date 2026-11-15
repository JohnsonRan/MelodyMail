import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("api", () => {
  it("answers the health check", async () => {
    const res = await exports.default.fetch("http://mail.test/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns JSON 404 for an unknown API route instead of the SPA", async () => {
    const res = await exports.default.fetch("http://mail.test/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
