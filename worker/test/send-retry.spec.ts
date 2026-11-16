import { describe, expect, it, vi } from "vitest";
import {
  resendError,
  resendOk,
  sendBody,
  sender,
  signedIn,
  stubResend,
  upload,
} from "./send-helpers";

// Retries and idempotency against Resend (owner rulings of 2026-11-16 on the M5 review): a retry
// sends a byte-identical request, Resend's idempotency conflicts never land as a retryable
// failure, and a final rejection lets the corrected message go out under a new key.

type Client = Awaited<ReturnType<typeof signedIn>>;
const send = (client: Client, body: unknown) => client.request("POST", "/api/messages/send", body);

async function uploaded(client: Client): Promise<string> {
  const res = await upload(client, "attachment bytes");
  return ((await res.json()) as { upload: { id: string } }).upload.id;
}

describe("retrying a send", () => {
  it("signs attachment URLs for 24 hours from the stored copy, so a retry is identical", async () => {
    const client = await signedIn();
    const from = await sender();
    const fileId = await uploaded(client);
    const calls = stubResend((n) => (n === 0 ? resendError(500, "application_error") : resendOk()));
    const body = sendBody(from, { uploadIds: [fileId] });
    const before = Math.floor(Date.now() / 1000);
    expect((await send(client, body)).status).toBe(502);

    // The retry runs ten minutes later; the signed URLs must not change with it.
    const later = Date.now() + 10 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    expect((await send(client, body)).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.body)).toBe(JSON.stringify(calls[0]?.body));

    const [attachment] = (calls[0]?.body.attachments ?? []) as { path: string }[];
    const exp = Number(new URL(attachment?.path ?? "").searchParams.get("exp"));
    expect(exp - before).toBeGreaterThanOrEqual(24 * 3600);
    expect(exp - before).toBeLessThanOrEqual(24 * 3600 + 5);
  });
});
