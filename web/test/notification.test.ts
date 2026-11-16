import { describe, expect, test } from "bun:test";
import { clickTarget, messageUrl, notificationFor } from "../src/pwa/notification";

// The push and click handlers as functions (docs/M4b-pwa.md, "Proof the change needs"): a real
// push cannot be delivered in a test, so the service worker's logic is checked here.

const ORIGIN = "https://mail.test";
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
    expect(clickTarget({ url: messageUrl("m1") }, ORIGIN)).toBe(`${ORIGIN}/?m=m1`);
  });

  test("never leaves the app's origin", () => {
    const escapes = [
      "https://evil.example/",
      "//evil.example/x",
      "/\t/evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      7,
    ];
    for (const url of escapes) expect(clickTarget({ url }, ORIGIN), String(url)).toBe(`${ORIGIN}/`);
    expect(clickTarget(null, ORIGIN)).toBe(`${ORIGIN}/`);
    expect(clickTarget(undefined, ORIGIN)).toBe(`${ORIGIN}/`);
    // Paths that normalize to "//host" stay absolute on the origin, so the window cannot
    // resolve them a second time against another host.
    for (const url of ["/.//evil.example", `${ORIGIN}//evil.example/x`]) {
      const target = clickTarget({ url }, ORIGIN);
      expect(new URL(target, "https://other.example").origin, url).toBe(ORIGIN);
    }
  });
});
