import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { ORIGIN, setupOwner, totpCode } from "./helpers";

describe("API errors and audit", () => {
  it("answers 400 bad_request to a body that is not a JSON object", async () => {
    for (const body of ["not json", "[1]"]) {
      const res = await exports.default.fetch(`${ORIGIN}/api/auth/recover`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body,
      });
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
  });

  it("answers 500 internal without detail when a handler throws", async () => {
    const res = await app.fetch(new Request(`${ORIGIN}/api/auth/state`), {
      ...env,
      DB: undefined as unknown as D1Database,
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
  });

  it("records sign-in events in the audit log and never a secret", async () => {
    const owner = await setupOwner();
    await owner.client.request("POST", "/api/auth/recover", {
      recoveryKey: owner.recoveryKey,
      totpCode: await totpCode(owner.totpSecret, 1),
    });
    const { results } = await env.DB.prepare(
      "SELECT event, ip, user_agent AS userAgent FROM audit_log ORDER BY id",
    ).all<{ event: string; ip: string; userAgent: string }>();
    expect(results.map((r) => r.event)).toEqual(["setup", "recover"]);
    expect(results[0]?.ip).toBe(owner.client.ip);
    const dump = JSON.stringify(results);
    const token = owner.client.cookies.get("mm_session") ?? "";
    for (const secret of [owner.recoveryKey, owner.totpSecret, token]) {
      expect(dump).not.toContain(secret);
    }
  });
});
