import { describe, expect, test } from "bun:test";
import { clickTarget, messageUrl, notificationFor } from "../src/pwa/notification";

// The push and click handlers as functions (docs/M4b-pwa.md, "Proof the change needs"): a real
// push cannot be delivered in a test, so the service worker's logic is checked here.

const COPY = { newMail: "New mail", noSubject: "(no subject)", testBody: "It works." };

describe("notification for a push", () => {
  test("shows the sender as title, subject and address as body, tagged by message", () => {
    const n = notificationFor(
      { type: "message", id: "a/b", from: "Alice", subject: "Lunch?", to: "shop@example.com" },
      COPY,
      "MelodyMail",
    );
    expect(n.title).toBe("Alice");
    expect(n.options.body).toBe("Lunch?\nshop@example.com");
    expect(n.options.tag).toBe("message:a/b");
    expect(n.options.data).toEqual({ url: "/?m=a%2Fb" });
  });

  test("falls back to the localized copy for a missing sender or subject", () => {
    const n = notificationFor(
      { type: "message", id: "m1", from: " ", subject: null, to: "" },
      COPY,
      "MelodyMail",
    );
    expect(n.title).toBe("New mail");
    expect(n.options.body).toBe("(no subject)");
  });

  test("shows the test message under the app name", () => {
    const n = notificationFor({ type: "test" }, COPY, "MelodyMail");
    expect(n.title).toBe("MelodyMail");
    expect(n.options.body).toBe("It works.");
    expect(n.options.data).toEqual({ url: "/" });
  });

  test("shows a plain New mail for anything else", () => {
    for (const data of [null, "text", { type: "message" }, { type: "other", id: "x" }]) {
      const n = notificationFor(data, COPY, "MelodyMail");
      expect(n.title).toBe("New mail");
      expect(n.options.data).toEqual({ url: "/" });
    }
  });
});

describe("notification click", () => {
  test("opens the message inside the app", () => {
    expect(clickTarget({ url: messageUrl("m1") })).toBe("/?m=m1");
  });

  test("never leaves the app's origin", () => {
    for (const url of ["https://evil.example/", "//evil.example/x", "javascript:alert(1)", 7]) {
      expect(clickTarget({ url })).toBe("/");
    }
    expect(clickTarget(null)).toBe("/");
    expect(clickTarget(undefined)).toBe("/");
  });
});
