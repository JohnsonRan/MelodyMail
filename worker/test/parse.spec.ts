import PostalMime from "postal-mime";
import { describe, expect, it, vi } from "vitest";
import {
  FIRST_PASS_BYTES,
  type ParsedHeaders,
  parseSlice,
  SLICE_BYTES,
  threadKey,
} from "../src/mail/parse";
import { fixture, fixtureNames } from "./fixtures";
import { attachmentFirst, deeplyNested, FIXTURE_NAMES, largeMessage } from "./fixtures/generated";

// Expected subject, the start of the search text, and the attachment flag for each fixture.
const CASES: [string, string | null, string, boolean][] = [
  ["plain", "Plain text message", "Hello from the plain fixture. Second line.", false],
  ["html-only", "HTML only", "Fish & chips ☺ for lunch", false],
  ["alternative", "Alternative parts", "Plain side of the alternative.", false],
  ["mixed-attachment", "With attachment", "See the attached report.", true],
  ["gbk", "测试主题", "你好，这是一封测试邮件。", false],
  ["gb18030", "测试主题", "你好，这是一封测试邮件。𠀀", false],
  ["big5", "測試主旨", "你好，這是一封測試郵件。", false],
  ["iso-2022-jp", "テスト件名", "こんにちは、これはテストメールです。", false],
  ["shift-jis", "テスト件名", "こんにちは、これはテストメールです。", false],
  ["euc-jp", "テスト件名", "こんにちは、これはテストメールです。", false],
  ["quoted-printable", "中文主题", "Café au lait, softbreak joined.", false],
  ["base64", "日本語の件名", "Base64 body: こんにちは、これはテストメールです。", false],
  ["no-subject", null, "A message without a subject.", false],
  // The stray boundary stays in the text; the parse must not fail.
  ["malformed-boundary", "Malformed boundaries", "First part before a broken boundary.", true],
  ["header-only", "Header only", "", false],
];

const encode = (s: string) => new TextEncoder().encode(s);

describe("bounded parse in workerd", () => {
  it("covers every committed fixture", () => {
    expect(fixtureNames()).toEqual([...FIXTURE_NAMES].sort());
    expect(CASES.map(([name]) => name).sort()).toEqual([...FIXTURE_NAMES].sort());
  });

  it.each(CASES)("%s", async (name, subject, text, attachments) => {
    const p = await parseSlice(encode(fixture(name)));
    expect(p).toMatchObject({
      subject,
      from: "Sender Name <sender@example.org>",
      to: "shop@example.com",
      messageId: `<${name}@example.org>`,
      date: "2026-11-16T08:00:00.000Z",
      hasAttachments: attachments,
    });
    expect(p.text.startsWith(text)).toBe(true);
    expect(p.snippet).toBe(p.text.slice(0, 200));
  });

  it("reads References, In-Reply-To and Cc", async () => {
    const plain = await parseSlice(encode(fixture("plain")));
    expect(plain.references).toBe("<root@example.org> <parent@example.org>");
    expect(plain.inReplyTo).toBe("<parent@example.org>");
    expect((await parseSlice(encode(fixture("mixed-attachment")))).cc).toBe(
      "Copy <copy@example.net>",
    );
  });

  it("parses a slice cut in the middle of an attachment", async () => {
    const slice = largeMessage(SLICE_BYTES * 2).subarray(0, SLICE_BYTES - 7);
    const parsed = await parseSlice(slice);
    expect(parsed.subject).toBe("Large attachment");
    expect(parsed.hasAttachments).toBe(true);
    expect(parsed.text).toBe("The archive is attached.");
  });

  it("stops after the first 64 KB when they hold a text part", async () => {
    const parse = vi.spyOn(PostalMime, "parse");
    await parseSlice(largeMessage(SLICE_BYTES * 2).subarray(0, SLICE_BYTES));
    expect(parse).toHaveBeenCalledOnce();
    expect(parse.mock.calls[0]?.[0]).toHaveLength(FIRST_PASS_BYTES);
  });

  it("parses the whole slice when the first 64 KB hold no text part", async () => {
    const parse = vi.spyOn(PostalMime, "parse");
    const parsed = await parseSlice(attachmentFirst());
    expect(parse).toHaveBeenCalledTimes(2);
    expect(parsed.text).toBe("The text after the attachment.");
    expect(parsed.hasAttachments).toBe(true);
  });

  it("parses no more than the first 256 KB", async () => {
    const tail = "Subject: Hidden\r\n";
    const raw = encode(`Subject: Seen\r\n\r\n${"x".repeat(SLICE_BYTES)}\r\n${tail}`);
    const parsed = await parseSlice(raw);
    expect(parsed.text.length).toBe(8 * 1024);
    expect(parsed.text).not.toContain("Hidden");
  });

  it("caps the search text at 8 KB and the snippet at 200 characters", async () => {
    const parsed = await parseSlice(encode(`Subject: Long\r\n\r\n${"word ".repeat(5000)}`));
    expect(parsed.text.length).toBe(8 * 1024);
    expect(parsed.snippet.length).toBe(200);
  });

  it("rejects a message nested deeper than the limit", async () => {
    await expect(parseSlice(encode(deeplyNested(40)))).rejects.toThrow();
  });
});

describe("thread key", () => {
  const base = { references: null, inReplyTo: null, messageId: null } as unknown as ParsedHeaders;
  it("prefers References, then In-Reply-To, then Message-ID, then the stored id", () => {
    expect(threadKey({ ...base, references: "<a@x> <b@x>", inReplyTo: "<b@x>" }, "id")).toBe(
      "<a@x>",
    );
    expect(threadKey({ ...base, inReplyTo: "<b@x>", messageId: "<c@x>" }, "id")).toBe("<b@x>");
    expect(threadKey({ ...base, messageId: "<c@x>" }, "id")).toBe("<c@x>");
    expect(threadKey(base, "id")).toBe("id");
  });
});
