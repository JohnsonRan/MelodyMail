import { describe, expect, test } from "bun:test";
import { prefill, prefixedSubject, quoted } from "../src/compose/quote";
import type { ParsedMail } from "../src/reader/types";

// What a reply, reply all or forward starts with (docs/M5-sending.md, "Screens").

const mail = (over: Partial<ParsedMail> = {}): ParsedMail => ({
  from: [{ name: "Ann", address: "ann@example.org" }],
  to: [
    { name: "", address: "me@example.com" },
    { name: "", address: "bob@example.org" },
  ],
  cc: [
    { name: "", address: "carol@example.org" },
    { name: "", address: "ME@example.com" },
  ],
  subject: "Plans",
  date: null,
  text: "Line one\n\nLine two",
  html: null,
  parts: [],
  ...over,
});

const base = {
  from: "Ann <ann@example.org>",
  subject: "Plans",
  own: ["me@example.com"],
  header: "Ann wrote:",
};

describe("compose prefill", () => {
  test("prefixes the subject once", () => {
    expect(prefixedSubject("Plans", "reply")).toBe("Re: Plans");
    expect(prefixedSubject("RE: Plans", "replyAll")).toBe("RE: Plans");
    expect(prefixedSubject("Plans", "forward")).toBe("Fwd: Plans");
    expect(prefixedSubject("Fw: Plans", "forward")).toBe("Fw: Plans");
  });

  test("quotes every line as a Markdown blockquote", () => {
    expect(quoted("a\r\n\r\nb\n")).toBe("> a\n>\n> b");
  });

  test("reply all leaves the owner's own addresses out", () => {
    const p = prefill({ ...base, kind: "replyAll", mail: mail() });
    expect(p.to).toEqual(["ann@example.org", "bob@example.org"]);
    expect(p.cc).toEqual(["carol@example.org"]);
    expect(p.text).toBe("\n\nAnn wrote:\n\n> Line one\n>\n> Line two\n");
  });

  test("a reply to one's own sent message goes to its recipients", () => {
    const own = mail({
      from: [{ name: "Me", address: "me@example.com" }],
      to: [{ name: "", address: "bob@example.org" }],
    });
    expect(prefill({ ...base, kind: "reply", mail: own }).to).toEqual(["bob@example.org"]);
    expect(prefill({ ...base, kind: "reply", mail: mail() }).to).toEqual(["ann@example.org"]);
  });

  test("a forward starts with no recipients", () => {
    const p = prefill({ ...base, kind: "forward", mail: mail() });
    expect(p).toMatchObject({ to: [], cc: [], subject: "Fwd: Plans" });
  });
});
