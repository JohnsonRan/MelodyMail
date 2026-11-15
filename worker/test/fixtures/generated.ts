// Messages generated in memory, shared by the worker tests and bench/parse.ts. Nothing here
// imports from the test runtime.

const encoder = new TextEncoder();

/** Every fixture, also read by bench/parse.ts; test/parse.spec.ts checks it against the files. */
export const FIXTURE_NAMES = [
  "alternative",
  "base64",
  "big5",
  "euc-jp",
  "gb18030",
  "gbk",
  "header-only",
  "html-only",
  "iso-2022-jp",
  "malformed-boundary",
  "mixed-attachment",
  "no-subject",
  "plain",
  "quoted-printable",
  "shift-jis",
] as const;

/**
 * A message of about `size` bytes whose bulk is one base64 attachment, generated in memory so
 * the repository holds no large file. Email Routing refuses messages over 25 MiB, so the
 * largest reachable message is about 25 MiB raw; 20 MiB stays under it.
 */
export function largeMessage(size = 20 * 1024 * 1024): Uint8Array {
  const head = encoder.encode(
    [
      "From: Big Sender <big@example.org>",
      "To: shop@example.com",
      "Subject: Large attachment",
      "Message-ID: <large@example.org>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="big"',
      "",
      "--big",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "The archive is attached.",
      "--big",
      'Content-Type: application/zip; name="archive.zip"',
      'Content-Disposition: attachment; filename="archive.zip"',
      "Content-Transfer-Encoding: base64",
      "",
      "",
    ].join("\r\n"),
  );
  const tail = encoder.encode("--big--\r\n");
  const line = encoder.encode(`${"QUJDRA".repeat(12)}QUJD\r\n`);
  const lines = Math.floor((size - head.length - tail.length) / line.length);
  const out = new Uint8Array(head.length + lines * line.length + tail.length);
  out.set(head);
  for (let i = 0; i < lines; i++) out.set(line, head.length + i * line.length);
  out.set(tail, head.length + lines * line.length);
  return out;
}

/** `depth` multiparts nested inside each other (over the parser's nesting limit at 40). */
export function deeplyNested(depth: number): string {
  let raw = "Content-Type: text/plain\r\n\r\nleaf\r\n";
  for (let i = 0; i < depth; i++) {
    raw = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${raw}--b${i}--\r\n`;
  }
  return `Subject: Deep\r\n${raw}`;
}

/**
 * An attachment of `lines` base64 lines (78 bytes each) before the text part; with the default
 * the text starts just after the first 64 KB, outside the parsed slice.
 */
export function attachmentFirst(lines = 1000): Uint8Array {
  const body = `${"QUJDRA".repeat(12)}QUJD\r\n`.repeat(lines);
  return encoder.encode(
    [
      "From: Sender Name <sender@example.org>",
      "Subject: Attachment first",
      'Content-Type: multipart/mixed; boundary="af"',
      "",
      "--af",
      'Content-Type: image/png; name="scan.png"',
      "Content-Transfer-Encoding: base64",
      "",
      `${body}--af`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "The text after the attachment.",
      "--af--",
      "",
    ].join("\r\n"),
  );
}

/**
 * HTML bodies built to make a backtracking tag-stripping regex quadratic, each about 250 KB, with
 * the text htmlToText must still give back.
 */
export function adversarialHtml(): [name: string, message: Uint8Array, text: string][] {
  const size = 250 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const cases: [string, string, string][] = [
    ["'<' repeated, no '>'", `<p>lead</p>${fill("<")}`, "lead"],
    ["'<head' repeated", `<p>lead</p>${fill("<head")}`, "lead"],
    ["'<script ' repeated, never closed", `<p>lead</p>${fill("<script ")}`, "lead"],
    ["'<!--' repeated, no '-->'", `<p>lead</p>${fill("<!--")}`, "lead"],
    ["attribute without '>'", `<p>lead</p><a href="${fill("x")}`, "lead"],
    ["'&amp' repeated, no ';'", fill("&amp"), fill("&amp").slice(0, 8 * 1024)],
  ];
  return cases.map(([name, body, text]) => [
    name,
    encoder.encode(
      `From: Sender <sender@example.org>\r\nSubject: Adversarial\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}\r\n`,
    ),
    text,
  ]);
}

/**
 * MIME shapes that make postal-mime work hard (review of 2c9e9c4, item 2), each built to about
 * 256 KB; the parse sees only the first 64 KB.
 */
export function craftedMessages(): [name: string, message: Uint8Array][] {
  const size = 256 * 1024;
  const h = "From: a@example.org\r\nTo: shop@example.com\r\nMIME-Version: 1.0\r\n";
  const mixed = `${h}Subject: parts\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n`;
  const tiny = "--b\r\nContent-Type: text/plain\r\n\r\nx\r\n";
  const image = `--b\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n\r\n${"QUJDRA".repeat(80)}\r\n`;
  const folded = (unit: string) =>
    Array.from({ length: Math.ceil(size / (unit.length + 3)) }, () => unit).join("\r\n ");
  const xHeaders = Array.from({ length: 5000 }, (_, i) => `X-H${i}: ${"v".repeat(40)}`);
  const cases: [string, string][] = [
    ["499 parts of 1 byte", `${mixed}${tiny.repeat(499)}--b--\r\n`],
    ["5000 parts of 1 byte", `${mixed}${tiny.repeat(5000)}--b--\r\n`],
    ["499 base64 parts of 500 bytes, no text", `${mixed}${image.repeat(499)}--b--\r\n`],
    ["nesting depth 31", deeplyNested(31)],
    ["nesting depth 2000", deeplyNested(2000)],
    ["one 256 KB folded Subject", `${h}Subject: ${folded("a".repeat(70))}\r\n\r\nbody\r\n`],
    ["5000 X- headers", `${h}${xHeaders.join("\r\n")}\r\nSubject: s\r\n\r\nbody\r\n`],
    [
      "Subject of B encoded words",
      `${h}Subject: ${folded("=?UTF-8?B?5L2g5aW95LiW55WM?=")}\r\n\r\nb\r\n`,
    ],
    [
      "Subject of Q encoded words (GBK)",
      `${h}Subject: ${folded("=?GBK?Q?=C4=E3=BA=C3?=")}\r\n\r\nb\r\n`,
    ],
    [
      "boundary never closed, text part",
      `${mixed}--b\r\nContent-Type: text/plain\r\n\r\n${"line of text\r\n".repeat(20000)}`,
    ],
    [
      "boundary never closed, base64 part, no text",
      `${mixed}--b\r\nContent-Type: application/zip\r\nContent-Transfer-Encoding: base64\r\n\r\n${`${"QUJDRA".repeat(12)}QUJD\r\n`.repeat(4000)}`,
    ],
    [
      "one 256 KB line without CRLF",
      `${h}Subject: line\r\nContent-Type: text/plain\r\n\r\n${"x".repeat(size)}`,
    ],
    [
      "256 KB of bare CR",
      `${h}Subject: cr\r\nContent-Type: text/plain\r\n\r\n${"\r".repeat(size)}`,
    ],
  ];
  return cases.map(([name, raw]) => [name, encoder.encode(raw).subarray(0, size)]);
}
