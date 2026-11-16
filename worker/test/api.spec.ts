import { env, exports } from "cloudflare:workers";
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

  it("points every upstream at an unresolvable host and a fake key in tests", () => {
    for (const url of [env.RESEND_API_URL, env.DOH_URL]) {
      expect(new URL(url).hostname).toMatch(/\.invalid$/);
    }
    // wrangler also loads worker/.dev.vars, which may hold the owner's real key; the test
    // binding must win. Compared as a boolean so that a failure never prints the key.
    expect(env.RESEND_API_KEY === "re_test_not_a_real_key").toBe(true);
  });
});
