import { describe, expect, it, vi } from "vitest";
import { handleEmail } from "../src/index";

function inbound(to: string) {
  return {
    from: "sender@example.org",
    to,
    headers: new Headers(),
    raw: new ReadableStream(),
    rawSize: 0,
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage;
}

describe("inbound email", () => {
  it("rejects an address that was not added in the panel", async () => {
    const message = inbound("anyone@example.com");
    await handleEmail(message);
    expect(message.setReject).toHaveBeenCalledWith("Address not found");
    expect(message.forward).not.toHaveBeenCalled();
  });
});
