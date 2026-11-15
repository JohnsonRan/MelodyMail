import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, SETUP_TOKEN, SoftAuthenticator, setupOwner, totpCode } from "./helpers";

function captureLogs(): string[] {
  const lines: string[] = [];
  for (const level of ["debug", "info", "warn", "error", "log"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return lines;
}

describe("logging", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not log the challenge when an assertion is rejected", async () => {
    const { authenticator } = await setupOwner();
    const lines = captureLogs();
    const client = new Client();
    const start = await client.json("POST", "/api/auth/login/options", {});
    const options = start.options as { challenge: string };
    const credential = await authenticator.authenticate(options, "mail.test", "https://evil.test");
    await client.json("POST", "/api/auth/login/verify", { credential }, 401);
    const logged = lines.join("\n");
    expect(logged).toContain("webauthn_authentication_rejected");
    expect(logged).not.toContain(options.challenge);
    expect(logged).not.toContain("evil.test");
  });

  it("does not log the challenge when a registration is rejected", async () => {
    const lines = captureLogs();
    const client = new Client();
    const authenticator = await SoftAuthenticator.create();
    const start = await client.json("POST", "/api/auth/setup/options", { setupToken: SETUP_TOKEN });
    const stored = await env.DB.prepare("SELECT challenge FROM auth_challenges").first<string>(
      "challenge",
    );
    const options = { ...(start.options as object), challenge: "d3JvbmctY2hhbGxlbmdl" };
    const body = {
      setupToken: SETUP_TOKEN,
      credential: await authenticator.register(options),
      totpCode: await totpCode((start.totp as { secret: string }).secret),
    };
    await client.json("POST", "/api/auth/setup/verify", body, 401);
    expect(lines.join("\n")).toContain("webauthn_registration_rejected");
    expect(lines.join("\n")).not.toContain(stored);
    expect(lines.join("\n")).not.toContain("d3JvbmctY2hhbGxlbmdl");
  });
});
