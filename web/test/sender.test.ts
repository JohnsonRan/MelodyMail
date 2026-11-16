import { describe, expect, test } from "bun:test";
import { senderAddress, senderName } from "../src/mailbox/api";

// The reader's thread line shows a From header's display name with its address beside it.
describe("sender display", () => {
  test("splits a From header into name and address, with trailing whitespace", () => {
    expect(senderName("Ann Lee <ann@example.org>")).toBe("Ann Lee");
    expect(senderAddress("Ann Lee <ann@example.org>")).toBe("ann@example.org");
    expect(senderAddress('"Ann" <ann@example.org>  \t')).toBe("ann@example.org");
    expect(senderName('"Ann" <ann@example.org>  \t')).toBe("Ann");
  });

  test("uses the address alone when there is no display name", () => {
    expect(senderAddress("ann@example.org")).toBe("ann@example.org");
    expect(senderName("<ann@example.org>")).toBe("ann@example.org");
  });
});
